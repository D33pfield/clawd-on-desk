#!/usr/bin/env node
// Install/uninstall the Clawd state-reporting plugin for MiniMax Code.
//
// MiniMax Code carries hooks inside local plugins discovered under
// `<dataDir>/plugins/` (default `~/.minimax/plugins`, honor `MINIMAX_DATA_DIR`
// and `MAVIS_DATA_DIR`). The whole plugin directory is Clawd-owned: install
// writes it in full, unregister removes it after an ownership check. A
// directory that exists but is not provably ours is never mutated — install
// fails closed, uninstall leaves it and reports it.
//
// Ownership is proven only by a structured marker file (`.clawd-managed.json`,
// the Pi extension's convention) — never by a directory name, a manifest name,
// or a basename appearing somewhere in a document — and only when neither the
// marker nor any other managed path is a symbolic link. MiniMax ignores files
// its manifest does not reference, so the marker never reaches its loader.
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
const OWNER_MARKER_VERSION = 1;
// Every path Clawd reads ownership from or writes through.
const MANAGED_PATHS = [
  OWNER_MARKER_FILE,
  ".claude-plugin",
  path.join(".claude-plugin", "plugin.json"),
  "hooks",
  path.join("hooks", "hooks.json"),
];
// Staging / removal directories live beside `plugins/` (in the data directory
// itself), so MiniMax's plugin scan never sees a half-built or half-removed
// plugin, while a same-filesystem rename still publishes or retires it at once.
const STAGING_PREFIX = ".clawd-minimax-staging-";
const REMOVAL_PREFIX = ".clawd-minimax-removing-";
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

function resolveDataDir(options = {}) {
  return options.dataDir || resolveMinimaxDataDir(options.homeDir || os.homedir(), options.env);
}

function resolvePluginRoot(options = {}) {
  if (options.pluginRoot) return options.pluginRoot;
  return path.join(resolveDataDir(options), "plugins", PLUGIN_DIR_NAME);
}

// Where staging and removal directories go: the data directory (outside
// `plugins/`), or the plugin root's parent when a test pins the root directly.
function resolveWorkParent(options = {}) {
  return options.pluginRoot ? path.dirname(options.pluginRoot) : resolveDataDir(options);
}

// Read a JSON file through an injectable fs (Doctor passes the harness fs).
function readJsonWith(fsImpl, filePath) {
  return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// lstat (so a symlink is seen as a link, not as its target). Falls back to
// stat for injected fs shims that do not implement lstatSync.
function lstatOrNull(fsImpl, targetPath) {
  try {
    return typeof fsImpl.lstatSync === "function"
      ? fsImpl.lstatSync(targetPath)
      : fsImpl.statSync(targetPath);
  } catch {
    return null;
  }
}

function isSymlinkStat(stat) {
  return !!stat && typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink();
}

function buildOwnerMarker() {
  return {
    app: "clawd-on-desk",
    integration: "minimax",
    managed: true,
    version: OWNER_MARKER_VERSION,
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

// The `command` of every handler that runs Clawd's hook script (its first
// exec-form argument is an absolute path to hooks/minimax-hook.js).
function clawdHookCommands(hooks) {
  const commands = [];
  if (!isPlainObject(hooks) || !isPlainObject(hooks.hooks)) return commands;
  for (const groups of Object.values(hooks.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const handlers = isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
      for (const handler of handlers) {
        if (!isPlainObject(handler) || !Array.isArray(handler.args)) continue;
        if (isHookScriptArg(handler.args[0])) commands.push(handler.command);
      }
    }
  }
  return commands;
}

function readOwnership(pluginRoot, fsImpl) {
  // Returns { owned: true } or { owned: false, reason }.
  const f = fsImpl || fs;
  const rootStat = lstatOrNull(f, pluginRoot);
  if (!rootStat) return { owned: false, reason: "missing" };
  // MiniMax itself refuses symlinked plugin roots, and following one would let
  // install write into — or uninstall recurse through — an arbitrary target.
  if (isSymlinkStat(rootStat)) return { owned: false, reason: "symlink-root" };
  if (!rootStat.isDirectory()) return { owned: false, reason: "not-a-directory" };
  // Ownership is only ever read from, and files only ever written through,
  // real paths inside this directory: a linked marker could borrow a Clawd
  // marker from elsewhere, and a linked `hooks/` would carry a Repair outside.
  for (const relative of MANAGED_PATHS) {
    if (isSymlinkStat(lstatOrNull(f, path.join(pluginRoot, relative)))) {
      return { owned: false, reason: "symlinked-managed-path" };
    }
  }

  const markerPath = path.join(pluginRoot, OWNER_MARKER_FILE);
  const markerStat = lstatOrNull(f, markerPath);
  if (!markerStat) return { owned: false, reason: "missing-marker" };
  if (!markerStat.isFile()) return { owned: false, reason: "owner-marker-not-a-file" };
  let marker;
  try {
    marker = readJsonWith(f, markerPath);
  } catch {
    return { owned: false, reason: "unreadable-owner-marker" };
  }
  if (!isOwnerMarker(marker)) return { owned: false, reason: "foreign-owner-marker" };
  if (marker.version !== OWNER_MARKER_VERSION) return { owned: false, reason: "unsupported-owner-marker-version" };
  return { owned: true };
}

// Whether the directory's hooks document still runs Clawd's hook: true /
// false, or null when that cannot be read without following a link.
function hooksReferenceClawdHook(pluginRoot, fsImpl) {
  const f = fsImpl || fs;
  for (const relative of ["hooks", path.join("hooks", "hooks.json")]) {
    if (isSymlinkStat(lstatOrNull(f, path.join(pluginRoot, relative)))) return null;
  }
  let hooks;
  try {
    hooks = readJsonWith(f, path.join(pluginRoot, "hooks", "hooks.json"));
  } catch (err) {
    return err && err.code === "ENOENT" ? false : null;
  }
  return clawdHookCommands(hooks).length > 0;
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

const NODE_BASENAME_RE = /^node(js)?(\.exe)?$/i;

// The node binary an earlier install recorded: every handler that runs our
// hook script must name the same absolute path, and it must be named like a
// Node binary. A mixed or edited document proves nothing and yields null.
function recordedNodeBin(hooks) {
  const commands = clawdHookCommands(hooks);
  if (commands.length === 0 || new Set(commands).size !== 1) return null;
  const command = commands[0];
  if (!isAbsoluteCommandPath(command)) return null;
  const basename = command.replace(/\\/g, "/").split("/").pop();
  return NODE_BASENAME_RE.test(basename) ? command : null;
}

function isExecutableFile(fsImpl, filePath) {
  try {
    if (!fsImpl.statSync(filePath).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32" || typeof fsImpl.accessSync !== "function") return true;
  try {
    fsImpl.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The node binary the hooks document should name. When detection comes back
// empty (a login shell that timed out, an unusual install location), keep the
// node path an earlier install recorded — as the TraeCode / Qoder / QwenWork /
// WorkBuddy installers do — rather than degrading to bare "node": exec-form
// handlers are spawned without a shell, and a desktop app launched from the
// Dock has no node on its PATH, so a bare "node" silently disables every hook.
// Installer and Doctor share this so they never disagree.
function resolveDesiredNodeBin(options = {}) {
  const detect = typeof options.resolveNodeBin === "function" ? options.resolveNodeBin : resolveNodeBin;
  const resolved = options.nodeBin !== undefined ? options.nodeBin : detect();
  if (resolved) return resolved;
  const recorded = recordedNodeBin(options.existingHooks);
  if (recorded && isExecutableFile(options.fs || fs, recorded)) return recorded;
  return "node";
}

function readJsonOrUndefined(filePath) {
  try {
    return readJsonFile(filePath);
  } catch {
    return undefined;
  }
}

function uniqueWorkPath(parent, prefix) {
  return path.join(parent, `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
}

// A first install is assembled in a staging directory and published with one
// rename, so MiniMax — and the next install — only ever sees no plugin or a
// complete, marked one. A failure at any step removes the staging directory
// and leaves nothing behind that could strand the next attempt.
function publishFreshPlugin(pluginRoot, workParent, desired, writeJson) {
  fs.mkdirSync(path.dirname(pluginRoot), { recursive: true });
  fs.mkdirSync(workParent, { recursive: true });
  const staging = uniqueWorkPath(workParent, STAGING_PREFIX);
  fs.mkdirSync(staging);
  try {
    writeJson(path.join(staging, OWNER_MARKER_FILE), buildOwnerMarker());
    writeJson(path.join(staging, ".claude-plugin", "plugin.json"), desired.manifest);
    writeJson(path.join(staging, "hooks", "hooks.json"), desired.hooks);
    fs.renameSync(staging, pluginRoot);
  } catch (err) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
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
 * @returns {{ added: number, skipped: number, updated: number, pluginRoot: string }}
 */
function installMinimaxPlugin(options = {}) {
  const pluginRoot = resolvePluginRoot(options);
  const writeJson = typeof options.writeJsonAtomic === "function" ? options.writeJsonAtomic : writeJsonAtomic;
  const exists = lstatOrNull(fs, pluginRoot) !== null;

  // An existing directory is only ever touched after the ownership check
  // passes; anything not provably ours (foreign plugin of any manifest kind,
  // unrelated user content, an unmarked pre-release install, a symlink) fails
  // closed.
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
  const dataDir = resolveDataDir(options);
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

  let result;
  if (!exists) {
    publishFreshPlugin(pluginRoot, resolveWorkParent(options), desired, writeJson);
    result = { added: MINIMAX_HOOK_EVENTS.length, skipped: 0, updated: 0 };
  } else {
    // An owned directory (valid marker, no linked managed path) is refreshed
    // in place. Its marker already exists, so a refresh interrupted between
    // the per-file atomic writes stays provably ours and the next install
    // finishes it. Only files whose content changed are rewritten: startup
    // sync runs on every launch for installed+enabled users.
    if (!isDeepStrictEqual(existingManifest, desired.manifest)) {
      writeJson(manifestPath, desired.manifest);
    }
    if (isDeepStrictEqual(existingHooks, desired.hooks)) {
      result = { added: 0, skipped: MINIMAX_HOOK_EVENTS.length, updated: 0 };
    } else {
      writeJson(hooksPath, desired.hooks);
      result = { added: 0, skipped: 0, updated: MINIMAX_HOOK_EVENTS.length };
    }
  }

  if (!options.silent) {
    console.log(`Clawd MiniMax Code plugin → ${pluginRoot}`);
    console.log(`  Added: ${result.added}, updated: ${result.updated}, skipped: ${result.skipped}`);
    console.log("  If hooks do not fire, enable the plugin inside MiniMax Code (mcode plugin enable clawd-state@local).");
  }
  return { ...result, pluginRoot };
}

// Uninstall result for a directory Clawd will not delete. When that directory
// still runs Clawd's hook (or that cannot be read), the registration is not
// gone: report registrationRemoved false / null with the exact path so
// Settings and About cleanup keep the install intent and tell the user.
function refusedUninstallResult(pluginRoot, reason) {
  const runsClawdHook = hooksReferenceClawdHook(pluginRoot);
  if (runsClawdHook === false) {
    return { removed: 0, changed: false, pluginRoot, reason, registrationRemoved: true };
  }
  return {
    removed: 0,
    changed: false,
    pluginRoot,
    reason,
    registrationRemoved: runsClawdHook === true ? false : null,
    activeEntryRemaining: runsClawdHook === true ? true : null,
    residualPaths: [pluginRoot],
    message: `${pluginRoot} ${runsClawdHook === true ? "still runs" : "may still run"} Clawd's MiniMax hook, `
      + `but Clawd cannot prove it owns that directory (${reason}), so it was left untouched. `
      + "Delete the directory manually to finish uninstalling.",
  };
}

/**
 * Remove the Clawd MiniMax plugin directory after verifying ownership.
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.homeDir] internal override for tests
 * @param {string} [options.dataDir] internal override for tests
 * @param {string} [options.pluginRoot] internal override for tests
 * @returns {{ removed: number, changed: boolean, pluginRoot: string, registrationRemoved: boolean|null, reason?: string }}
 */
function unregisterMinimaxPlugin(options = {}) {
  const pluginRoot = resolvePluginRoot(options);
  if (lstatOrNull(fs, pluginRoot) === null) {
    return { removed: 0, changed: false, pluginRoot, registrationRemoved: true };
  }

  const ownership = readOwnership(pluginRoot);
  if (!ownership.owned) {
    if (!options.silent) console.log(`Clawd: ${pluginRoot} is not a Clawd plugin — leaving it untouched`);
    return refusedUninstallResult(pluginRoot, ownership.reason);
  }

  // Move the verified directory out of MiniMax's plugins folder, re-verify
  // what actually moved, and only then delete it: the recursive delete never
  // runs against a path that was not just proven to be ours.
  const removing = uniqueWorkPath(resolveWorkParent(options), REMOVAL_PREFIX);
  try {
    fs.renameSync(pluginRoot, removing);
  } catch (err) {
    return {
      status: "error",
      message: `Could not remove ${pluginRoot}: ${err && err.message ? err.message : err}`,
      removed: 0,
      changed: false,
      pluginRoot,
      registrationRemoved: null,
      residualPaths: [pluginRoot],
    };
  }
  const moved = readOwnership(removing);
  if (!moved.owned) {
    // Whatever moved is not the directory we verified — put it back untouched.
    let restored = false;
    try {
      fs.renameSync(removing, pluginRoot);
      restored = true;
    } catch { /* reported below */ }
    const result = refusedUninstallResult(restored ? pluginRoot : removing, moved.reason);
    return { ...result, pluginRoot };
  }
  fs.rmSync(removing, { recursive: true, force: true });
  if (!options.silent) console.log(`Clawd MiniMax Code plugin removed: ${pluginRoot}`);
  return { removed: MINIMAX_HOOK_EVENTS.length, changed: true, pluginRoot, registrationRemoved: true };
}

module.exports = {
  DEFAULT_DATA_DIR,
  DEFAULT_PLUGIN_ROOT,
  HOOK_TIMEOUT_SECONDS,
  MARKER,
  MINIMAX_HOOK_EVENTS,
  OWNER_MARKER_FILE,
  OWNER_MARKER_VERSION,
  PLUGIN_DIR_NAME,
  REMOVAL_PREFIX,
  STAGING_PREFIX,
  buildDesiredHooksDocument: desiredHooksDocument,
  buildOwnerMarker,
  desiredManifest,
  hooksReferenceClawdHook,
  installMinimaxPlugin,
  isOwnerMarker,
  readOwnership,
  recordedNodeBin,
  resolveDesiredNodeBin,
  resolveHookScriptPath,
  resolveMinimaxDataDir,
  resolvePluginRoot,
  unregisterMinimaxPlugin,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      const result = unregisterMinimaxPlugin({});
      if (result.registrationRemoved !== true) {
        console.error(result.message || `Could not remove ${result.pluginRoot}`);
        process.exit(1);
      }
    } else {
      installMinimaxPlugin({});
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
