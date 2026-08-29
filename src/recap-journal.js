"use strict";

const fs = require("fs");
const path = require("path");
const { createCanonicalRecapEvent } = require("./recap-event");
const { getMetricSupport } = require("./recap-metrics");
const {
  addLocalDays,
  compareLocalDates,
  freezeLocalTime,
  getSystemTimeZone,
  isValidTimeZone,
  parseLocalDate,
} = require("./recap-time");
const { EVENT_RETENTION_DAYS } = require("./recap-store");

const MAX_PERSISTED_RECORD_BYTES = 2048;
const HASH_PATTERN = /^hmac:[A-Za-z0-9_-]{40,64}$/;

function validHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function normalizeSupport(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof value.sessionsStarted !== "boolean"
    || typeof value.turnsCompleted !== "boolean"
    || typeof value.toolCalls !== "boolean"
  ) return null;
  return {
    sessionsStarted: value.sessionsStarted,
    turnsCompleted: value.turnsCompleted,
    toolCalls: value.toolCalls,
  };
}

function normalizePersistedRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let canonical;
  try {
    canonical = createCanonicalRecapEvent(value);
    parseLocalDate(value.localDate);
  } catch {
    return null;
  }
  if (
    !isValidTimeZone(value.timeZoneId)
    || !Number.isInteger(value.utcOffsetMinutes)
    || value.utcOffsetMinutes < -24 * 60
    || value.utcOffsetMinutes > 24 * 60
    || !Number.isInteger(value.localHour)
    || value.localHour < 0
    || value.localHour > 23
    || !validHash(value.scopeKeyHash)
    || (value.sessionKeyHash !== undefined && !validHash(value.sessionKeyHash))
    || (value.dedupeKeyHash !== undefined && !validHash(value.dedupeKeyHash))
    || (value.sessionStartPartial !== undefined && typeof value.sessionStartPartial !== "boolean")
  ) return null;

  const frozen = freezeLocalTime(canonical.occurredAt, value.timeZoneId);
  const support = normalizeSupport(value.support);
  if (
    frozen.localDate !== value.localDate
    || frozen.localHour !== value.localHour
    || frozen.utcOffsetMinutes !== value.utcOffsetMinutes
    || !support
  ) return null;

  const record = {
    schemaVersion: 1,
    occurredAt: canonical.occurredAt,
    timeZoneId: value.timeZoneId,
    utcOffsetMinutes: value.utcOffsetMinutes,
    localDate: value.localDate,
    localHour: value.localHour,
    agentId: canonical.agentId,
    scope: canonical.scope,
    scopeKeyHash: value.scopeKeyHash,
    metrics: [...canonical.metrics],
    support,
  };
  if (value.sessionKeyHash) record.sessionKeyHash = value.sessionKeyHash;
  if (value.dedupeKeyHash) record.dedupeKeyHash = value.dedupeKeyHash;
  if (value.sessionStartPartial === true) record.sessionStartPartial = true;
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_PERSISTED_RECORD_BYTES) return null;
  return record;
}

function createRecapJournal(options = {}) {
  if (!options.store) throw new Error("createRecapJournal requires store");
  const store = options.store;
  const now = options.now || Date.now;
  const getTimeZone = options.getTimeZone || getSystemTimeZone;
  const logWarn = options.logWarn || console.warn;
  const seenDedupe = new Set();

  function warn(message, err) {
    try { logWarn(message, err && err.message ? err.message : err); } catch {}
  }

  function eventPath(localDate) {
    parseLocalDate(localDate);
    return store.childPath("events", `${localDate}.jsonl`);
  }

  function buildRecord(event, identity = {}) {
    const canonical = createCanonicalRecapEvent(event);
    const requestedTimeZone = getTimeZone();
    const timeZoneId = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";
    const local = freezeLocalTime(canonical.occurredAt, timeZoneId);
    const scopeId = canonical.scope === "local" ? "local" : identity.scopeId || canonical.scope;
    const scopeKeyHash = store.hmac("scope", canonical.scope, scopeId);
    const record = {
      schemaVersion: 1,
      occurredAt: canonical.occurredAt,
      timeZoneId: local.timeZoneId,
      utcOffsetMinutes: local.utcOffsetMinutes,
      localDate: local.localDate,
      localHour: local.localHour,
      agentId: canonical.agentId,
      scope: canonical.scope,
      scopeKeyHash,
      metrics: [...canonical.metrics],
      support: getMetricSupport(canonical.agentId),
    };
    if (identity.sessionId) {
      record.sessionKeyHash = store.hmac(
        "session",
        canonical.agentId,
        canonical.scope,
        scopeId,
        identity.sessionId
      );
    }
    if (identity.dedupeId) {
      record.dedupeKeyHash = store.hmac(
        "dedupe",
        canonical.agentId,
        canonical.scope,
        scopeId,
        identity.sessionId || "",
        identity.dedupeId
      );
    }
    if (identity.sessionStartPartial === true) record.sessionStartPartial = true;
    const normalized = normalizePersistedRecord(record);
    if (!normalized) throw new TypeError("recap record could not be persisted safely");
    return normalized;
  }

  function append(record) {
    const normalized = normalizePersistedRecord(record);
    if (!normalized) throw new TypeError("invalid recap journal record");
    if (normalized.dedupeKeyHash && seenDedupe.has(normalized.dedupeKeyHash)) return false;
    const filePath = eventPath(normalized.localDate);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let prefix = "";
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) {
        const fd = fs.openSync(filePath, "r");
        try {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, stat.size - 1);
          if (last[0] !== 0x0a) prefix = "\n";
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    fs.appendFileSync(filePath, `${prefix}${JSON.stringify(normalized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (normalized.dedupeKeyHash) seenDedupe.add(normalized.dedupeKeyHash);
    return true;
  }

  function readDate(localDate) {
    let contents;
    try {
      contents = fs.readFileSync(eventPath(localDate), "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return [];
      throw err;
    }
    const records = [];
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_PERSISTED_RECORD_BYTES) {
        warn("Clawd: ignored oversized recap journal line");
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(line); } catch {
        warn("Clawd: ignored corrupt recap journal line");
        continue;
      }
      const normalized = normalizePersistedRecord(parsed);
      if (!normalized || normalized.localDate !== localDate) {
        warn("Clawd: ignored invalid recap journal record");
        continue;
      }
      records.push(normalized);
    }
    return records;
  }

  function retainedDates(anchorDate) {
    parseLocalDate(anchorDate);
    return Array.from({ length: EVENT_RETENTION_DAYS }, (_, index) =>
      addLocalDays(anchorDate, -(EVENT_RETENTION_DAYS - 1 - index)));
  }

  function loadRetained(anchorDate = freezeLocalTime(now(), getTimeZone()).localDate) {
    const records = retainedDates(anchorDate).flatMap(readDate);
    seenDedupe.clear();
    for (const record of records) {
      if (record.dedupeKeyHash) seenDedupe.add(record.dedupeKeyHash);
    }
    return records;
  }

  function prune(anchorDate = freezeLocalTime(now(), getTimeZone()).localDate) {
    const oldest = addLocalDays(anchorDate, -(EVENT_RETENTION_DAYS - 1));
    const dirPath = store.childPath("events");
    let names = [];
    try { names = fs.readdirSync(dirPath); } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    for (const name of names) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!match) continue;
      try {
        if (compareLocalDates(match[1], oldest) < 0) fs.unlinkSync(store.childPath("events", name));
      } catch (err) {
        if (!err || err.code !== "ENOENT") warn("Clawd: recap event retention failed", err);
      }
    }
  }

  return Object.freeze({
    append,
    buildRecord,
    eventPath,
    loadRetained,
    prune,
    readDate,
    retainedDates,
  });
}

module.exports = {
  MAX_PERSISTED_RECORD_BYTES,
  createRecapJournal,
  normalizePersistedRecord,
};
