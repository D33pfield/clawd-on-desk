#!/usr/bin/env node
// Install/uninstall the Clawd state-reporting plugin for MiniMax Code.
//
// MiniMax Code carries hooks inside local plugins discovered under
// `<dataDir>/plugins/` (default `~/.minimax/plugins`, honor `MINIMAX_DATA_DIR`
// and `MAVIS_DATA_DIR`). The whole plugin directory is Clawd-owned: install
// writes it in full, unregister removes it after an ownership check. A
// directory that exists but is not provably ours is never mutated — install
// fails closed, uninstall leaves it.
//
// Ownership is proven by a structured marker file (`.clawd-managed.json`, the
// same convention as the Pi extension) — never by a directory name, a manifest
// name, or a basename appearing somewhere in a document. MiniMax ignores files
// its manifest does not reference, so the marker never reaches its loader.
// Directories written by the first MiniMax build (before the marker existed)
// are adopted only when their manifest and hooks document match, field for
// field, the exact shape that build generated; the next install adds the marker.
//
// Layout (Claude-compatible plugin manifest → hooks parse as CLAUDE source
// format, which supports the exec-form `args` we use to avoid every shell
// quoting pitfall on Windows):
//   clawd-state/.clawd-managed.json
//   clawd-state/.claude-plugin/plugin.json
//   clawd-state/hooks/hooks.json

const fs = require("fs");
const path = require("path");
const os = require("os");
const { isDeepStrictEqual } = require("util");
const { resolveNodeBin } = require("./server-config");
const { readJsonFile, writeJsonAtomic, asarUnpackedPath } = require("./json-utils");

const PLUGIN_DIR_NAME = "clawd-state";
const MARKER = "minimax-hook.js";
const OWNER_MARKER_FILE = ".clawd-managed.json";
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

// MiniMax parses `timeout` as whole seconds and drops any handler whose value
// is not an integer in 1–10 (it is rejected, not clamped). The hook answers
// stdout immediately and POSTs to Clawd with a 100ms budget, so 2s leaves
// ample headroom under the 3s SessionEnd event budget.
const HOOK_TIMEOUT_SECONDS = 2;

// `<dataDir>` resolution mirrors MiniMax's own precedence (v0.5.1):
// MINIMAX_DATA_DIR → MAVIS_DATA_DIR → `~/.minimax`. Installer, uninstaller,
// cleanup, installation detection, and Doctor all resolve through this single
// helper so a custom data dir can never strand the plugin in a place another
// code path does not look at.
function resolveMinimaxDataDir(homeDir, env) {
  const source = env || process.env;
  for (const key of ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"]) {
    const value = typeof source[key] === "string" ? source[key].trim() : "";
    if (value) return value;
  }
  return path.join(homeDir || os.homedir(), ".minimax");
}

function resolvePluginRoot(options = {}) {
  if (options.pluginRoot) return options.pluginRoot;
  const dataDir = options.dataDir
    || resolveMinimaxDataDir(options.homeDir || os.homedir(), options.env);
  return path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
}

// Read a JSON file through an injectable fs (Doctor passes the harness fs).
function readJsonWith(fsImpl, filePath) {
  return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// lstat (so a symlinked root is seen as a link, not as its target). Falls back
// to stat for injected fs shims that do not implement lstatSync.
function lstatOrNull(fsImpl, targetPath) {
  try {
    return typeof fsImpl.lstatSync === "function"
      ? fsImpl.lstatSync(targetPath)
      : fsImpl.statSync(targetPath);
  } catch {
    return null;
  }
}

function fileExistsWith(fsImpl, filePath) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function buildOwnerMarker() {
  return {
    app: "clawd-on-desk",
    integration: "minimax",
    managed: true,
    version: 1,
  };
}

function isOwnerMarker(value) {
  return isPlainObject(value)
    && value.app === "clawd-on-desk"
    && value.integration === "minimax"
    && value.managed === true;
}

function isAbsoluteCommandPath(value) {
  return typeof value === "string"
    && value.length > 0
    && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}

function isHookScriptArg(value) {
  if (!isAbsoluteCommandPath(value)) return false;
  return value.replace(/\\/g, "/").endsWith(`/hooks/${MARKER}`);
}

// The exact hooks document the first (pre-marker) MiniMax build generated:
// every registered event, one matcher-less group each, one exec-form handler
// each, all pointing at the same node binary and minimax-hook.js script with
// the fixed timeout. Anything else — an extra handler, a matcher, a different
// timeout, a missing event, a foreign command — is not this document.
function isLegacyGeneratedHooksDocument(hooks) {
  if (!isPlainObject(hooks) || Object.keys(hooks).length !== 1 || !isPlainObject(hooks.hooks)) return false;
  const events = Object.keys(hooks.hooks);
  if (events.length !== MINIMAX_HOOK_EVENTS.length) return false;
  if (!MINIMAX_HOOK_EVENTS.every((event) => events.includes(event))) return false;
  let signature = null;
  for (const event of MINIMAX_HOOK_EVENTS) {
    const groups = hooks.hooks[event];
    if (!Array.isArray(groups) || groups.length !== 1) return false;
    const group = groups[0];
    if (!isPlainObject(group) || Object.keys(group).length !== 1) return false;
    if (!Array.isArray(group.hooks) || group.hooks.length !== 1) return false;
    const handler = group.hooks[0];
    if (!isPlainObject(handler)) return false;
    if (Object.keys(handler).sort().join(",") !== "args,command,timeout,type") return false;
    if (handler.type !== "command" || typeof handler.command !== "string" || !handler.command) return false;
    if (handler.timeout !== HOOK_TIMEOUT_SECONDS) return false;
    if (!Array.isArray(handler.args) || handler.args.length !== 1 || !isHookScriptArg(handler.args[0])) return false;
    const current = `${handler.command}\u0000${handler.args[0]}`;
    if (signature === null) signature = current;
    else if (current !== signature) return false;
  }
  return true;
}

function readOwnership(pluginRoot, fsImpl) {
  // Returns { owned: true, via: "marker" | "legacy" } or { owned: false, reason }.
  const f = fsImpl || fs;
  const rootStat = lstatOrNull(f, pluginRoot);
  if (!rootStat) return { owned: false, reason: "missing" };
  // MiniMax itself refuses symlinked plugin roots, and following one would let
  // install write into — or uninstall recurse through — an arbitrary target.
  if (typeof rootStat.isSymbolicLink === "function" && rootStat.isSymbolicLink()) {
    return { owned: false, reason: "symlink-root" };
  }
  if (!rootStat.isDirectory()) return { owned: false, reason: "not-a-directory" };

  let marker;
  try {
    marker = readJsonWith(f, path.join(pluginRoot, OWNER_MARKER_FILE));
  } catch (err) {
    if (!(err && err.code === "ENOENT")) return { owned: false, reason: "unreadable-owner-marker" };
  }
  if (marker !== undefined) {
    return isOwnerMarker(marker)
      ? { owned: true, via: "marker" }
      : { owned: false, reason: "foreign-owner-marker" };
  }

  // No marker: only the exact document the pre-marker build generated counts.
  let manifest;
  try {
    manifest = readJsonWith(f, path.join(pluginRoot, ".claude-plugin", "plugin.json"));
  } catch (err) {
    if (err && err.code === "ENOENT") return { owned: false, reason: "no-manifest" };
    return { owned: false, reason: "unreadable-manifest" };
  }
  if (!isPlainObject(manifest)) return { owned: false, reason: "invalid-manifest" };
  if (manifest.name !== PLUGIN_DIR_NAME) return { owned: false, reason: "foreign-manifest" };
  let hooks;
  try {
    hooks = readJsonWith(f, path.join(pluginRoot, "hooks", "hooks.json"));
  } catch (err) {
    if (err && err.code === "ENOENT") return { owned: false, reason: "no-hooks-document" };
    return { owned: false, reason: "unreadable-hooks" };
  }
  if (!isDeepStrictEqual(manifest, desiredManifest()) || !isLegacyGeneratedHooksDocument(hooks)) {
    return { owned: false, reason: "missing-marker" };
  }
  return { owned: true, via: "legacy" };
}

function resolveHookScriptPath() {
  return asarUnpackedPath(path.resolve(__dirname, "minimax-hook.js").replace(/\\/g, "/"));
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

// The node binary an earlier install recorded in an existing hooks document:
// the absolute command of a handler that runs our hook script.
function extractExistingNodeBin(hooks) {
  if (!isPlainObject(hooks) || !isPlainObject(hooks.hooks)) return null;
  for (const groups of Object.values(hooks.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const handlers = isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
      for (const handler of handlers) {
        if (!isPlainObject(handler) || !Array.isArray(handler.args)) continue;
        if (!isHookScriptArg(handler.args[0])) continue;
        if (isAbsoluteCommandPath(handler.command)) return handler.command;
      }
    }
  }
  return null;
}

// The node binary the hooks document should name. When detection comes back
// empty (a login shell that timed out, an unusual install location), keep the
// absolute path an earlier install recorded — as the TraeCode / Qoder /
// QwenWork / WorkBuddy installers do — rather than degrading to bare "node":
// exec-form handlers are spawned without a shell, and a desktop app launched
// from the Dock has no node on its PATH, so a bare "node" silently disables
// every hook. Installer and Doctor share this so they never disagree.
function resolveDesiredNodeBin(options = {}) {
  const detect = typeof options.resolveNodeBin === "function" ? options.resolveNodeBin : resolveNodeBin;
  const resolved = options.nodeBin !== undefined ? options.nodeBin : detect();
  if (resolved) return resolved;
  const recorded = extractExistingNodeBin(options.existingHooks);
  if (recorded && fileExistsWith(options.fs || fs, recorded)) return recorded;
  return "node";
}

function readJsonOrUndefined(filePath) {
  try {
    return readJsonFile(filePath);
  } catch {
    return undefined;
  }
}

/**
 * Install (or refresh) the Clawd MiniMax plugin directory.
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.homeDir] internal override for tests
 * @param {string} [options.dataDir] internal override for tests
 * @param {string} [options.pluginRoot] internal override for tests
 * @param {string|null} [options.nodeBin] internal override for tests (null = detection failed)
 * @param {Function} [options.writeJsonAtomic] internal override for tests
 * @returns {{ added: number, skipped: number, updated: number, pluginRoot: string, ownerMarkerAdded?: boolean }}
 */
function installMinimaxPlugin(options = {}) {
  const pluginRoot = resolvePluginRoot(options);
  const writeJson = typeof options.writeJsonAtomic === "function" ? options.writeJsonAtomic : writeJsonAtomic;
  const exists = lstatOrNull(fs, pluginRoot) !== null;

  // An existing directory is only ever touched after the ownership check
  // passes; anything not provably ours (foreign plugin of any manifest kind,
  // unrelated user content, a symlink) fails closed.
  let ownership = null;
  if (exists) {
    ownership = readOwnership(pluginRoot);
    if (!ownership.owned) {
      throw new Error(
        `Refusing to modify ${pluginRoot}: existing directory is not a Clawd plugin (${ownership.reason})`
      );
    }
  }

  // Skip when MiniMax Code has no data directory (not installed on this
  // machine) — do not create `~/.minimax` on behalf of an absent app.
  const dataDir = options.dataDir
    || resolveMinimaxDataDir(options.homeDir || os.homedir(), options.env);
  if (!options.pluginRoot && !fs.existsSync(dataDir)) {
    if (!options.silent) {
      console.log(`Clawd: ${dataDir} not found — skipping MiniMax Code plugin install`);
    }
    return { added: 0, skipped: 0, updated: 0, pluginRoot };
  }

  const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
  const existingHooks = exists ? readJsonOrUndefined(hooksPath) : undefined;
  const existingManifest = exists ? readJsonOrUndefined(manifestPath) : undefined;
  const nodeBin = resolveDesiredNodeBin({ nodeBin: options.nodeBin, existingHooks });
  const desired = {
    manifest: desiredManifest(),
    hooks: desiredHooksDocument(resolveHookScriptPath(), nodeBin),
  };

  fs.mkdirSync(pluginRoot, { recursive: true });
  // The ownership marker is written first: if a later write fails (disk
  // full, permission, a crash between writes), the half-written directory is
  // still provably ours and the next install repairs it instead of refusing
  // it forever. A legacy directory gains its marker here.
  const ownerMarkerAdded = !ownership || ownership.via !== "marker";
  if (ownerMarkerAdded) writeJson(path.join(pluginRoot, OWNER_MARKER_FILE), buildOwnerMarker());

  // Only rewrite files whose content actually changed: startup sync runs on
  // every launch for installed+enabled users, and unconditional writes would
  // churn mtimes even on a fully up-to-date install.
  if (!isDeepStrictEqual(existingManifest, desired.manifest)) {
    writeJson(manifestPath, desired.manifest);
  }

  let result;
  if (!exists) {
    writeJson(hooksPath, desired.hooks);
    result = { added: MINIMAX_HOOK_EVENTS.length, skipped: 0, updated: 0 };
  } else if (isDeepStrictEqual(existingHooks, desired.hooks)) {
    result = { added: 0, skipped: MINIMAX_HOOK_EVENTS.length, updated: 0 };
  } else {
    writeJson(hooksPath, desired.hooks);
    result = { added: 0, skipped: 0, updated: MINIMAX_HOOK_EVENTS.length };
  }

  if (!options.silent) {
    console.log(`Clawd MiniMax Code plugin → ${pluginRoot}`);
    console.log(`  Added: ${result.added}, updated: ${result.updated}, skipped: ${result.skipped}`);
    console.log("  If hooks do not fire, enable the plugin inside MiniMax Code (mcode plugin enable clawd-state@local).");
  }
  return exists && ownerMarkerAdded
    ? { ...result, pluginRoot, ownerMarkerAdded: true }
    : { ...result, pluginRoot };
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
  if (lstatOrNull(fs, pluginRoot) === null) {
    return { removed: 0, changed: false, pluginRoot };
  }

  const ownership = readOwnership(pluginRoot);
  if (!ownership.owned) {
    // Not provably ours — leave it alone, whatever it is.
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
  HOOK_TIMEOUT_SECONDS,
  MARKER,
  MINIMAX_HOOK_EVENTS,
  OWNER_MARKER_FILE,
  PLUGIN_DIR_NAME,
  buildDesiredHooksDocument: desiredHooksDocument,
  buildOwnerMarker,
  desiredManifest,
  extractExistingNodeBin,
  installMinimaxPlugin,
  isOwnerMarker,
  readOwnership,
  resolveDesiredNodeBin,
  resolveHookScriptPath,
  resolveMinimaxDataDir,
  resolvePluginRoot,
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
