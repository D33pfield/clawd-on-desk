#!/usr/bin/env node
// Install/remove Phase 0 Codex official-hooks debug sampler.
//
// This is deliberately not part of Clawd startup auto-sync. It only captures
// real Codex hook payloads to ~/.clawd/codex-hook-debug.jsonl for verification.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  writeJsonAtomic,
  asarUnpackedPath,
  extractExistingNodeBin,
  formatNodeHookCommand,
} = require("./json-utils");

const MARKER = "codex-debug-hook.js";
const CODEX_DEBUG_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
];

function timeoutForEvent(event) {
  return event === "PermissionRequest" ? 600 : 30;
}

function getCodexPaths(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const codexDir = options.codexDir || path.join(homeDir, ".codex");
  return {
    codexDir,
    hooksPath: options.hooksPath || path.join(codexDir, "hooks.json"),
    configPath: options.configPath || path.join(codexDir, "config.toml"),
  };
}

function buildCodexDebugHookCommand(nodeBin, hookScript, platform = process.platform) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    platform,
    // Codex already invokes hook commands through %COMSPEC% /C on Windows.
    // Keep the command itself as plain quoted node + script instead of adding
    // a nested cmd.exe layer that would make quote stripping harder to reason
    // about during Phase 0 payload capture.
    windowsWrapper: "none",
  });
}

function readJsonIfPresent(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Failed to read ${label}: ${err.message}`);
  }
}

function parseTomlTableHeader(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("[")) return null;

  const isArray = trimmed.startsWith("[[");
  let quote = null;
  const start = isArray ? 2 : 1;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (isArray) {
      if (ch !== "]" || trimmed[i + 1] !== "]") continue;
      const rest = trimmed.slice(i + 2).trim();
      if (rest && !rest.startsWith("#")) return null;
      return { name: trimmed.slice(start, i).trim(), array: true };
    }
    if (ch === "]") {
      const rest = trimmed.slice(i + 1).trim();
      if (rest && !rest.startsWith("#")) return null;
      return { name: trimmed.slice(start, i).trim(), array: false };
    }
  }
  return null;
}

function isFeaturesTableHeader(header) {
  return !!header && !header.array && header.name.replace(/\s+/g, "") === "features";
}

function ensureCodexHooksFeature(configPath) {
  let text = "";
  let existed = true;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      return { changed: false, warning: `Failed to read config.toml: ${err.message}` };
    }
    existed = false;
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.split(/\r?\n/) : [];
  let featuresStart = -1;
  let featuresEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const section = parseTomlTableHeader(lines[i]);
    if (!section) continue;
    if (isFeaturesTableHeader(section)) {
      featuresStart = i;
      continue;
    }
    if (featuresStart !== -1 && i > featuresStart) {
      featuresEnd = i;
      break;
    }
  }

  if (featuresStart !== -1) {
    for (let i = featuresStart + 1; i < featuresEnd; i++) {
      const match = lines[i].match(/^\s*codex_hooks\s*=\s*(true|false)\s*(?:#.*)?$/i);
      if (!match) continue;
      if (match[1].toLowerCase() === "false") {
        return {
          changed: false,
          warning: "config.toml already has [features].codex_hooks = false; leaving it unchanged.",
        };
      }
      return { changed: false, warning: null };
    }

    lines.splice(featuresStart + 1, 0, "codex_hooks = true");
  } else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push("[features]", "codex_hooks = true");
  }

  const nextText = `${lines.join(newline).replace(/\s*$/, "")}${newline}`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, nextText, "utf-8");
  return { changed: true, warning: existed ? null : null };
}

function findDebugHook(entry) {
  if (!entry || typeof entry !== "object") return null;
  const innerHooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  for (const hook of innerHooks) {
    if (!hook || typeof hook !== "object") continue;
    if (typeof hook.command === "string" && hook.command.includes(MARKER)) return hook;
  }
  if (typeof entry.command === "string" && entry.command.includes(MARKER)) return entry;
  return null;
}

function registerCodexDebugHooks(options = {}) {
  const { codexDir, hooksPath, configPath } = getCodexPaths(options);
  if (!options.hooksPath && !options.codexDir && !fs.existsSync(codexDir)) {
    if (!options.silent) console.log("Clawd: ~/.codex/ not found - skipping Codex debug hook registration");
    return { added: 0, skipped: 0, updated: 0, configChanged: false, warnings: [] };
  }

  const warnings = [];
  const feature = ensureCodexHooksFeature(configPath);
  if (feature.warning) warnings.push(feature.warning);

  const hookScript = asarUnpackedPath(path.resolve(__dirname, MARKER).replace(/\\/g, "/"));
  const settings = readJsonIfPresent(hooksPath, "hooks.json");
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER, { nested: true })
    || "node";
  const desiredCommand = buildCodexDebugHookCommand(
    nodeBin,
    hookScript,
    options.platform || process.platform
  );

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of CODEX_DEBUG_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stale = false;
    const desiredTimeout = timeoutForEvent(event);

    for (const entry of arr) {
      const hook = findDebugHook(entry);
      if (!hook) continue;
      found = true;
      if (hook.type !== "command") {
        hook.type = "command";
        stale = true;
      }
      if (hook.command !== desiredCommand) {
        hook.command = desiredCommand;
        stale = true;
      }
      if (hook.timeout !== desiredTimeout) {
        hook.timeout = desiredTimeout;
        stale = true;
      }
      break;
    }

    if (found) {
      if (stale) {
        updated++;
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    arr.push({
      hooks: [{ type: "command", command: desiredCommand, timeout: desiredTimeout }],
    });
    added++;
    changed = true;
  }

  if (changed) writeJsonAtomic(hooksPath, settings);

  if (!options.silent) {
    console.log(`Clawd Codex debug hooks -> ${hooksPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
    if (feature.changed) console.log(`  Enabled [features].codex_hooks in ${configPath}`);
    for (const warning of warnings) console.warn(`  Warning: ${warning}`);
  }

  return { added, skipped, updated, configChanged: feature.changed, warnings };
}

function unregisterCodexDebugHooks(options = {}) {
  const { hooksPath } = getCodexPaths(options);
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0 };
    throw new Error(`Failed to read hooks.json: ${err.message}`);
  }
  if (!settings.hooks || typeof settings.hooks !== "object") return { removed: 0 };

  let removed = 0;
  let changed = false;
  for (const event of CODEX_DEBUG_HOOK_EVENTS) {
    const arr = settings.hooks[event];
    if (!Array.isArray(arr)) continue;
    const next = arr.filter((entry) => !findDebugHook(entry));
    removed += arr.length - next.length;
    if (next.length !== arr.length) {
      settings.hooks[event] = next;
      changed = true;
    }
  }

  if (changed) writeJsonAtomic(hooksPath, settings);
  if (!options.silent) console.log(`Clawd Codex debug hooks removed: ${removed}`);
  return { removed };
}

module.exports = {
  CODEX_DEBUG_HOOK_EVENTS,
  buildCodexDebugHookCommand,
  ensureCodexHooksFeature,
  registerCodexDebugHooks,
  timeoutForEvent,
  unregisterCodexDebugHooks,
  __test: {
    parseTomlTableHeader,
  },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterCodexDebugHooks({});
    else registerCodexDebugHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
