#!/usr/bin/env node
// Merge Clawd Grok Build hooks into ~/.grok/hooks/clawd.json
// Grok loads every *.json in that directory. This file is Clawd-owned.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  resolveNodeBin,
} = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  extractExistingNodeBin,
} = require("./json-utils");

const MARKER = "grok-hook.js";
const HOOKS_DIR_NAME = "hooks";
const CONFIG_FILE_NAME = "clawd.json";

const GROK_HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionDenied",
]);

function resolveGrokHome(options = {}) {
  if (typeof options.grokHome === "string" && options.grokHome) return options.grokHome;
  if (typeof options.homeDir === "string" && options.homeDir) {
    return path.join(options.homeDir, ".grok");
  }
  const envHome = options.env && typeof options.env.GROK_HOME === "string"
    ? options.env.GROK_HOME.trim()
    : (process.env.GROK_HOME || "").trim();
  if (envHome) return envHome;
  return path.join(os.homedir(), ".grok");
}

function resolveGrokHooksDir(options = {}) {
  return path.join(resolveGrokHome(options), HOOKS_DIR_NAME);
}

function resolveGrokConfigPath(options = {}) {
  if (typeof options.configPath === "string" && options.configPath) return options.configPath;
  return path.join(resolveGrokHooksDir(options), CONFIG_FILE_NAME);
}

const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".grok");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, HOOKS_DIR_NAME, CONFIG_FILE_NAME);

function desiredHookCommand(nodeBin, hookScript) {
  return `"${nodeBin}" "${hookScript}"`;
}

function commandUsesMarker(command) {
  return typeof command === "string" && command.includes(MARKER);
}

function buildOwnedHooks(desiredCommand) {
  const hooks = {};
  for (const event of GROK_HOOK_EVENTS) {
    hooks[event] = [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: desiredCommand,
            timeout: 5,
          },
        ],
      },
    ];
  }
  return hooks;
}

function countMarkerCommands(settings) {
  if (!settings || typeof settings !== "object" || !settings.hooks || typeof settings.hooks !== "object") {
    return 0;
  }
  let count = 0;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (commandUsesMarker(entry.command)) count += 1;
      const inner = entry.hooks;
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        if (hook && commandUsesMarker(hook.command)) count += 1;
      }
    }
  }
  return count;
}

function registerGrokHooks(options = {}) {
  const grokHome = resolveGrokHome(options);
  const configPath = resolveGrokConfigPath(options);
  const fsImpl = options.fs || fs;

  if (!options.configPath && !options.force && !fsImpl.existsSync(grokHome)) {
    if (!options.silent) console.log("Clawd: Grok home directory not found — skipping hook registration");
    return { added: 0, skipped: 0, updated: 0, configPath, grokHome };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "grok-hook.js").replace(/\\/g, "/"));
  let settings = {};
  try {
    settings = readJsonFile(configPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read ${configPath}: ${err.message}`);
    }
  }

  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER, { nested: true })
    || "node";
  const desiredCommand = desiredHookCommand(nodeBin, hookScript);
  const nextSettings = { hooks: buildOwnedHooks(desiredCommand) };
  const nextJson = JSON.stringify(nextSettings);
  const prevJson = JSON.stringify(settings && typeof settings === "object" ? settings : {});
  const previousMarkerCount = countMarkerCommands(settings);
  const nextMarkerCount = GROK_HOOK_EVENTS.length;

  if (nextJson === prevJson) {
    if (!options.silent) {
      console.log(`Clawd Grok hooks → ${configPath}`);
      console.log(`  Added: 0, updated: 0, skipped: ${nextMarkerCount}`);
    }
    return {
      added: 0,
      skipped: nextMarkerCount,
      updated: 0,
      configPath,
      grokHome,
    };
  }

  writeJsonAtomic(configPath, nextSettings);
  const added = previousMarkerCount === 0 ? nextMarkerCount : 0;
  const updated = previousMarkerCount > 0 ? nextMarkerCount : 0;
  if (!options.silent) {
    console.log(`Clawd Grok hooks → ${configPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: 0`);
  }
  return {
    added,
    skipped: 0,
    updated,
    configPath,
    grokHome,
    changed: true,
  };
}

function unregisterGrokHooks(options = {}) {
  const configPath = resolveGrokConfigPath(options);
  if (!fs.existsSync(configPath)) {
    if (!options.silent) console.log("Clawd Grok hooks removed: 0");
    return { removed: 0, changed: false, configPath };
  }

  let settings = {};
  try {
    settings = readJsonFile(configPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, configPath };
    throw new Error(`Failed to read ${configPath}: ${err.message}`);
  }

  const removed = countMarkerCommands(settings);
  if (removed === 0 && (!settings.hooks || Object.keys(settings.hooks).length === 0)) {
    if (!options.silent) console.log("Clawd Grok hooks removed: 0");
    return { removed: 0, changed: false, configPath };
  }

  const backupPath = writeJsonAtomicWithBackup(configPath, { hooks: {} }, options);
  try {
    fs.unlinkSync(configPath);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
  if (!options.silent) console.log(`Clawd Grok hooks removed: ${removed || GROK_HOOK_EVENTS.length}`);
  const result = {
    removed: removed || GROK_HOOK_EVENTS.length,
    changed: true,
    configPath,
  };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  MARKER,
  GROK_HOOK_EVENTS,
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  resolveGrokHome,
  resolveGrokHooksDir,
  resolveGrokConfigPath,
  registerGrokHooks,
  unregisterGrokHooks,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterGrokHooks({});
    else registerGrokHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
