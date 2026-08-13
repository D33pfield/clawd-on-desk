#!/usr/bin/env node
"use strict";

// DeepSeek Harness integration.
//
// Two layers:
//
// 1. Perception (zero-touch): Clawd's monitor
//    (agents/deepseek-harness-monitor.js) reads the harness's durable JSON
//    side under $DSH_HOME/storages directly and installs NOTHING into DSH.
//    The detector only checks whether DSH is present so the Settings Agent
//    page can show Install / Uninstall and startup sync can gate the monitor.
//
// 2. Interactive bridge (opt-in, Clawd-managed): when the user explicitly
//    installs the DeepSeek Harness integration from Settings (or a doctor
//    repair runs), Clawd registers its @dsh-external/dsh-clawd-bridge plugin
//    into the DSH web profile via the official `dsh plugin` command. The
//    bridge routes DSH's ask_user_question / approval requests to Clawd's
//    permission bubbles. Startup sync stays read-only: detection only, so a
//    DSH install is never modified without an explicit user action.
//
// The bridge source lives in this repository at hooks/dsh-clawd-bridge/ and
// is registered with `dsh plugin --profile web add <dir>`, which runs pnpm
// add and reconciles the profile's bundle layer automatically. Uninstall
// removes it with `dsh plugin --profile web remove`. Both commands fail
// closed: a bridge registration failure never fails the DSH detection or
// the Clawd startup.

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const BRIDGE_PACKAGE_NAME = "@dsh-external/dsh-clawd-bridge";
const BRIDGE_SOURCE_DIR = path.join(__dirname, "dsh-clawd-bridge");
const WEB_PROFILE_NAME = "web";

function resolveDshHome(env = process.env) {
  const override = env && typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (override) return override;
  return path.join(os.homedir(), ".dsh");
}

function dirExists(dirPath, fsImpl = fs) {
  try {
    return fsImpl.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
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

function hasDshCommand(options = {}) {
  if (typeof options.dshCommandAvailable === "boolean") return options.dshCommandAvailable;
  if (typeof options.dshCommandAvailable === "function") return !!options.dshCommandAvailable();

  const platform = options.platform || process.platform;
  const execFileSync = options.execFileSync || childProcess.execFileSync;

  if (platform === "win32") {
    return commandExists("where", ["dsh"], { execFileSync });
  }
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    if (commandExists(shell, ["-lic", "command -v dsh"], { execFileSync })) return true;
  }
  return commandExists("sh", ["-lc", "command -v dsh"], { execFileSync });
}

// DSH is "installed" when its home directory carries a recognizable harness
// layout (profiles/, sessions/, or storages/) OR the `dsh` CLI is on PATH.
// The home check is authoritative for an already-run harness; the command
// check covers a fresh install that has not yet created its data dirs.
function isDshInstalled(options = {}) {
  const fsImpl = options.fs || fs;
  const home = options.dshHome || resolveDshHome(options.env);
  if (dirExists(home, fsImpl)) {
    const subdirs = ["profiles", "sessions", "storages"];
    if (subdirs.some((name) => dirExists(path.join(home, name), fsImpl))) return true;
  }
  return hasDshCommand(options);
}

function resolveDshProfileDir(dshHome) {
  return path.join(dshHome, "profiles", WEB_PROFILE_NAME);
}

function readJsonFile(filePath, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// The bridge is installed when the DSH web profile's manifest carries the
// package as a dependency AND as a profile bundle layer (the latter is what
// the loader actually boots).
function isBridgeInstalled(options = {}) {
  const fsImpl = options.fs || fs;
  const home = options.dshHome || resolveDshHome(options.env);
  const manifestPath = path.join(resolveDshProfileDir(home), "package.json");
  const manifest = readJsonFile(manifestPath, fsImpl);
  if (!manifest) return false;
  const dependencies = manifest.dependencies && typeof manifest.dependencies === "object"
    ? manifest.dependencies
    : {};
  const bundles = manifest.dsh
    && manifest.dsh.profile
    && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : [];
  return Object.prototype.hasOwnProperty.call(dependencies, BRIDGE_PACKAGE_NAME)
    && bundles.includes(BRIDGE_PACKAGE_NAME);
}

// Locate the dsh CLI entry inside the npm global layout: `where dsh` returns
// the shim (dsh / dsh.cmd) inside the npm bin dir, whose sibling
// node_modules/@deepseek-ai/dsh/lib/bin.js is the real Node entry. Executing
// that file with the current Node process avoids cmd.exe quote stripping on
// Windows shims entirely.
function resolveDshBinJs(options = {}) {
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  try {
    const raw = execFileSync("where", ["dsh"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const line = String(raw || "").split(/\r?\n/).find((entry) => entry.trim().length > 0);
    if (!line) return null;
    const candidate = path.join(
      path.dirname(line.trim()),
      "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"
    );
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// Execute the `dsh` CLI. On Windows the npm shim is a .cmd file that
// execFileSync cannot run directly and cmd.exe quote wrapping is fragile, so
// the real Node entry (bin.js) is located via `where dsh` and executed with
// the current Node process. POSIX invokes `dsh` directly.
function runDshCommand(args, options = {}) {
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const platform = options.platform || process.platform;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
  const common = { encoding: "utf8", timeout, windowsHide: true, stdio: "pipe" };
  if (platform === "win32") {
    const binJs = resolveDshBinJs(options);
    if (binJs !== null) return execFileSync(process.execPath, [binJs, ...args], common);
  }
  return execFileSync("dsh", args, common);
}

// Register Clawd's bridge plugin into the DSH web profile. Idempotent: a
// profile that already carries the bridge is left untouched. Fails closed —
// any error returns { status: "error" } and never throws into callers.
function installDeepSeekHarnessBridge(options = {}) {
  const silent = Boolean(options && options.silent);
  const home = options.dshHome || resolveDshHome(options.env);

  if (!isDshInstalled(options)) {
    if (!silent) console.log("Clawd: DeepSeek Harness not found - skipping bridge install");
    return { status: "skipped", reason: "dsh-not-found" };
  }
  if (isBridgeInstalled({ ...options, dshHome: home })) {
    if (!silent) console.log("Clawd: DeepSeek Harness bridge already registered");
    return { status: "ok", updated: false };
  }
  if (!dirExists(BRIDGE_SOURCE_DIR)) {
    if (!silent) console.log("Clawd: bridge source missing, cannot register");
    return { status: "error", message: "dsh-clawd-bridge source directory not found" };
  }

  try {
    if (!silent) console.log("Clawd: registering DeepSeek Harness bridge plugin...");
    runDshCommand(["plugin", "--profile", WEB_PROFILE_NAME, "add", BRIDGE_SOURCE_DIR], options);
    if (!isBridgeInstalled({ ...options, dshHome: home })) {
      return { status: "error", message: "dsh plugin add completed but the bridge is not registered" };
    }
    if (!silent) console.log(`Clawd: DeepSeek Harness bridge registered (profile ${WEB_PROFILE_NAME})`);
    return { status: "ok", updated: true };
  } catch (err) {
    if (!silent) console.warn("Clawd: failed to register DeepSeek Harness bridge:", err && err.message);
    return { status: "error", message: err && err.message ? err.message : "dsh plugin add failed" };
  }
}

// Remove Clawd's bridge plugin from the DSH web profile. Idempotent and
// tolerant: a missing DSH or a missing bridge is a skip, not an error.
function uninstallDeepSeekHarnessBridge(options = {}) {
  const silent = Boolean(options && options.silent);
  const home = options.dshHome || resolveDshHome(options.env);

  if (!isBridgeInstalled({ ...options, dshHome: home })) {
    return { status: "skipped", reason: "bridge-not-installed" };
  }

  try {
    if (!silent) console.log("Clawd: removing DeepSeek Harness bridge plugin...");
    runDshCommand(["plugin", "--profile", WEB_PROFILE_NAME, "remove", BRIDGE_PACKAGE_NAME], options);
    if (isBridgeInstalled({ ...options, dshHome: home })) {
      return { status: "error", message: "dsh plugin remove completed but the bridge is still registered" };
    }
    if (!silent) console.log("Clawd: DeepSeek Harness bridge removed");
    return { status: "ok", updated: true };
  } catch (err) {
    if (!silent) console.warn("Clawd: failed to remove DeepSeek Harness bridge:", err && err.message);
    return { status: "error", message: err && err.message ? err.message : "dsh plugin remove failed" };
  }
}

// Zero-touch perception install: nothing is written into DSH. Detection
// success IS the install — the monitor is what makes the harness visible, and
// the monitor only needs the data dirs to exist. The interactive bridge is
// NOT registered here; callers that want it (Settings Install, doctor repair)
// call installDeepSeekHarnessBridge explicitly.
function registerDeepSeekHarness(options = {}) {
  if (!isDshInstalled(options)) {
    const silent = options && options.silent;
    if (!silent) console.log("Clawd: DeepSeek Harness not found - skipping integration");
    return { installed: false, skipped: true, updated: false, reason: "dsh-not-found" };
  }
  if (!options || !options.silent) {
    console.log("Clawd: DeepSeek Harness detected");
  }
  return { installed: true, skipped: false, updated: false };
}

// Full uninstall: remove the Clawd-managed bridge plugin from DSH (when
// present), then report. Perception itself has nothing to remove, so the
// bridge removal is the only actionable work. Return shapes stay compatible
// with cleanup-integrations / integration-sync consumers.
function unregisterDeepSeekHarness(options = {}) {
  const silent = Boolean(options && options.silent);
  const bridgeResult = uninstallDeepSeekHarnessBridge(options);
  if (bridgeResult.status === "ok") {
    if (!silent) console.log("Clawd: DeepSeek Harness bridge removed");
    return { removed: true, skipped: false };
  }
  if (bridgeResult.status === "error") {
    if (!silent) console.warn("Clawd: DeepSeek Harness bridge removal failed:", bridgeResult.message);
    return { removed: false, skipped: false, reason: "bridge-remove-failed" };
  }
  if (!silent) console.log("Clawd: DeepSeek Harness integration has no files to remove");
  return { removed: false, skipped: true };
}

module.exports = {
  BRIDGE_PACKAGE_NAME,
  hasDshCommand,
  installDeepSeekHarnessBridge,
  isBridgeInstalled,
  isDshInstalled,
  registerDeepSeekHarness,
  resolveDshHome,
  resolveDshProfileDir,
  unregisterDeepSeekHarness,
  uninstallDeepSeekHarnessBridge,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      unregisterDeepSeekHarness({});
    } else if (process.argv.includes("--install-bridge")) {
      installDeepSeekHarnessBridge({});
    } else if (process.argv.includes("--uninstall-bridge")) {
      uninstallDeepSeekHarnessBridge({});
    } else {
      registerDeepSeekHarness({});
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
