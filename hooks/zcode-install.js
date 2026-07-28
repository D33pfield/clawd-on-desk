#!/usr/bin/env node
// Merge Clawd ZCode hooks into ~/.zcode/cli/config.json.
//
// ZCode (智谱/Z.ai) is an Electron desktop ADE. Legacy 3.4.x builds spawned a
// standalone `zcode-cli`; current macOS 3.5.x builds run Resources/glm/zcode.cjs
// through Electron's Node mode. Both read ~/.zcode/cli/config.json. Per ZCode's
// official configuration and hook documentation, config-file hooks differ from
// plugin hooks.json in three ways:
//   1. They nest under `hooks.events.<EventName>` (plugin hooks.json uses
//      `hooks.<EventName>` — DO NOT confuse the two, or config.json fails to load).
//   2. They are DISABLED by default; `hooks.enabled: true` is required.
//   3. Missing / empty / "*" matchers all match every tool. State-only hooks
//      omit the matcher because they do not need tool filtering.
// ZCode supports exactly 7 events: SessionStart, UserPromptSubmit, PreToolUse,
// PermissionRequest, PostToolUse, PostToolUseFailure, Stop (no SessionEnd /
// Notification). Phase 1 registers the 6 state-only events (no PermissionRequest).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  formatNodeHookCommand,
  decodeWindowsEncodedCommand,
  removeMatchingCommandHooks,
} = require("./json-utils");

// ZCode config-file hooks nest under hooks.events.<Event> (unlike Claude /
// Qwen settings.json hooks which sit directly under hooks.<Event>), so the
// shared extractExistingNodeBin() helper cannot see them. Walk hooks.events.*
// ourselves to reuse a previously-installed absolute node path.
function extractExistingZcodeNodeBin(settings, marker) {
  const events = settings && settings.hooks && settings.hooks.events;
  if (!events || typeof events !== "object") return null;
  for (const entries of Object.values(events)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== "string") continue;
        if (h.command.includes(marker)) return extractNodeBinFromCommand(h.command);
        const decoded = decodeWindowsEncodedCommand(h.command);
        if (decoded && decoded.includes(marker)) return extractNodeBinFromCommand(decoded);
      }
    }
  }
  return null;
}

// Find the node executable path in a hook command string. Handles quoted
// forms ("..."/'...') and the PowerShell call operator (`& 'node' ...`), where
// node is NOT the first token.
function extractNodeBinFromCommand(command) {
  const tokenRegex = /"([^"]+node(?:\.exe)?)"|'([^']+node(?:\.exe)?)'|(\S*node(?:\.exe)?)/gi;
  let match;
  while ((match = tokenRegex.exec(command)) !== null) {
    const candidate = match[1] || match[2] || match[3];
    if (candidate) return candidate;
  }
  return null;
}

const MARKER = "zcode-hook.js";
// Claude Code's state hook. When a user imports their Claude config into ZCode
// (via ZCode's Hooks settings), `clawd-hook.js` entries can end up in
// ~/.zcode/cli/config.json. Because clawd-hook.js hardcodes agent_id="claude-code"
// (it does not detect the host process), a ZCode session would then produce a
// spurious Claude-Code-attributed session alongside the correct zcode one. We
// strip ONLY these Clawd-owned Claude entries from the zcode config — third-party
// hooks are untouched, and ~/.claude/settings.json is NEVER modified.
const CLAUDE_MARKER = "clawd-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".zcode");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "cli", "config.json");

// The 6 state-only events ZCode supports (PermissionRequest, the 7th, is
// reserved for a future Phase 2 permission bubble). SessionEnd / Notification
// are NOT supported by ZCode — including them makes config.json fail to load.
const ZCODE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

function timeoutMsForZcodeEvent() {
  // State-only: no blocking PermissionRequest, so every event is a fire-and
  // -forget state report. 30000ms (30s) mirrors the non-permission Qwen events.
  //
  // IMPORTANT: ZCode's hook schema differs from Claude Code / Qwen in timeout
  // units. The `timeout` field is in SECONDS (internally ×1000), so writing
  // `timeout: 30000` would mean ~8.3 hours and block inline hooks on a hang.
  // Use `timeoutMs` (milliseconds) explicitly — it also takes precedence over
  // `timeout`. (Qwen's `timeout: 30000` is millisecond-semantic because Qwen
  // uses the Claude Code schema; do NOT copy that field across.)
  return 30000;
}

// ZCode treats a missing / empty / "*" matcher as match-all. State-only hooks
// do not need tool filtering, so use the smallest canonical form and omit it.
// Kept as a helper for symmetry with other installers and for a future Phase 2
// PermissionRequest matcher.
function matcherForZcodeEvent() {
  return null;
}

function isClawdHookCommand(command) {
  if (typeof command !== "string") return false;
  if (command.includes(MARKER)) return true;
  const decoded = decodeWindowsEncodedCommand(command);
  return !!(decoded && decoded.includes(MARKER));
}

// Detect Clawd's Claude hook (clawd-hook.js) that was imported into the zcode
// config. Matches both raw and PowerShell -EncodedCommand forms, like
// isClawdHookCommand does for the zcode marker.
function isClaudeHookCommand(command) {
  if (typeof command !== "string") return false;
  if (command.includes(CLAUDE_MARKER)) return true;
  const decoded = decodeWindowsEncodedCommand(command);
  return !!(decoded && decoded.includes(CLAUDE_MARKER));
}

// Strip Clawd's Claude hook entries (clawd-hook.js) migrated into the zcode
// config's hooks.events.* by a ZCode Claude-config import. This is a pure
// subtraction: clawd-hook.js uses an un-prefixed session_id + agent_id
// "claude-code", so removing it cannot merge into or corrupt any zcode
// session. Third-party hooks in the same entry are preserved.
//
// Returns { changed, removed } — removed counts stripped Clawd Claude commands
// (used only for reporting; it is NOT mixed into the register() added/updated
// counters, which track the zcode hooks specifically).
function stripMigratedClaudeHooks(events) {
  let changed = false;
  let removed = 0;
  if (!events || typeof events !== "object") return { changed, removed };

  for (const eventName of Object.keys(events)) {
    const entries = events[eventName];
    if (!Array.isArray(entries)) continue;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.command === "string" && isClaudeHookCommand(entry.command)) {
        entries.splice(i, 1);
        i--;
        removed++;
        changed = true;
        continue;
      }
      if (Array.isArray(entry.hooks)) {
        const before = entry.hooks.length;
        entry.hooks = entry.hooks.filter((h) => {
          if (h && typeof h.command === "string" && isClaudeHookCommand(h.command)) {
            removed++;
            changed = true;
            return false;
          }
          return true;
        });
        // Drop the entry entirely if it was a Clawd-only Claude entry now empty.
        if (entry.hooks.length === 0 && before > 0) {
          entries.splice(i, 1);
          i--;
        }
      }
    }
    if (entries.length === 0) delete events[eventName];
  }
  return { changed, removed };
}

// Mirror the Qwen / Antigravity Windows handling: wrap the command as a
// PowerShell -EncodedCommand so any shell that strips outer quotes (cmd /s)
// never mangles a node path containing a space.
function buildZcodeHookCommand(nodeBin, hookScript, event, options = {}) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    ...options,
    args: [event],
    windowsWrapper: "encoded",
  });
}

function buildZcodeHookEntry(command, event, options = {}) {
  const matcher = matcherForZcodeEvent(event);
  const hook = {
    type: "command",
    command,
    timeoutMs: timeoutMsForZcodeEvent(),
  };
  // `enabled` belongs on each hook object in ZCode's schema. Preserve an
  // explicit user opt-out when normalizing a stale Clawd command; omitting the
  // field is the canonical enabled form.
  if (options.enabled === false) hook.enabled = false;
  const entry = {
    hooks: [hook],
  };
  if (matcher !== null) entry.matcher = matcher;
  return entry;
}

function replaceEntry(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function isDesiredHookEntry(entry, desiredCommand, event, options = {}) {
  if (!entry || typeof entry !== "object") return false;
  const matcher = matcherForZcodeEvent(event);
  // The wrapper schema is strict: only matcher + hooks are valid. In our
  // matcherless canonical form that means exactly one `hooks` key. In
  // particular, entry-level enabled:false is invalid and must be removed;
  // the supported opt-out lives on the nested hook object.
  if (Object.keys(entry).some((key) => key !== "matcher" && key !== "hooks")) return false;
  if (matcher === null) {
    if (Object.prototype.hasOwnProperty.call(entry, "matcher")) return false;
  } else if (entry.matcher !== matcher) {
    return false;
  }
  return !!(
    Array.isArray(entry.hooks)
    && entry.hooks.length === 1
    && entry.hooks[0]
    // ZCode's hook schema is strict — a "name" key makes config.json fail to
    // load. Treat any entry still carrying "name" as not-desired so a re-run
    // strips it (migration from the pre-fix form).
    && !("name" in entry.hooks[0])
    && entry.hooks[0].type === "command"
    && entry.hooks[0].command === desiredCommand
    && (entry.hooks[0].enabled === false) === (options.enabled === false)
    // Must use timeoutMs (ms). A pre-fix entry carrying `timeout: 30000`
    // (8.3h under ZCode's seconds-semantics) is treated as not-desired so a
    // re-run rewrites it into the correct timeoutMs form.
    && entry.hooks[0].timeoutMs === timeoutMsForZcodeEvent()
  );
}

function managedHookIntent(entries) {
  let found = 0;
  let foundEnabled = false;
  if (!Array.isArray(entries)) return { found, enabled: true };

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    // Old flat command entries are not part of ZCode's current wrapper schema.
    // Treat them as enabled while migrating; entry-level `enabled` is not a
    // supported substitute for hook.enabled.
    if (isClawdHookCommand(entry.command)) {
      found++;
      foundEnabled = true;
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || !isClawdHookCommand(hook.command)) continue;
      found++;
      if (hook.enabled !== false) foundEnabled = true;
    }
  }

  return {
    found,
    enabled: found === 0 || foundEnabled,
  };
}

function normalizeHookEntries(entries, desiredCommand, event) {
  if (!Array.isArray(entries)) return { matched: false, changed: false };

  const intent = managedHookIntent(entries);
  const desiredOptions = { enabled: intent.enabled };
  let matched = false;
  let changed = false;
  let dedicatedIndex = -1;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;

    if (isClawdHookCommand(entry.command)) {
      matched = true;
      if (dedicatedIndex === -1) {
        replaceEntry(entry, buildZcodeHookEntry(desiredCommand, event, desiredOptions));
        dedicatedIndex = index;
        changed = true;
      } else {
        entries.splice(index, 1);
        index--;
        changed = true;
      }
      continue;
    }

    if (!Array.isArray(entry.hooks)) continue;
    const otherHooks = [];
    let clawdHookCount = 0;
    for (const hook of entry.hooks) {
      if (hook && isClawdHookCommand(hook.command)) clawdHookCount++;
      else otherHooks.push(hook);
    }
    if (clawdHookCount === 0) continue;

    matched = true;
    if (otherHooks.length > 0) {
      entry.hooks = otherHooks;
      changed = true;
      continue;
    }

    if (dedicatedIndex === -1) {
      if (!isDesiredHookEntry(entry, desiredCommand, event, desiredOptions)) {
        replaceEntry(entry, buildZcodeHookEntry(desiredCommand, event, desiredOptions));
        changed = true;
      }
      dedicatedIndex = index;
      continue;
    }

    entries.splice(index, 1);
    index--;
    changed = true;
  }

  if (!matched) return { matched: false, changed: false };

  if (dedicatedIndex === -1) {
    entries.push(buildZcodeHookEntry(desiredCommand, event, desiredOptions));
    return { matched: true, changed: true };
  }

  const dedicatedEntry = entries[dedicatedIndex];
  if (!isDesiredHookEntry(dedicatedEntry, desiredCommand, event, desiredOptions)) {
    replaceEntry(dedicatedEntry, buildZcodeHookEntry(desiredCommand, event, desiredOptions));
    changed = true;
  }
  return { matched: true, changed };
}

function readSettings(settingsPath) {
  try {
    return readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Failed to read config.json: ${err.message}`);
  }
}

function registerZcodeHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const parentDir = options.parentDir || path.join(homeDir, ".zcode");
  const settingsPath = options.settingsPath || path.join(parentDir, "cli", "config.json");

  if (!options.settingsPath && !fs.existsSync(parentDir)) {
    if (!options.silent) console.log("Clawd: ~/.zcode/ not found - skipping ZCode hook registration");
    return { added: 0, skipped: 0, updated: 0, warnings: [] };
  }

  const settings = readSettings(settingsPath);
  const warnings = [];

  const hookScript = asarUnpackedPath(path.resolve(__dirname, MARKER).replace(/\\/g, "/"));
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingZcodeNodeBin(settings, MARKER)
    || "node";

  let changed = false;

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  // Config-file hooks are disabled by default. Default an absent/malformed
  // value to true for a fresh install, but never override an explicit false:
  // this is ZCode's global runner switch and enabling it would also reactivate
  // unrelated user hooks.
  if (settings.hooks.enabled !== true && settings.hooks.enabled !== false) {
    settings.hooks.enabled = true;
    changed = true;
  }
  if (settings.hooks.enabled === false) {
    warnings.push("hooks.enabled=false; Clawd preserves this ZCode-wide user setting, so config-file hooks will not fire.");
  }
  if (!settings.hooks.events || typeof settings.hooks.events !== "object") {
    settings.hooks.events = {};
  }
  const events = settings.hooks.events;

  // Migration (#734): if the user imported their Claude config into ZCode,
  // Clawd's Claude hook (clawd-hook.js) may already be in hooks.events.* and
  // would fire alongside zcode-hook.js — producing a spurious Claude-Code
  // session for a real ZCode session. Strip those Clawd-owned entries first
  // (third-party hooks preserved, ~/.claude/settings.json untouched).
  const migrated = stripMigratedClaudeHooks(events);
  if (migrated.changed) changed = true;

  let added = 0;
  let skipped = 0;
  let updated = 0;
  const disabledManagedEvents = [];

  for (const event of ZCODE_HOOK_EVENTS) {
    const desiredCommand = buildZcodeHookCommand(
      nodeBin,
      hookScript,
      event,
      { platform: options.platform || process.platform }
    );

    if (!Array.isArray(events[event])) {
      events[event] = [];
      changed = true;
    }

    const existingIntent = managedHookIntent(events[event]);
    if (existingIntent.found > 0 && existingIntent.enabled === false) {
      disabledManagedEvents.push(event);
    }
    const result = normalizeHookEntries(events[event], desiredCommand, event);
    if (result.changed) changed = true;

    if (result.matched) {
      if (result.changed) updated++;
      else skipped++;
      continue;
    }

    events[event].push(buildZcodeHookEntry(desiredCommand, event));
    added++;
    changed = true;
  }
  if (disabledManagedEvents.length > 0) {
    warnings.push(`Clawd ZCode hooks remain disabled for: ${disabledManagedEvents.join(", ")}`);
  }

  if (changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd ZCode hooks -> ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
    if (migrated.removed > 0) {
      console.log(`  Migrated: removed ${migrated.removed} stale Clawd Claude hook(s) imported from Claude config`);
    }
    for (const warning of warnings) console.warn(`  Warning: ${warning}`);
  }

  return { added, skipped, updated, migratedClaudeHooks: migrated.removed, warnings };
}

function unregisterZcodeHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const parentDir = options.parentDir || path.join(homeDir, ".zcode");
  const settingsPath = options.settingsPath || path.join(parentDir, "cli", "config.json");

  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, settingsPath };
    throw new Error(`Failed to read config.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0, changed: false, settingsPath };
  }
  // Config-file hooks live under hooks.events.* (unlike plugin hooks.json).
  const events = settings.hooks.events;
  if (!events || typeof events !== "object") {
    return { removed: 0, changed: false, settingsPath };
  }

  let removed = 0;
  let changed = false;
  for (const event of ZCODE_HOOK_EVENTS) {
    const entries = events[event];
    if (!Array.isArray(entries)) continue;
    const result = removeMatchingCommandHooks(entries, isClawdHookCommand);
    if (!result.changed) continue;
    removed += result.removed;
    changed = true;
    if (result.entries.length > 0) events[event] = result.entries;
    else delete events[event];
  }

  // Also strip any Clawd Claude hooks (clawd-hook.js) imported from a Claude
  // config — they only ever produce spurious Claude-Code sessions here, so
  // uninstalling the ZCode integration removes them too. Third-party hooks
  // remain; ~/.claude/settings.json is never touched.
  const migrated = stripMigratedClaudeHooks(events);
  if (migrated.changed) {
    removed += migrated.removed;
    changed = true;
  }

  // If Clawd was the only config-file hook source, clean up the now-empty
  // hooks wrapper (drop the enabled flag + empty events object) so the user's
  // config.json is left pristine, not carrying a stale "enabled": true.
  if (changed) {
    const remainingEvents = Object.keys(events).filter((k) => Array.isArray(events[k]) && events[k].length > 0);
    if (remainingEvents.length === 0) {
      delete settings.hooks.events;
      // Only drop `enabled` if nothing else references it; since the runner is
      // only meaningful for config-file hooks (plugin hooks auto-enable), and
      // we own the only config-file hooks, it is safe to drop here.
      if (settings.hooks.enabled !== false) delete settings.hooks.enabled;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
  }

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(settingsPath, settings, options);
  if (!options.silent) console.log(`Clawd ZCode hooks removed: ${removed}`);
  const result = { removed, changed, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  MARKER,
  CLAUDE_MARKER,
  ZCODE_HOOK_EVENTS,
  buildZcodeHookCommand,
  matcherForZcodeEvent,
  registerZcodeHooks,
  unregisterZcodeHooks,
  timeoutMsForZcodeEvent,
  isClaudeHookCommand,
  stripMigratedClaudeHooks,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterZcodeHooks({});
    else registerZcodeHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
