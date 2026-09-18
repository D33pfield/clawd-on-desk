#!/usr/bin/env node
// Merge Clawd Cursor Agent hooks into ~/.cursor/hooks.json (marker-scoped, idempotent)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  CURSOR_HOOK_SENTINEL,
  decodeWindowsEncodedCommand,
  formatNodeHookCommand,
  stripUtf8Bom,
} = require("./json-utils");
const MARKER = "cursor-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".cursor");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks.json");

const CURSOR_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "afterAgentThought",
  "stop",
];

function resolveCursorHookScript() {
  return asarUnpackedPath(path.resolve(__dirname, "cursor-hook.js").replace(/\\/g, "/"));
}

function buildCursorHookCommand(nodeBin, hookScript, platform = process.platform) {
  // Cursor's Windows launcher is PowerShell (including its temp-file stdin
  // bridge). Calling Node directly preserves spaced paths; an extra cmd /s /c
  // round trip strips their quotes. Keep the marker visible in the command.
  return formatNodeHookCommand(nodeBin, hookScript, {
    platform,
    windowsWrapper: "powershell",
    args: [CURSOR_HOOK_SENTINEL],
  });
}

function parseSimpleCommandTokens(command) {
  if (typeof command !== "string" || !command.trim() || /[\r\n\0]/.test(command)) return null;
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    while (index < command.length && /\s/.test(command[index])) index++;
    if (index >= command.length) break;
    const quote = command[index] === '"' || command[index] === "'" ? command[index++] : null;
    let value = "";
    let closed = !quote;
    while (index < command.length) {
      const ch = command[index];
      if (quote) {
        if (ch === quote) {
          if (quote === "'" && command[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index++;
          closed = true;
          break;
        }
        if (quote === '"' && ch === "\\" && command[index + 1] === '"') {
          value += '"';
          index += 2;
          continue;
        }
        value += ch;
        index++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '"' || ch === "'") return null;
      value += ch;
      index++;
    }
    if (!closed || !value) return null;
    if (quote && index < command.length && !/\s/.test(command[index])) return null;
    tokens.push(value);
  }
  return tokens;
}

function unwrapCursorCommand(command) {
  const raw = typeof command === "string" ? command.trim() : "";
  if (!raw) return null;

  const encodedTokens = parseSimpleCommandTokens(raw);
  if (encodedTokens && encodedTokens.length >= 3) {
    const executable = encodedTokens[0].replace(/\\/g, "/").split("/").pop().toLowerCase();
    const encodedIndex = encodedTokens.findIndex((token) => /^-(?:encodedcommand|enc|e)$/i.test(token));
    const allowedPrefix = encodedTokens.slice(1, encodedIndex);
    const allowedSwitches = new Set(["-noprofile", "-noninteractive", "-executionpolicy", "bypass"]);
    if (
      (executable === "powershell" || executable === "powershell.exe")
      && encodedIndex > 0
      && encodedIndex === encodedTokens.length - 2
      && allowedPrefix.every((token) => allowedSwitches.has(token.toLowerCase()))
    ) {
      const decoded = decodeWindowsEncodedCommand(raw);
      if (decoded) return decoded;
    }
  }

  const cmdMatch = raw.match(/^cmd(?:\.exe)?\s+\/d\s+\/s\s+\/c\s+"([\s\S]*)"$/i);
  if (cmdMatch) return cmdMatch[1];
  return raw;
}

function canonicalCommandPath(value, platform = process.platform) {
  let normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (platform === "win32" || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function looksLikeNodeCommand(value) {
  const basename = String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  return basename === "node" || basename === "node.exe";
}

function isAbsoluteCommandPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:\//.test(normalized);
}

function classifyCursorHookCommand(command, expectedScript, platform = process.platform) {
  const raw = typeof command === "string" ? command : "";
  const broadMarker = raw.includes(MARKER) || Boolean((decodeWindowsEncodedCommand(raw) || "").includes(MARKER));
  let unwrapped = unwrapCursorCommand(raw);
  if (!unwrapped) return { classification: broadMarker ? "ambiguous" : "foreign", command: raw };
  unwrapped = unwrapped.trim();
  if (unwrapped.startsWith("&")) unwrapped = unwrapped.slice(1).trim();
  const tokens = parseSimpleCommandTokens(unwrapped);
  if (!tokens || (tokens.length !== 2 && tokens.length !== 3)) {
    return { classification: broadMarker ? "ambiguous" : "foreign", command: raw };
  }
  const [nodeBin, scriptPath, sentinel] = tokens;
  const exactScript = canonicalCommandPath(scriptPath, platform) === canonicalCommandPath(expectedScript, platform);
  const exactSentinel = tokens.length === 3 && sentinel === CURSOR_HOOK_SENTINEL;
  if (looksLikeNodeCommand(nodeBin) && exactScript && (tokens.length === 2 || exactSentinel)) {
    return {
      classification: "owned",
      command: raw,
      nodeBin,
      scriptPath,
      sentinel: exactSentinel,
    };
  }
  return { classification: broadMarker ? "ambiguous" : "foreign", command: raw };
}

function collectCursorCommandClassifications(settings, hookScript, platform) {
  const records = [];
  if (!settings || !settings.hooks || typeof settings.hooks !== "object") return records;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || typeof entry.command !== "string") return;
      records.push({ event, index, entry, ...classifyCursorHookCommand(entry.command, hookScript, platform) });
    });
  }
  return records;
}

function cursorHooksSourceMatches(hooksPath, expectedExists, expectedText) {
  try {
    const current = fs.readFileSync(hooksPath, "utf8");
    return expectedExists && current === expectedText;
  } catch (error) {
    if (error.code === "ENOENT") return !expectedExists;
    throw error;
  }
}

function cursorHooksChangedResult(hooksPath, counters = {}) {
  return {
    status: "error",
    reason: "cursor-hooks-changed",
    message: `Refusing to edit ${hooksPath}: hooks.json changed during the operation`,
    hooksPath,
    ...counters,
  };
}

/**
 * Register Clawd hooks into ~/.cursor/hooks.json
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.hooksPath]
 * @param {string} [options.homeDir] internal override for tests
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerCursorHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const hooksPath = options.hooksPath || path.join(homeDir, ".cursor", "hooks.json");

  // Skip if ~/.cursor/ doesn't exist (Cursor not installed) — unless caller overrides path
  if (!options.hooksPath) {
    const cursorDir = path.dirname(hooksPath);
    let exists = false;
    try { exists = fs.statSync(cursorDir).isDirectory(); } catch {}
    if (!exists) {
      if (!options.silent) console.log("Cursor not installed (~/.cursor/ not found) — skipping hook registration.");
      return { added: 0, skipped: 0, updated: 0 };
    }
  }
  const hookScript = resolveCursorHookScript();

  let settings = {};
  let hooksFileExists = true;
  let originalText = null;
  try {
    originalText = fs.readFileSync(hooksPath, "utf8");
    settings = JSON.parse(stripUtf8Bom(originalText));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read hooks.json: ${err.message}`);
    }
    hooksFileExists = false;
  }

  const platform = options.platform || process.platform;
  const classifications = collectCursorCommandClassifications(settings, hookScript, platform);
  const conflicts = classifications
    .filter((record) => record.classification === "ambiguous")
    .map(({ event, index, command }) => ({ event, index, command }));
  if (conflicts.length) {
    return {
      status: "error",
      reason: "cursor-hook-conflict",
      message: `Refusing to edit ${hooksPath}: ${conflicts.length} Cursor hook command(s) have ambiguous ownership`,
      conflicts,
      added: 0,
      skipped: 0,
      updated: 0,
      hooksPath,
    };
  }

  // Resolve node path; if detection fails, preserve existing absolute path
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const existingOwnedNode = classifications.find((record) => (
    record.classification === "owned" && isAbsoluteCommandPath(record.nodeBin)
  ));
  const nodeBin = resolved
    || (existingOwnedNode && existingOwnedNode.nodeBin)
    || "node";
  const desiredCommand = buildCursorHookCommand(
    nodeBin,
    hookScript,
    platform
  );

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  if (typeof settings.version !== "number") settings.version = 1;

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of CURSOR_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let ownedEntry = null;
    let needsUpdate = false;
    const kept = [];
    for (const entry of arr) {
      const classification = entry && typeof entry === "object"
        ? classifyCursorHookCommand(entry.command, hookScript, platform)
        : { classification: "foreign" };
      if (classification.classification !== "owned") {
        kept.push(entry);
        continue;
      }
      // Repair duplicates left by installers that could not recognize an
      // EncodedCommand marker. Retain the first owned entry's other settings.
      if (ownedEntry) {
        needsUpdate = true;
        continue;
      }
      ownedEntry = entry;
      kept.push(entry);
      if (entry.command !== desiredCommand) {
        entry.command = desiredCommand;
        needsUpdate = true;
      }
    }

    if (ownedEntry) {
      if (needsUpdate) {
        settings.hooks[event] = kept;
        updated++;
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    arr.push({ command: desiredCommand });
    added++;
    changed = true;
  }

  if (added > 0 || changed) {
    if (!cursorHooksSourceMatches(hooksPath, hooksFileExists, originalText)) {
      return cursorHooksChangedResult(hooksPath, { added: 0, skipped: 0, updated: 0 });
    }
    if (hooksFileExists) writeJsonAtomicWithBackup(hooksPath, settings, { ...options, backup: true });
    else writeJsonAtomic(hooksPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Cursor hooks → ${hooksPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

function unregisterCursorHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const hooksPath = options.hooksPath || path.join(homeDir, ".cursor", "hooks.json");

  let settings = {};
  let originalText = null;
  try {
    originalText = fs.readFileSync(hooksPath, "utf8");
    settings = JSON.parse(stripUtf8Bom(originalText));
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, hooksPath };
    throw new Error(`Failed to read hooks.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0, changed: false, hooksPath };
  }

  const hookScript = resolveCursorHookScript();
  const platform = options.platform || process.platform;
  const classifications = collectCursorCommandClassifications(settings, hookScript, platform);
  const conflicts = classifications
    .filter((record) => record.classification === "ambiguous")
    .map(({ event, index, command }) => ({ event, index, command }));
  if (conflicts.length) {
    return {
      status: "error",
      reason: "cursor-hook-conflict",
      message: `Refusing to edit ${hooksPath}: ${conflicts.length} Cursor hook command(s) have ambiguous ownership`,
      conflicts,
      removed: 0,
      changed: false,
      hooksPath,
    };
  }

  let removed = 0;
  let changed = false;
  for (const event of CURSOR_HOOK_EVENTS) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => {
      const classification = entry && typeof entry === "object"
        ? classifyCursorHookCommand(entry.command, hookScript, platform)
        : { classification: "foreign" };
      if (classification.classification !== "owned") return true;
      removed++;
      return false;
    });
    if (kept.length === entries.length) continue;
    changed = true;
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }

  let backupPath = null;
  if (changed) {
    if (!cursorHooksSourceMatches(hooksPath, true, originalText)) {
      return cursorHooksChangedResult(hooksPath, { removed: 0, changed: false });
    }
    backupPath = writeJsonAtomicWithBackup(hooksPath, settings, options);
  }
  if (!options.silent) console.log(`Clawd Cursor hooks removed: ${removed}`);
  const result = { removed, changed, hooksPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  registerCursorHooks,
  unregisterCursorHooks,
  CURSOR_HOOK_EVENTS,
  CURSOR_HOOK_SENTINEL,
  buildCursorHookCommand,
  classifyCursorHookCommand,
  resolveCursorHookScript,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterCursorHooks({});
    else registerCursorHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
