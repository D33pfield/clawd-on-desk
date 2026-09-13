#!/usr/bin/env node
"use strict";

// Installs the Clawd <-> OMP (oh-my-pi) extension into
// ~/.omp/agent/extensions/clawd-on-desk/. Derived from hooks/pi-install.js;
// OMP is a fork of the same agent and the install contract is identical.

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { asarUnpackedPath, writeJsonAtomic } = require("./json-utils");
const { resolveNodeBin } = require("./server-config");

const EXTENSION_DIR_NAME = "clawd-on-desk";
const EXTENSION_FILE = "index.ts";
const CORE_FILE = "omp-extension-core.js";
const MARKER_FILE = ".clawd-managed.json";
// The community bridge (github.com/Crosery/clawd-on-desk-omp) installs as a
// single sibling file in the same extensions directory and reports the same
// lifecycle events through Clawd's custom-application channel. OMP would load
// both and POST twice per event, so its presence blocks this installer.
const STANDALONE_BRIDGE_FILE = "clawd-on-desk-omp.ts";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".omp", "agent");
const DEFAULT_EXTENSIONS_DIR = path.join(DEFAULT_PARENT_DIR, "extensions");
const DEFAULT_EXTENSION_DIR = path.join(DEFAULT_EXTENSIONS_DIR, EXTENSION_DIR_NAME);

function resolveSourcePath(fileName, baseDir = __dirname) {
  return asarUnpackedPath(path.resolve(baseDir, fileName));
}

function writeTextAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, text, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function fileExists(filePath, fsImpl = fs) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath, fsImpl = fs) {
  try {
    return fsImpl.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readJsonIfPresent(filePath, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isManagedMarker(value) {
  return !!(
    value
    && value.app === "clawd-on-desk"
    && value.integration === "omp"
    && value.managed === true
  );
}

function buildMarker() {
  return {
    app: "clawd-on-desk",
    integration: "omp",
    managed: true,
    version: 1,
    installedAt: new Date().toISOString(),
  };
}

function commandExists(command, args, options = {}) {
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  try {
    const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
    const raw = execFileSync(command, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
    });
    return String(raw || "").trim().length > 0;
  } catch {
    return false;
  }
}

function executableExists(filePath, platform, accessSync = fs.accessSync) {
  try {
    accessSync(filePath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasOmpCommand(options = {}) {
  if (typeof options.ompCommandAvailable === "boolean") return options.ompCommandAvailable;
  if (typeof options.ompCommandAvailable === "function") return !!options.ompCommandAvailable();

  const platform = options.platform || process.platform;
  const accessSync = options.accessSync || fs.accessSync;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const nodeBin = Object.prototype.hasOwnProperty.call(options, "nodeBin")
    ? options.nodeBin
    : resolveNodeBin({ platform, execFileSync, accessSync });

  if (nodeBin && nodeBin !== "node") {
    const nodeDir = path.dirname(nodeBin);
    const candidates = platform === "win32"
      ? ["omp.cmd", "omp.exe", "omp.ps1"]
      : ["omp"];
    if (candidates.some((name) => executableExists(path.join(nodeDir, name), platform, accessSync))) {
      return true;
    }
  }

  if (platform === "win32") {
    return commandExists("where", ["omp"], { execFileSync });
  }

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    if (commandExists(shell, ["-lic", "command -v omp"], { execFileSync })) return true;
  }
  return commandExists("sh", ["-lc", "command -v omp"], { execFileSync });
}

function resolveExtensionsDir(options = {}) {
  if (options.extensionDir) return path.dirname(options.extensionDir);
  return path.join(options.parentDir || DEFAULT_PARENT_DIR, "extensions");
}

// Path of the standalone bridge if the user already runs it, else null.
function findStandaloneBridge(options = {}) {
  const fsImpl = options.fs || fs;
  const candidate = path.join(resolveExtensionsDir(options), STANDALONE_BRIDGE_FILE);
  return fileExists(candidate, fsImpl) ? candidate : null;
}

function resolveExtensionDir(options = {}) {
  return options.extensionDir || path.join(options.parentDir || DEFAULT_PARENT_DIR, "extensions", EXTENSION_DIR_NAME);
}

function readSourceFiles(options = {}) {
  const sourceDir = options.sourceDir || __dirname;
  const extensionPath = options.extensionSourcePath || resolveSourcePath("omp-extension.ts", sourceDir);
  const corePath = options.coreSourcePath || resolveSourcePath(CORE_FILE, sourceDir);
  return {
    extensionPath,
    corePath,
    extensionText: fs.readFileSync(extensionPath, "utf8"),
    coreText: fs.readFileSync(corePath, "utf8"),
  };
}

function registerOmpExtension(options = {}) {
  const fsImpl = options.fs || fs;
  const parentDir = options.parentDir || DEFAULT_PARENT_DIR;
  const extensionDir = resolveExtensionDir(options);
  const markerPath = path.join(extensionDir, MARKER_FILE);
  const extensionPath = path.join(extensionDir, EXTENSION_FILE);
  const corePath = path.join(extensionDir, CORE_FILE);

  const parentExists = dirExists(parentDir, fsImpl);
  if (!parentExists && !hasOmpCommand(options)) {
    if (!options.silent) {
      console.log("Clawd: OMP not found - skipping OMP extension registration");
    }
    return { installed: false, skipped: true, updated: false, reason: "omp-not-found", extensionDir };
  }

  const standaloneBridge = findStandaloneBridge({ ...options, extensionDir });
  if (standaloneBridge) {
    if (!options.silent) {
      console.log(`Clawd: ${standaloneBridge} already bridges OMP - skipping`);
      console.log("  Remove it first if you want Clawd to manage the integration instead.");
    }
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: "standalone-bridge-present",
      extensionDir,
      standaloneBridge,
    };
  }

  const extensionExists = dirExists(extensionDir, fsImpl);
  if (extensionExists && !isManagedMarker(readJsonIfPresent(markerPath, fsImpl))) {
    if (!options.silent) {
      console.log(`Clawd: ${extensionDir} exists but is not Clawd-managed - skipping`);
    }
    return { installed: false, skipped: true, updated: false, reason: "unmanaged-existing-extension", extensionDir };
  }

  const { extensionText, coreText } = readSourceFiles(options);
  const previousExtension = fileExists(extensionPath, fsImpl) ? fsImpl.readFileSync(extensionPath, "utf8") : null;
  const previousCore = fileExists(corePath, fsImpl) ? fsImpl.readFileSync(corePath, "utf8") : null;
  const updated = previousExtension !== extensionText || previousCore !== coreText;

  fsImpl.mkdirSync(extensionDir, { recursive: true });
  writeTextAtomic(extensionPath, extensionText);
  writeTextAtomic(corePath, coreText);
  writeJsonAtomic(markerPath, buildMarker());

  if (!options.silent) {
    console.log(`Clawd OMP extension -> ${extensionDir}`);
    console.log(updated ? "  Installed or updated" : "  Already up to date");
  }

  return { installed: true, skipped: false, updated, extensionDir };
}

function unregisterOmpExtension(options = {}) {
  const fsImpl = options.fs || fs;
  const extensionDir = resolveExtensionDir(options);
  const markerPath = path.join(extensionDir, MARKER_FILE);
  const marker = readJsonIfPresent(markerPath, fsImpl);
  if (!dirExists(extensionDir, fsImpl)) {
    if (!options.silent) console.log("Clawd: OMP extension is not installed");
    return { removed: false, skipped: true, reason: "missing", extensionDir };
  }
  if (!isManagedMarker(marker)) {
    if (!options.silent) console.log(`Clawd: ${extensionDir} is not Clawd-managed - skipping uninstall`);
    return { removed: false, skipped: true, reason: "unmanaged-existing-extension", extensionDir };
  }
  fsImpl.rmSync(extensionDir, { recursive: true, force: true });
  if (!options.silent) console.log(`Clawd: removed OMP extension from ${extensionDir}`);
  return { removed: true, skipped: false, extensionDir };
}

module.exports = {
  CORE_FILE,
  STANDALONE_BRIDGE_FILE,
  findStandaloneBridge,
  resolveExtensionsDir,
  DEFAULT_EXTENSION_DIR,
  DEFAULT_EXTENSIONS_DIR,
  DEFAULT_PARENT_DIR,
  EXTENSION_DIR_NAME,
  EXTENSION_FILE,
  MARKER_FILE,
  buildMarker,
  hasOmpCommand,
  isManagedMarker,
  registerOmpExtension,
  resolveExtensionDir,
  resolveSourcePath,
  unregisterOmpExtension,
  writeTextAtomic,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      unregisterOmpExtension({});
    } else {
      registerOmpExtension({});
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
