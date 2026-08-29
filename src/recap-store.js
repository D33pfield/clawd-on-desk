"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCHEMA_VERSION = 1;
const DEFAULT_ROOT = path.join(os.homedir(), ".clawd", "recap-v1");
const EVENT_RETENTION_DAYS = 14;
const DAILY_RETENTION_DAYS = 400;

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.parse(root).root === path.resolve(root)) {
    throw new TypeError("recap root must be a non-root absolute path");
  }
  return path.resolve(root);
}

function childPath(root, ...segments) {
  const base = assertRoot(root);
  const resolved = path.resolve(base, ...segments);
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("recap path escaped its root");
  }
  return resolved;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function writeJsonAtomic(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function validMeta(value) {
  return !!(
    value
    && value.schemaVersion === SCHEMA_VERSION
    && typeof value.hmacSalt === "string"
    && /^[A-Za-z0-9_-]{40,64}$/.test(value.hmacSalt)
  );
}

function createMeta(now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    hmacSalt: crypto.randomBytes(32).toString("base64url"),
    retention: {
      eventDays: EVENT_RETENTION_DAYS,
      dailyDays: DAILY_RETENTION_DAYS,
    },
  };
}

function createRecapStore(options = {}) {
  const root = assertRoot(options.root || DEFAULT_ROOT);
  const logWarn = options.logWarn || console.warn;
  let meta = null;

  function warn(message, err) {
    try {
      const detail = err && err.message ? err.message : err;
      if (detail === undefined) logWarn(message);
      else logWarn(message, detail);
    } catch {}
  }

  function initialize() {
    ensureDirectory(root);
    ensureDirectory(childPath(root, "events"));
    const metaPath = childPath(root, "meta.json");
    let existing = null;
    let metaMissing = false;
    try {
      existing = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch (err) {
      if (err && err.code === "ENOENT") metaMissing = true;
      else if (err instanceof SyntaxError || (err && ["EISDIR", "EINVAL"].includes(err.code))) {
        throw new Error("recap identity metadata is invalid; clear recap data to reset it");
      } else {
        // An unreadable salt is not the same as a missing one. Replacing it
        // could silently split old identities, so fail closed instead.
        throw err;
      }
    }
    if (validMeta(existing)) {
      meta = existing;
    } else {
      let eventNames = [];
      let rootNames = [];
      try { eventNames = fs.readdirSync(childPath(root, "events")); }
      catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
      try { rootNames = fs.readdirSync(root); } catch (err) { throw err; }
      const hasOldData = eventNames.length > 0 || rootNames.some((name) =>
        /^daily-\d{4}-\d{2}\.json$/.test(name)
        || /^coverage-\d{4}-\d{2}\.json$/.test(name)
        || name === "coverage-open.json");
      // The salt is the identity authority. Without it, old HMAC rows cannot
      // be compared with a new generation. Preserve the old files and stop
      // recording until the user explicitly clears them; never mix salts.
      if (!metaMissing || hasOldData) {
        throw new Error("recap identity metadata is unavailable; clear recap data to reset it");
      }
      meta = createMeta(options.now ? options.now() : Date.now());
      writeJsonAtomic(metaPath, meta);
    }
    return { ...meta, retention: { ...meta.retention } };
  }

  function getMeta() {
    if (!meta) initialize();
    return { ...meta, retention: { ...meta.retention } };
  }

  function hmac(namespace, ...values) {
    if (!meta) initialize();
    const digest = crypto.createHmac("sha256", Buffer.from(meta.hmacSalt, "base64url"));
    digest.update(String(namespace));
    for (const value of values) {
      digest.update("\0");
      digest.update(String(value || ""));
    }
    return `hmac:${digest.digest("base64url")}`;
  }

  function quarantine(filePath, label = "invalid") {
    const base = assertRoot(root);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error("recap quarantine source escaped its root");
    }
    const quarantineDir = childPath(root, "quarantine");
    ensureDirectory(quarantineDir);
    const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, "-").slice(0, 32) || "invalid";
    const destination = childPath(
      root,
      "quarantine",
      `${path.basename(resolved)}.${safeLabel}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`
    );
    fs.renameSync(resolved, destination);
    return destination;
  }

  function clear() {
    // Never recursively delete the configured root itself. Each known child is
    // resolved through childPath, so a malformed option cannot widen deletion.
    for (const name of ["events", "quarantine"]) {
      const dirPath = childPath(root, name);
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
    let rootNames = [];
    try { rootNames = fs.readdirSync(root); } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    for (const name of rootNames) {
      if (
        /^daily-\d{4}-\d{2}\.json$/.test(name)
        || /^coverage-\d{4}-\d{2}\.json$/.test(name)
        || name === "coverage-open.json"
        || /^\.(?:meta\.json|daily-\d{4}-\d{2}\.json|coverage-(?:\d{4}-\d{2}|open)\.json)\.\d+\.[a-f0-9]{12}\.tmp$/.test(name)
      ) {
        try { fs.rmSync(childPath(root, name), { recursive: true, force: true }); } catch (err) {
          if (!err || err.code !== "ENOENT") throw err;
        }
      }
    }
    try { fs.rmSync(childPath(root, "meta.json"), { recursive: true, force: true }); } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
    meta = null;
    return initialize();
  }

  return Object.freeze({
    root,
    childPath: (...segments) => childPath(root, ...segments),
    clear,
    getMeta,
    hmac,
    initialize,
    quarantine,
    readJson,
    writeJsonAtomic,
  });
}

module.exports = {
  DAILY_RETENTION_DAYS,
  DEFAULT_ROOT,
  EVENT_RETENTION_DAYS,
  SCHEMA_VERSION,
  childPath,
  createRecapStore,
  readJson,
  writeJsonAtomic,
};
