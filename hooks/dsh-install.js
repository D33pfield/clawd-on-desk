#!/usr/bin/env node
"use strict";

// DeepSeek Harness integration.
//
// DSH is integrated zero-touch: Clawd's monitor
// (agents/deepseek-harness-monitor.js) reads the harness's durable JSON side
// under $DSH_HOME/storages directly and installs NOTHING into DSH — no hooks,
// no plugins, no config edits. This module only detects the harness so the
// Settings Agent page can show Install / Uninstall, and so startup sync can
// gate the monitor on DSH actually being present.

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

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

// Zero-touch install: nothing is written into DSH. Detection success IS the
// install — the monitor is what makes the harness visible, and the monitor
// only needs the data dirs to exist.
function registerDeepSeekHarness(options = {}) {
  if (!isDshInstalled(options)) {
    const silent = options && options.silent;
    if (!silent) console.log("Clawd: DeepSeek Harness not found - skipping integration");
    return { installed: false, skipped: true, updated: false, reason: "dsh-not-found" };
  }
  if (!options || !options.silent) {
    console.log("Clawd: DeepSeek Harness detected (zero-touch integration — no files written)");
  }
  return { installed: true, skipped: false, updated: false };
}

// Uninstall is a no-op for the same reason: Clawd never wrote into DSH, so
// there is nothing to remove. It reports no removal so cleanup statistics and
// idempotency checks stay truthful (a zero-touch uninstall must not count as
// an entry removed).
function unregisterDeepSeekHarness(options = {}) {
  if (!options || !options.silent) {
    console.log("Clawd: DeepSeek Harness integration has no files to remove");
  }
  return { removed: false, skipped: true };
}

module.exports = {
  hasDshCommand,
  isDshInstalled,
  registerDeepSeekHarness,
  resolveDshHome,
  unregisterDeepSeekHarness,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      unregisterDeepSeekHarness({});
    } else {
      registerDeepSeekHarness({});
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
