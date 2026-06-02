#!/usr/bin/env node
// Register Clawd's CodeWhale hooks in the user's codewhale config.
//
// Strategy: append [[hooks.hooks]] entries into ~/.codewhale/config.toml.
// Idempotent — existing clawd-managed entries are updated, others preserved.
//
// CodeWhale hook config format ([[hooks.hooks]] TOML array of tables):
//
//   [hooks]
//   enabled = true
//
//   [[hooks.hooks]]
//   event = "session_start"
//   command = "node /path/to/codewhale-hook.js session_start"
//   background = true
//
// CodeWhale provides context via environment variables:
//   DEEPSEEK_SESSION_ID, DEEPSEEK_TOOL_NAME, DEEPSEEK_MODE,
//   DEEPSEEK_WORKSPACE, DEEPSEEK_MODEL, DEEPSEEK_ERROR, etc.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { asarUnpackedPath } = require("./json-utils");

const CODEXWHALE_CONFIG_PATH = path.join(os.homedir(), ".codewhale", "config.toml");
const MANAGED_MARKER = "# managed by clawd-on-desk";

// Hook events to register. Each entry: [event, background]
// session_end is NOT background — must await delivery.
// shell_env is excluded (not relevant for state animation).
const HOOK_ENTRIES = [
  ["session_start", true],
  ["session_end", false],
  ["message_submit", true],
  ["tool_call_before", true],
  ["tool_call_after", true],
  ["mode_change", true],
  ["on_error", true],
];

function resolveHookScriptPath(baseDir) {
  const dir = path.resolve(baseDir || __dirname, "codewhale-hook.js");
  return asarUnpackedPath(dir).replace(/\\/g, "/");
}

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/");
}

function buildHookEntry(event, background, hookScriptPath) {
  const nodeBin = process.execPath || "node";
  const nodePath = normalizePath(nodeBin);
  const hookPath = normalizePath(hookScriptPath);

  // Use the same node binary that runs Clawd, so the hook can require() our
  // shared modules (server-config, shared-process). Windows node.exe must be
  // quoted in TOML when the path contains spaces.
  const command = `${nodePath} "${hookPath}" ${event}`;

  const lines = [];
  lines.push("");
  lines.push(`# ${MANAGED_MARKER}`);
  lines.push("[[hooks.hooks]]");
  lines.push(`event = "${event}"`);
  lines.push(`command = '''${command}'''`);
  if (background) {
    lines.push("background = true");
  }
  // timeout_secs = 5 is safe for fire-and-forget; session_end gets 30s default
  if (!background) {
    lines.push("timeout_secs = 30");
    lines.push("continue_on_error = true");
  } else {
    lines.push("timeout_secs = 5");
  }
  return lines.join("\n");
}

function parseTomlSections(content) {
  // Minimal TOML parser: split into sections, preserving raw text.
  // We only need to find/replace [[hooks.hooks]] entries with the managed marker.
  const sections = [];
  const lines = content.split("\n");
  let current = { header: null, startLine: 0, lines: [] };
  let inHooksTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect [[hooks.hooks]] entries
    if (/^\[\[hooks\.hooks\]\]/.test(trimmed)) {
      if (current.lines.length > 0 || current.header) {
        sections.push({ ...current, endLine: i - 1 });
      }
      current = { header: "hooks.hooks", startLine: i, lines: [line] };
      inHooksTable = true;
      continue;
    }

    // Detect [hooks] section header (without the double brackets)
    if (/^\[hooks\]/.test(trimmed) && !trimmed.startsWith("[[")) {
      if (current.lines.length > 0 || current.header) {
        sections.push({ ...current, endLine: i - 1 });
      }
      current = { header: "hooks", startLine: i, lines: [line] };
      inHooksTable = true;
      continue;
    }

    // End of hooks-related section when hitting a different top-level section
    if (inHooksTable && /^\[[a-z]/.test(trimmed) && !trimmed.startsWith("[[")) {
      sections.push({ ...current, endLine: i - 1 });
      current = { header: null, startLine: i, lines: [line] };
      inHooksTable = false;
      continue;
    }

    current.lines.push(line);
  }
  if (current.lines.length > 0 || current.header) {
    sections.push({ ...current, endLine: lines.length - 1 });
  }

  return sections;
}

function sectionHasMarker(section) {
  return section.lines.some((line) => line.includes(MANAGED_MARKER));
}

function buildClawdHookSections(hookScriptPath) {
  const sections = [];
  for (const [event, background] of HOOK_ENTRIES) {
    sections.push(buildHookEntry(event, background, hookScriptPath));
  }
  return sections;
}

function registerCodewhaleHooks(options = {}) {
  const hookScriptPath = options.hookScriptPath || resolveHookScriptPath();
  const configPath = options.configPath || CODEXWHALE_CONFIG_PATH;

  // Check if ~/.codewhale/ exists
  const configDir = path.dirname(configPath);
  let configDirExists = false;
  try {
    configDirExists = fs.statSync(configDir).isDirectory();
  } catch {}
  if (!configDirExists && !options.configPath) {
    if (!options.silent) {
      console.log("Clawd: ~/.codewhale/ not found — skipping CodeWhale hook registration");
    }
    return { added: 0, removed: 0, updated: 0, skipped: true };
  }

  let content;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      content = "";
    } else {
      throw new Error(`Failed to read ${configPath}: ${err.message}`);
    }
  }

  // If config doesn't exist or is empty → bootstrap with [hooks] + entries
  if (!content.trim()) {
    const hookSections = buildClawdHookSections(hookScriptPath);
    const newContent = [
      "# codewhale Configuration",
      "",
      "[hooks]",
      "enabled = true",
      ...hookSections,
      "",
    ].join("\n");

    const dir = path.dirname(configPath);
    if (!configDirExists) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, newContent, "utf8");

    if (!options.silent) {
      console.log(`Clawd CodeWhale hooks → ${configPath}`);
      console.log(`  Created config with ${HOOK_ENTRIES.length} hooks`);
    }
    return { added: HOOK_ENTRIES.length, removed: 0, updated: 0, skipped: false };
  }

  // Parse existing config
  const sections = parseTomlSections(content);

  // Find existing clawd-managed hook entries
  const managedHookIndices = [];
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].header === "hooks.hooks" && sectionHasMarker(sections[i])) {
      managedHookIndices.push(i);
    }
  }

  // Check if [hooks] section exists
  const hooksSection = sections.find((s) => s.header === "hooks");
  const hooksEnabled = hooksSection
    ? hooksSection.lines.some((l) => /^\s*enabled\s*=\s*true/.test(l))
    : false;

  // Build new managed entries
  const newEntries = buildClawdHookSections(hookScriptPath);

  // Remove old managed entries
  let removed = managedHookIndices.length;
  for (const idx of managedHookIndices.reverse()) {
    sections.splice(idx, 1);
  }

  // Insert new entries after [hooks] section or at end
  const hooksIdx = sections.findIndex((s) => s.header === "hooks");
  const insertIdx = hooksIdx >= 0 ? hooksIdx + 1 : sections.length;

  // If no [hooks] section, add one
  if (hooksIdx < 0) {
    sections.push({ header: "hooks", startLine: -1, lines: ["[hooks]", "enabled = true"] });
  } else if (!hooksEnabled) {
    sections[hooksIdx].lines.splice(1, 0, "enabled = true");
  }

  // Insert managed entries (as raw strings — we insert them into the sections array)
  for (const entry of newEntries) {
    const entryLines = entry.split("\n");
    sections.splice(insertIdx, 0, {
      header: "hooks.hooks",
      startLine: -1,
      lines: entryLines,
    });
  }

  // Reconstruct TOML
  const newLines = [];
  for (const section of sections) {
    for (const line of section.lines) {
      if (line || newLines.length === 0 || newLines[newLines.length - 1] !== "") {
        newLines.push(line);
      }
    }
  }

  const newContent = newLines.join("\n").trim() + "\n";
  const updated = newContent !== content;

  if (updated) {
    // Atomic write
    const tmpPath = path.join(configDir, `.config.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, newContent, "utf8");
    fs.renameSync(tmpPath, configPath);
  }

  const added = HOOK_ENTRIES.length;
  if (!options.silent) {
    console.log(`Clawd CodeWhale hooks → ${configPath}`);
    if (updated) {
      console.log(`  Registered ${added} hooks (removed ${removed} old entries)`);
    } else {
      console.log(`  Already up to date (${added} hooks)`);
    }
  }

  return { added, removed, updated, skipped: !updated };
}

function unregisterCodewhaleHooks(options = {}) {
  const configPath = options.configPath || CODEXWHALE_CONFIG_PATH;

  let content;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      if (!options.silent) console.log("Clawd: CodeWhale config not found");
      return { removed: 0, skipped: true };
    }
    throw err;
  }

  const sections = parseTomlSections(content);
  let removed = 0;

  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].header === "hooks.hooks" && sectionHasMarker(sections[i])) {
      sections.splice(i, 1);
      removed++;
    }
  }

  if (removed === 0) {
    if (!options.silent) console.log("Clawd: no managed CodeWhale hooks found");
    return { removed: 0, skipped: true };
  }

  const newLines = [];
  for (const section of sections) {
    for (const line of section.lines) {
      if (line || newLines.length === 0 || newLines[newLines.length - 1] !== "") {
        newLines.push(line);
      }
    }
  }

  const newContent = newLines.join("\n").trim() + "\n";
  const configDir = path.dirname(configPath);
  const tmpPath = path.join(configDir, `.config.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, newContent, "utf8");
  fs.renameSync(tmpPath, configPath);

  if (!options.silent) {
    console.log(`Clawd CodeWhale hooks removed: ${removed}`);
  }

  return { removed, skipped: false };
}

module.exports = {
  CODEXWHALE_CONFIG_PATH,
  HOOK_ENTRIES,
  registerCodewhaleHooks,
  unregisterCodewhaleHooks,
  // Exposed for tests
  __test: {
    buildHookEntry,
    parseTomlSections,
    sectionHasMarker,
    buildClawdHookSections,
    resolveHookScriptPath,
    normalizePath,
  },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      unregisterCodewhaleHooks({});
    } else {
      registerCodewhaleHooks({});
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
