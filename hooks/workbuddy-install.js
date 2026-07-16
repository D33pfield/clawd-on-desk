#!/usr/bin/env node
// Merge Clawd WorkBuddy hooks into ~/.workbuddy/settings.json (append-only, idempotent)
// WorkBuddy uses Claude Code-compatible hook format: { matcher, hooks: [{ type, command }] }

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  resolveNodeBin,
  isManagedPermissionUrl,
} = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  commandMatchesMarker,
  extractExistingNodeBin,
  removeMatchingCommandHooks,
  removeMatchingHttpHooks,
} = require("./json-utils");
const MARKER = "workbuddy-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".workbuddy");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "settings.json");

// WorkBuddy supported hook events (Claude Code-compatible)
const WORKBUDDY_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Notification",
  "PreCompact",
];

/**
 * Register Clawd hooks into ~/.workbuddy/settings.json
 * Uses Claude Code-compatible nested format: { matcher, hooks: [{ type, command }] }
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerWorkBuddyHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".workbuddy", "settings.json");

  // Skip if ~/.workbuddy/ doesn't exist (WorkBuddy not installed)
  const workbuddyDir = path.dirname(settingsPath);
  if (!options.settingsPath && !fs.existsSync(workbuddyDir)) {
    if (!options.silent) console.log("Clawd: ~/.workbuddy/ not found — skipping WorkBuddy hook registration");
    return { added: 0, skipped: 0, updated: 0 };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "workbuddy-hook.js").replace(/\\/g, "/"));

  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

  // Resolve node path; if detection fails, preserve existing absolute path
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER, { nested: true })
    || "node";
  const desiredCommand = `"${nodeBin}" "${hookScript}"`;

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of WORKBUDDY_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stalePath = false;

    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      // Check nested hooks array (Claude Code format)
      const innerHooks = entry.hooks;
      if (Array.isArray(innerHooks)) {
        for (const h of innerHooks) {
          if (!h || !h.command) continue;
          if (!h.command.includes(MARKER)) continue;
          found = true;
          if (h.command !== desiredCommand) {
            h.command = desiredCommand;
            stalePath = true;
          }
          break;
        }
      }
      // Also check flat format for migration
      if (!found && entry.command && entry.command.includes(MARKER)) {
        found = true;
        if (entry.command !== desiredCommand) {
          entry.command = desiredCommand;
          stalePath = true;
        }
      }
      if (found) break;
    }

    if (found) {
      if (stalePath) {
        updated++;
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    // Add in Claude Code-compatible nested format
    arr.push({
      matcher: "",
      hooks: [{ type: "command", command: desiredCommand }],
    });
    added++;
    changed = true;
  }

  // Legacy cleanup (state + Notification only, #618): earlier builds of this
  // installer registered a blocking PermissionRequest HTTP hook pointing at
  // Clawd's /permission endpoint. Desktop WorkBuddy resolves permissions in its
  // own native sandbox + GUI and never calls that endpoint, so we no longer
  // register it — and anyone who ran an old installer should have the dead
  // managed URL pruned. This is strictly marker-scoped: only URLs WE wrote
  // (isManagedPermissionUrl) are removed; a user's own foreign PermissionRequest
  // endpoint is left completely untouched.
  if (Array.isArray(settings.hooks.PermissionRequest)) {
    const cleanup = removeMatchingHttpHooks(settings.hooks.PermissionRequest, (hook) =>
      hook && hook.type === "http" && isManagedPermissionUrl(hook.url)
    );
    if (cleanup.changed) {
      updated += cleanup.removed;
      changed = true;
      if (cleanup.entries.length > 0) settings.hooks.PermissionRequest = cleanup.entries;
      else delete settings.hooks.PermissionRequest;
    }
  }

  if (added > 0 || changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd WorkBuddy hooks → ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

function unregisterWorkBuddyHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".workbuddy", "settings.json");

  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, settingsPath };
    throw new Error(`Failed to read settings.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0, changed: false, settingsPath };
  }

  let removed = 0;
  let changed = false;
  for (const event of WORKBUDDY_HOOK_EVENTS) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const result = removeMatchingCommandHooks(entries, (command) => commandMatchesMarker(command, MARKER));
    if (!result.changed) continue;
    removed += result.removed;
    changed = true;
    if (result.entries.length > 0) settings.hooks[event] = result.entries;
    else delete settings.hooks[event];
  }

  if (Array.isArray(settings.hooks.PermissionRequest)) {
    const result = removeMatchingHttpHooks(settings.hooks.PermissionRequest, (hook) =>
      hook && hook.type === "http" && isManagedPermissionUrl(hook.url)
    );
    if (result.changed) {
      removed += result.removed;
      changed = true;
      if (result.entries.length > 0) settings.hooks.PermissionRequest = result.entries;
      else delete settings.hooks.PermissionRequest;
    }
  }

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(settingsPath, settings, options);
  if (!options.silent) console.log(`Clawd WorkBuddy hooks removed: ${removed}`);
  const result = { removed, changed, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  registerWorkBuddyHooks,
  unregisterWorkBuddyHooks,
  WORKBUDDY_HOOK_EVENTS,
  __test: { isManagedPermissionUrl },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterWorkBuddyHooks({});
    else registerWorkBuddyHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
