#!/usr/bin/env node
// Merge Clawd Codex official state hooks into ~/.codex/hooks.json.
//
// Phase 1 only registers lifecycle/state hooks. PermissionRequest remains on
// JSONL fallback/passive notification until the Codex-specific sanitizer and
// long-poll /permission path land in Phase 2.

const {
  buildCodexHookCommand,
  registerCodexCommandHooks,
  unregisterCodexCommandHooks,
} = require("./codex-install-utils");

const MARKER = "codex-hook.js";
const CODEX_STATE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
];

function buildCodexStateHookCommand(nodeBin, hookScript, platform = process.platform) {
  return buildCodexHookCommand(nodeBin, hookScript, platform);
}

function registerCodexHooks(options = {}) {
  return registerCodexCommandHooks({
    ...options,
    marker: MARKER,
    scriptName: MARKER,
    events: CODEX_STATE_HOOK_EVENTS,
    label: "Codex official hooks",
  });
}

function unregisterCodexHooks(options = {}) {
  return unregisterCodexCommandHooks({
    ...options,
    marker: MARKER,
    events: CODEX_STATE_HOOK_EVENTS,
  });
}

module.exports = {
  CODEX_STATE_HOOK_EVENTS,
  buildCodexStateHookCommand,
  registerCodexHooks,
  unregisterCodexHooks,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterCodexHooks({});
    else registerCodexHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
