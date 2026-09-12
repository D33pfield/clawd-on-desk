#!/usr/bin/env node
// Merge Clawd Grok Build hooks into ~/.grok/hooks/clawd.json
// Grok loads every *.json in that directory. Ownership is the grok-hook.js
// marker (plus the legacy python bridge), never the filename alone.

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
  formatNodeHookCommand,
  removeMatchingCommandHooks,
} = require("./json-utils");

const MARKER = "grok-hook.js";
const LEGACY_MARKERS = Object.freeze(["grok-hook.js", "clawd-bridge.py"]);
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
  if (typeof options.grokHome === "string" && options.grokHome.trim()) {
    return options.grokHome.trim();
  }
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const grokHomeEnv = typeof env.GROK_HOME === "string" ? env.GROK_HOME.trim() : "";
  if (grokHomeEnv) return grokHomeEnv;
  if (typeof options.homeDir === "string" && options.homeDir) {
    return path.join(options.homeDir, ".grok");
  }
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

function commandUsesManagedMarker(command) {
  if (typeof command !== "string" || !command) return false;
  return LEGACY_MARKERS.some((marker) => command.includes(marker));
}

function desiredHookCommand(nodeBin, hookScript, options = {}) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    platform: options.platform || process.platform,
    windowsWrapper: options.windowsWrapper || "powershell",
    wslDistro: options.wslDistro,
  });
}

function buildOwnedHookEntry(desiredCommand) {
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: desiredCommand,
        timeout: 5,
      },
    ],
  };
}

function countManagedCommands(settings) {
  if (!settings || typeof settings !== "object" || !settings.hooks || typeof settings.hooks !== "object") {
    return 0;
  }
  let count = 0;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (commandUsesManagedMarker(entry.command)) count += 1;
      const inner = entry.hooks;
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        if (hook && commandUsesManagedMarker(hook.command)) count += 1;
      }
    }
  }
  return count;
}

function settingsHasOtherKeys(settings) {
  if (!settings || typeof settings !== "object") return false;
  return Object.keys(settings).some((key) => key !== "hooks");
}

function hooksObjectIsEmpty(hooks) {
  if (!hooks || typeof hooks !== "object") return true;
  return Object.keys(hooks).every((event) => {
    const entries = hooks[event];
    return !Array.isArray(entries) || entries.length === 0;
  });
}

function mergeManagedHookEvent(entries, desiredCommand) {
  const next = Array.isArray(entries) ? entries.slice() : [];
  let found = false;
  let updated = false;
  for (const entry of next) {
    if (!entry || typeof entry !== "object") continue;
    const innerHooks = entry.hooks;
    if (Array.isArray(innerHooks)) {
      for (const hook of innerHooks) {
        if (!hook || !commandUsesManagedMarker(hook.command)) continue;
        found = true;
        if (hook.command !== desiredCommand || hook.type !== "command" || hook.timeout !== 5) {
          hook.type = "command";
          hook.command = desiredCommand;
          hook.timeout = 5;
          updated = true;
        }
      }
    }
    if (!found && commandUsesManagedMarker(entry.command)) {
      found = true;
      entry.command = desiredCommand;
      updated = true;
    }
  }
  if (found) return { entries: next, added: 0, updated: updated ? 1 : 0, skipped: updated ? 0 : 1 };
  next.push(buildOwnedHookEntry(desiredCommand));
  return { entries: next, added: 1, updated: 0, skipped: 0 };
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
  let existed = false;
  try {
    settings = readJsonFile(configPath);
    existed = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read ${configPath}: ${err.message}`);
    }
  }

  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Invalid Grok hook file ${configPath}: top level must be an object`);
  }

  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER, { nested: true })
    || "node";
  const command = desiredHookCommand(nodeBin, hookScript, options);

  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of GROK_HOOK_EVENTS) {
    const result = mergeManagedHookEvent(settings.hooks[event], command);
    settings.hooks[event] = result.entries;
    added += result.added;
    skipped += result.skipped;
    updated += result.updated;
    if (result.added || result.updated) changed = true;
  }

  if (changed) {
    if (existed) writeJsonAtomicWithBackup(configPath, settings, options);
    else writeJsonAtomic(configPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Grok hooks → ${configPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }
  return {
    added,
    skipped,
    updated,
    configPath,
    grokHome,
    changed,
  };
}

function unregisterGrokHooks(options = {}) {
  const configPath = resolveGrokConfigPath(options);
  const fsImpl = options.fs || fs;
  if (!fsImpl.existsSync(configPath)) {
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

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0, changed: false, configPath };
  }

  let removed = 0;
  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const result = removeMatchingCommandHooks(entries, commandUsesManagedMarker);
    if (!result.changed) continue;
    removed += result.removed;
    changed = true;
    if (result.entries.length > 0) settings.hooks[event] = result.entries;
    else delete settings.hooks[event];
  }

  if (!changed) {
    if (!options.silent) console.log("Clawd Grok hooks removed: 0");
    return { removed: 0, changed: false, configPath };
  }

  const canDeleteFile = hooksObjectIsEmpty(settings.hooks) && !settingsHasOtherKeys(settings);
  let backupPath = null;
  if (canDeleteFile) {
    backupPath = writeJsonAtomicWithBackup(configPath, settings, options);
    try {
      fsImpl.unlinkSync(configPath);
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  } else {
    backupPath = writeJsonAtomicWithBackup(configPath, settings, options);
  }

  if (!options.silent) console.log(`Clawd Grok hooks removed: ${removed}`);
  const result = { removed, changed: true, configPath };
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
  desiredHookCommand,
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
