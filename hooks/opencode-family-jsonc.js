// JSONC editor for opencode-family members whose host config is JSONC
// (registry entries with jsonc: true — today only mimocode's
// ~/.config/mimocode/mimocode.jsonc).
//
// The JSON path in opencode-family-install.js round-trips through
// JSON.parse/JSON.stringify, which would DESTROY user comments and trailing
// commas in a JSONC file. This module performs element-level edits with
// jsonc-parser (modify/applyEdits) so everything the user wrote survives;
// only the "plugin" array entry we manage is touched (plan §4.1).
//
// Deliberately a SEPARATE module, lazy-required by the shared installer only
// when cfg.jsonc is set: hooks/json-utils.js is deployed to remote SSH hosts
// without node_modules and must stay dependency-free, so jsonc-parser must
// never be required from it (locked by a remote-closure guard test).
//
// Contract parity: registerJsonc/unregisterJsonc return the same shapes and
// print the same console lines as the JSON branch in makeFamilyInstaller —
// callers cannot tell the two apart.

const path = require("path");
const { parse, modify, applyEdits } = require("jsonc-parser");
const {
  readTextFileStripBom,
  writeTextAtomic,
  writeTextAtomicWithBackup,
} = require("./json-utils");

// Match the repo's 2-space JSON style for inserted elements.
const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

function normalizePluginEntry(value) {
  return String(value || "").replace(/\\/g, "/");
}

function entryIsExactManagedPlugin(entry, pluginDir) {
  return typeof entry === "string" && normalizePluginEntry(entry) === normalizePluginEntry(pluginDir);
}

function parseJsoncStrict(text, configPath) {
  const errors = [];
  const tree = parse(text, errors, PARSE_OPTIONS);
  if (errors.length) {
    // Do not clobber a config we cannot fully understand — same stance as the
    // JSON branch on a JSON.parse failure.
    throw new Error(`Failed to read ${configPath}: invalid JSONC (${errors.length} parse error${errors.length === 1 ? "" : "s"})`);
  }
  return tree;
}

function freshConfigText(cfg, pluginDir) {
  const settings = cfg.schema ? { $schema: cfg.schema, plugin: [pluginDir] } : { plugin: [pluginDir] };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// Same idempotency rule as the JSON branch: match by exact path OR by
// directory basename on an ABSOLUTE-path entry (stale installs at another
// location get updated in place; npm package specifiers — which can also
// live in the plugin array — are never touched because they aren't absolute).
function findManagedIndex(pluginArray, pluginDir, pluginDirName) {
  for (let i = 0; i < pluginArray.length; i++) {
    const entry = pluginArray[i];
    if (typeof entry !== "string") continue;
    if (entry === pluginDir) return i;
    const normalized = entry.replace(/\\/g, "/");
    const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
    if (isAbsolute && path.posix.basename(normalized) === pluginDirName) return i;
  }
  return -1;
}

function registerJsonc({ cfg, agentId, configPath, pluginDir, options = {} }) {
  let text = null;
  let created = false;
  try {
    text = readTextFileStripBom(configPath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      created = true;
    } else {
      throw new Error(`Failed to read ${configPath}: ${err.message}`);
    }
  }

  let added = false;
  let skipped = false;

  if (created) {
    writeTextAtomic(configPath, freshConfigText(cfg, pluginDir));
    added = true;
  } else {
    const tree = parseJsoncStrict(text, configPath);
    if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
      // Non-object root ("null", a bare number…). The JSON branch tolerates
      // this by starting over from {}; there are no meaningful comments to
      // preserve in a config with no object root, so we do the same.
      writeTextAtomic(configPath, freshConfigText(cfg, pluginDir));
      added = true;
    } else if (!Array.isArray(tree.plugin)) {
      // Missing or non-array "plugin" — (re)write just that property.
      text = applyEdits(text, modify(text, ["plugin"], [pluginDir], FORMATTING));
      writeTextAtomic(configPath, text);
      added = true;
    } else {
      const matchIndex = findManagedIndex(tree.plugin, pluginDir, cfg.pluginDirName);
      if (matchIndex === -1) {
        text = applyEdits(text, modify(text, ["plugin", -1], pluginDir, { ...FORMATTING, isArrayInsertion: true }));
        writeTextAtomic(configPath, text);
        added = true;
      } else if (tree.plugin[matchIndex] !== pluginDir) {
        // Stale path (e.g. old install location) — update the element in place
        text = applyEdits(text, modify(text, ["plugin", matchIndex], pluginDir, FORMATTING));
        writeTextAtomic(configPath, text);
        added = true;
      } else {
        skipped = true;
      }
    }
  }

  if (!options.silent) {
    console.log(`Clawd ${agentId} plugin → ${configPath}`);
    if (created) console.log(`  Created ${cfg.configFileName}`);
    if (added) console.log(`  Registered: ${pluginDir}`);
    if (skipped) console.log(`  Already registered: ${pluginDir}`);
  }

  return { added, skipped, created, configPath, pluginDir };
}

function unregisterJsonc({ cfg, agentId, configPath, pluginDir, options = {} }) {
  let text;
  try {
    text = readTextFileStripBom(configPath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, skipped: true, configPath, pluginDir };
    throw new Error(`Failed to read ${configPath}: ${err.message}`);
  }

  const tree = parseJsoncStrict(text, configPath);
  if (!tree || typeof tree !== "object" || !Array.isArray(tree.plugin)) {
    if (!options.silent) console.log(`Clawd ${agentId} plugin entries removed: 0`);
    return { removed: 0, changed: false, skipped: true, configPath, pluginDir };
  }

  // Unregister removes ALL exactly-matching entries (removed can be > 1 when
  // earlier bugs or hand edits duplicated the path). Delete from the highest
  // index down so the remaining indices stay valid across sequential edits.
  const matches = [];
  for (let i = 0; i < tree.plugin.length; i++) {
    if (entryIsExactManagedPlugin(tree.plugin[i], pluginDir)) matches.push(i);
  }
  for (let k = matches.length - 1; k >= 0; k--) {
    text = applyEdits(text, modify(text, ["plugin", matches[k]], undefined, FORMATTING));
  }

  const removed = matches.length;
  const changed = removed > 0;

  let backupPath = null;
  if (changed) backupPath = writeTextAtomicWithBackup(configPath, text, options);
  if (!options.silent) console.log(`Clawd ${agentId} plugin entries removed: ${removed}`);
  const result = { removed, changed, skipped: !changed, configPath, pluginDir };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  registerJsonc,
  unregisterJsonc,
  __test: { parseJsoncStrict, findManagedIndex, entryIsExactManagedPlugin, freshConfigText },
};
