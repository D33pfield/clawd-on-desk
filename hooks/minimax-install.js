#!/usr/bin/env node
// Install/uninstall the Clawd state-reporting plugin for MiniMax Code.
//
// MiniMax Code carries hooks inside local plugins discovered under
// `<dataDir>/plugins/` (default `~/.minimax/plugins`, honor `MINIMAX_DATA_DIR`).
// The whole plugin directory is Clawd-owned: install writes it in full,
// unregister removes it after an ownership check. A directory that exists but
// is not ours is never mutated — install fails closed, uninstall leaves it.
//
// Layout (Claude-compatible plugin manifest → hooks parse as CLAUDE source
// format, which supports the exec-form `args` we use to avoid every shell
// quoting pitfall on Windows):
//   clawd-state/.claude-plugin/plugin.json
//   clawd-state/hooks/hooks.json

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const { readJsonFile, writeJsonAtomic, asarUnpackedPath } = require("./json-utils");

const PLUGIN_DIR_NAME = "clawd-state";
const MARKER = "minimax-hook.js";
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".minimax");
const DEFAULT_PLUGIN_ROOT = path.join(DEFAULT_DATA_DIR, "plugins", PLUGIN_DIR_NAME);

// MiniMax's plugin hook event set (PLUGIN_HOOK_EVENTS). PermissionRequest is
// deliberately not registered: the plugin-hook runner caps every handler at
// 1–10 seconds (SessionEnd events get a 3s budget in total), so a blocking
// human-approval round trip is physically impossible. There is no Notification
// event.
const MINIMAX_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
];

// MiniMax parses `timeout` in whole seconds, clamped to 1–10. The hook answers
// stdout immediately and POSTs to Clawd with a 100ms budget, so 2s leaves
// ample headroom under the 3s SessionEnd event budget.
const HOOK_TIMEOUT_SECONDS = 2;

// `<dataDir>` resolution mirrors MiniMax's own precedence: a trimmed non-empty
// MINIMAX_DATA_DIR wins, otherwise `~/.minimax`.
function resolveMinimaxDataDir(homeDir) {
  const env = process.env.MINIMAX_DATA_DIR;
  if (typeof env === "string" && env.trim()) return env.trim();
  return path.join(homeDir || os.homedir(), ".minimax");
}

function resolvePluginRoot(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  if (options.pluginRoot) return options.pluginRoot;
  const dataDir = options.dataDir || resolveMinimaxDataDir(homeDir);
  return path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
}

function readOwnership(pluginRoot) {
  // Returns { owned: true } or { owned: false, reason }. "owned" requires a
  // parsable compatible manifest naming our plugin; the hook document may be
  // missing or corrupt (install repairs it), but a manifest we cannot read
  // means the directory is not demonstrably ours.
  let manifest;
  try {
    manifest = readJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
  } catch (err) {
    if (err.code === "ENOENT") return { owned: false, reason: "no-manifest" };
    return { owned: false, reason: "unreadable-manifest" };
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { owned: false, reason: "invalid-manifest" };
  }
  if (manifest.name !== PLUGIN_DIR_NAME) {
    return { owned: false, reason: "foreign-manifest" };
  }
  return { owned: true };
}

function desiredManifest() {
  return {
    name: PLUGIN_DIR_NAME,
    displayName: "Clawd on Desk",
    version: "1.0.0",
    description: "Reports MiniMax Code session state to the Clawd on Desk desktop pet.",
    hooks: ["hooks/hooks.json"],
  };
}

function desiredHooksDocument(hookScript, nodeBin) {
  // One group per event, matcher omitted (matches everything), exec-form
  // args so the command is spawned directly without a shell — identical
  // behavior on Windows/macOS/Linux and no quoting around paths with spaces.
  const handler = { type: "command", command: nodeBin, args: [hookScript], timeout: HOOK_TIMEOUT_SECONDS };
  const hooks = {};
  for (const event of MINIMAX_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [handler] }];
  }
  return { hooks };
}

/**
 * Install (or refresh) the Clawd MiniMax plugin directory.
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.homeDir] internal override for tests
 * @param {string} [options.dataDir] internal override for tests
 * @param {string} [options.pluginRoot] internal override for tests
 * @param {string} [options.nodeBin] internal override for tests
 * @returns {{ added: number, skipped: number, updated: number, pluginRoot: string }}
 */
function installMinimaxPlugin(options = {}) {
  const pluginRoot = resolvePluginRoot(options);
  const exists = fs.existsSync(pluginRoot);

  // An existing directory is only ever touched after the ownership check
  // passes; a directory without our manifest may be a foreign plugin (any
  // manifest kind) or unrelated user content — fail closed either way.
  if (exists) {
    const ownership = readOwnership(pluginRoot);
    if (!ownership.owned) {
      throw new Error(
        `Refusing to modify ${pluginRoot}: existing directory is not a Clawd plugin (${ownership.reason})`
      );
    }
  }

  // Skip when MiniMax Code has no data directory (not installed on this
  // machine) — do not create `~/.minimax` on behalf of an absent app.
  const dataDir = options.dataDir || resolveMinimaxDataDir(options.homeDir || os.homedir());
  if (!options.pluginRoot && !fs.existsSync(dataDir)) {
    if (!options.silent) console.log("Clawd: ~/.minimax/ not found — skipping MiniMax Code plugin install");
    return { added: 0, skipped: 0, updated: 0, pluginRoot };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "minimax-hook.js").replace(/\\/g, "/"));
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved || "node";

  const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
  const desired = {
    manifest: desiredManifest(),
    hooks: desiredHooksDocument(hookScript, nodeBin),
  };

  const existingHooks = exists
    ? (() => {
        try {
          return readJsonFile(hooksPath);
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const existingManifest = exists
    ? (() => {
        try {
          return readJsonFile(manifestPath);
        } catch {
          return undefined;
        }
      })()
    : undefined;

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  // Only rewrite files whose content actually changed: startup sync runs on
  // every launch for installed+enabled users, and unconditional writes would
  // churn mtimes even on a fully up-to-date install.
  if (JSON.stringify(existingManifest) !== JSON.stringify(desired.manifest)) {
    writeJsonAtomic(manifestPath, desired.manifest);
  }

  let result;
  const hooksUnchanged = exists && JSON.stringify(existingHooks) === JSON.stringify(desired.hooks);
  if (!exists) {
    writeJsonAtomic(hooksPath, desired.hooks);
    result = { added: MINIMAX_HOOK_EVENTS.length, skipped: 0, updated: 0 };
  } else if (hooksUnchanged) {
    result = { added: 0, skipped: MINIMAX_HOOK_EVENTS.length, updated: 0 };
  } else {
    writeJsonAtomic(hooksPath, desired.hooks);
    result = { added: 0, skipped: 0, updated: MINIMAX_HOOK_EVENTS.length };
  }

  if (!options.silent) {
    console.log(`Clawd MiniMax Code plugin → ${pluginRoot}`);
    console.log(`  Added: ${result.added}, updated: ${result.updated}, skipped: ${result.skipped}`);
    console.log("  If hooks do not fire, enable the plugin inside MiniMax Code (mcode plugin enable clawd-state@local).");
  }
  return { ...result, pluginRoot };
}

/**
 * Remove the Clawd MiniMax plugin directory after verifying ownership.
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.homeDir] internal override for tests
 * @param {string} [options.dataDir] internal override for tests
 * @param {string} [options.pluginRoot] internal override for tests
 * @returns {{ removed: number, changed: boolean, pluginRoot: string, reason?: string }}
 */
function unregisterMinimaxPlugin(options = {}) {
  const pluginRoot = resolvePluginRoot(options);
  if (!fs.existsSync(pluginRoot)) {
    return { removed: 0, changed: false, pluginRoot };
  }

  const ownership = readOwnership(pluginRoot);
  if (!ownership.owned) {
    // Not demonstrably ours — leave it alone, whatever it is.
    if (!options.silent) console.log(`Clawd: ${pluginRoot} is not a Clawd plugin — leaving it untouched`);
    return { removed: 0, changed: false, pluginRoot, reason: ownership.reason };
  }

  fs.rmSync(pluginRoot, { recursive: true, force: true });
  if (!options.silent) console.log(`Clawd MiniMax Code plugin removed: ${pluginRoot}`);
  return { removed: MINIMAX_HOOK_EVENTS.length, changed: true, pluginRoot };
}

module.exports = {
  DEFAULT_DATA_DIR,
  DEFAULT_PLUGIN_ROOT,
  MARKER,
  MINIMAX_HOOK_EVENTS,
  PLUGIN_DIR_NAME,
  installMinimaxPlugin,
  resolveMinimaxDataDir,
  unregisterMinimaxPlugin,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterMinimaxPlugin({});
    else installMinimaxPlugin({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
