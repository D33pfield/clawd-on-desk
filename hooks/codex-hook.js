#!/usr/bin/env node
// Clawd — Codex official lifecycle hook (Phase 1 state events only).
// Registered in ~/.codex/hooks.json by hooks/codex-install.js

const crypto = require("crypto");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;

const EVENT_TO_STATE = {
  SessionStart: "idle",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  // Placeholder: server.js resolves official Codex Stop to attention/idle
  // using the per-turn tool-use map it owns.
  Stop: "idle",
};

function normalizeCodexSessionId(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "default";
  return raw.startsWith("codex:") ? raw : `codex:${raw}`;
}

function normalizeToolUseId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeToolMatchValue(value, depth = 0) {
  if (depth > TOOL_MATCH_DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, TOOL_MATCH_ARRAY_MAX)
      .map((entry) => normalizeToolMatchValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, TOOL_MATCH_OBJECT_KEYS_MAX)) {
      out[key] = normalizeToolMatchValue(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > TOOL_MATCH_STRING_MAX
      ? `${value.slice(0, TOOL_MATCH_STRING_MAX - 1)}…`
      : value;
  }
  return value;
}

function buildToolInputFingerprint(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const normalized = normalizeToolMatchValue(toolInput);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function buildStateBody(payload, resolve) {
  const event = payload && typeof payload.hook_event_name === "string"
    ? payload.hook_event_name
    : "";
  const state = EVENT_TO_STATE[event];
  if (!state) return null;
  if (event === "Stop" && payload.stop_hook_active === true) return null;

  const body = {
    state,
    session_id: normalizeCodexSessionId(payload.session_id),
    event,
    agent_id: "codex",
    hook_source: "codex-official",
  };

  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  if (cwd) body.cwd = cwd;
  if (typeof payload.turn_id === "string" && payload.turn_id) body.turn_id = payload.turn_id;
  if (typeof payload.permission_mode === "string" && payload.permission_mode) {
    body.permission_mode = payload.permission_mode;
  }
  if (typeof payload.transcript_path === "string" && payload.transcript_path) {
    body.transcript_path = payload.transcript_path;
  }
  if (typeof payload.model === "string" && payload.model) body.model = payload.model;
  if (payload.stop_hook_active === true || payload.stop_hook_active === false) {
    body.stop_hook_active = payload.stop_hook_active;
  }

  const toolName = typeof payload.tool_name === "string" && payload.tool_name ? payload.tool_name : null;
  const toolUseId = normalizeToolUseId(payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID);
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : null;
  const toolInputFingerprint = buildToolInputFingerprint(toolInput);
  if (toolName) body.tool_name = toolName;
  if (toolUseId) body.tool_use_id = toolUseId;
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;

  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) body.agent_pid = agentPid;
    if (pidChain.length) body.pid_chain = pidChain;
  }

  return body;
}

function main() {
  const config = getPlatformConfig();
  const resolve = createPidResolver({
    agentNames: { win: new Set(["codex.exe"]), mac: new Set(["codex"]), linux: new Set(["codex"]) },
    platformConfig: config,
  });

  readStdinJson().then((payload) => {
    const body = buildStateBody(payload || {}, resolve);
    if (!body) process.exit(0);
    postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => process.exit(0));
  });
}

if (require.main === module) main();

module.exports = {
  EVENT_TO_STATE,
  buildStateBody,
  buildToolInputFingerprint,
  normalizeCodexSessionId,
};
