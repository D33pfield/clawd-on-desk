#!/usr/bin/env node
// Clawd — Grok Build hook (stdin JSON; stdout JSON for gating hooks)
// Registered in ~/.grok/hooks/clawd.json by hooks/grok-install.js
// Grok uses Claude-compatible event names but camelCase field names.

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig, applyOrcaPaneKey } = require("./shared-process");

const HOOK_MAP = {
  SessionStart: { state: "idle", event: "SessionStart" },
  SessionEnd: { state: "sleeping", event: "SessionEnd" },
  UserPromptSubmit: { state: "thinking", event: "UserPromptSubmit" },
  PreToolUse: { state: "working", event: "PreToolUse" },
  PostToolUse: { state: "working", event: "PostToolUse" },
  PostToolUseFailure: { state: "error", event: "PostToolUseFailure" },
  Stop: { state: "attention", event: "Stop" },
  StopFailure: { state: "error", event: "StopFailure" },
  StopCancelled: { state: "idle", event: "StopCancelled" },
  Notification: { state: "notification", event: "Notification" },
  SubagentStart: { state: "juggling", event: "SubagentStart" },
  SubagentStop: { state: "working", event: "SubagentStop" },
  PreCompact: { state: "sweeping", event: "PreCompact" },
  PostCompact: { state: "thinking", event: "PostCompact" },
  PermissionDenied: { state: "notification", event: "Notification" },
};

const EVENT_TO_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
  SessionEnd: "end",
};

const SNAKE_TO_PASCAL = {
  session_start: "SessionStart",
  session_end: "SessionEnd",
  user_prompt_submit: "UserPromptSubmit",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  post_tool_use_failure: "PostToolUseFailure",
  stop: "Stop",
  stop_failure: "StopFailure",
  stop_cancelled: "StopCancelled",
  notification: "Notification",
  subagent_start: "SubagentStart",
  subagent_stop: "SubagentStop",
  pre_compact: "PreCompact",
  post_compact: "PostCompact",
  permission_denied: "PermissionDenied",
};

const config = getPlatformConfig({
  extraTerminals: { win: ["grok.exe"] },
  extraEditors: {
    win: { "grok.exe": "grok" },
    mac: { grok: "grok" },
    linux: { grok: "grok" },
  },
  extraEditorPathChecks: [["grok", "grok"]],
});

const GROK_AGENT_NAMES = Object.freeze({
  win: new Set(["grok.exe"]),
  mac: new Set(["grok"]),
  linux: new Set(["grok"]),
});

function isGrokCommandLine(commandLine) {
  const normalized = String(commandLine || "").replace(/\\/g, "/").toLowerCase();
  if (!normalized) return false;
  if (/\bgrok(?:\.exe)?\b/.test(normalized)) return true;
  return normalized.includes("grok-shell") || normalized.includes("@xai");
}

const resolve = createPidResolver({
  agentNames: GROK_AGENT_NAMES,
  agentCmdlineCheck: isGrokCommandLine,
  platformConfig: config,
});

function stdoutForEvent() {
  return "{}";
}

const SESSION_TITLE_MAX = 60;

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeHookName(payload) {
  const fromArgv = typeof process.argv[2] === "string" ? process.argv[2].trim() : "";
  if (fromArgv && HOOK_MAP[fromArgv]) return fromArgv;
  const pascal = pickString(payload && payload.hook_event_name);
  if (pascal && HOOK_MAP[pascal]) return pascal;
  const snake = pickString(
    process.env.GROK_HOOK_EVENT,
    payload && payload.hookEventName
  );
  if (SNAKE_TO_PASCAL[snake]) return SNAKE_TO_PASCAL[snake];
  return pascal || fromArgv;
}

function pickSessionId(payload) {
  return pickString(
    payload && payload.session_id,
    payload && payload.sessionId,
    process.env.GROK_SESSION_ID
  );
}

function deriveSessionTitle(hookName, payload) {
  const rawTitle = pickString(
    payload && payload.session_title,
    payload && payload.sessionTitle,
    payload && payload.session_name,
    payload && payload.sessionName
  );
  if (rawTitle) {
    return rawTitle.length > SESSION_TITLE_MAX
      ? `${rawTitle.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
      : rawTitle;
  }
  if (hookName === "UserPromptSubmit" && payload && typeof payload.prompt === "string") {
    for (const line of payload.prompt.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) {
        return candidate.length > SESSION_TITLE_MAX
          ? `${candidate.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
          : candidate;
      }
    }
  }
  return null;
}

const SAFETY_TIMEOUT_MS = 800;
let _wrote = false;
let _exited = false;
let safetyTimer = null;

function writeStdoutOnce(outLine) {
  if (_wrote) return;
  _wrote = true;
  process.stdout.write(outLine + "\n");
}

function finish(outLine) {
  writeStdoutOnce(outLine);
  if (_exited) return;
  _exited = true;
  if (safetyTimer) clearTimeout(safetyTimer);
  process.exit(0);
}

safetyTimer = setTimeout(() => finish("{}"), SAFETY_TIMEOUT_MS);

function run() {
  readStdinJson()
    .then((payload) => {
      const hookName = normalizeHookName(payload || {});
      const mapped = HOOK_MAP[hookName];
      const outLine = stdoutForEvent(hookName);

      if (!mapped) {
        finish(outLine);
        return;
      }

      const sessionId = pickSessionId(payload || {});
      if (!sessionId) {
        finish(outLine);
        return;
      }

      let { state, event } = mapped;
      if (hookName === "PostCompact" && payload && payload.trigger === "manual") {
        state = "idle";
      }

      if (hookName === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();

      const cwd = pickString(payload && payload.cwd, process.env.GROK_WORKSPACE_ROOT);
      const toolName = pickString(payload && payload.tool_name, payload && payload.toolName);
      const toolUseId = pickString(payload && payload.tool_use_id, payload && payload.toolUseId);

      const resolved = resolve({
        namespace: "grok",
        sessionId,
        cacheCwd: cwd,
        lifecycle: EVENT_TO_LIFECYCLE[hookName] || "event",
        cacheable: sessionId !== "default" && !!cwd,
      });

      const body = { state, session_id: sessionId, event };
      body.agent_id = "grok";
      if (cwd) body.cwd = cwd;
      if (toolName) body.tool_name = toolName;
      if (toolUseId) body.tool_use_id = toolUseId;

      const sessionTitle = deriveSessionTitle(hookName, payload || {});
      if (sessionTitle) body.session_title = sessionTitle;

      if (process.env.CLAWD_REMOTE) {
        body.host = readHostPrefix();
        applyOrcaPaneKey(body);
      } else {
        if (resolved.stablePid) body.source_pid = resolved.stablePid;
        if (resolved.detectedEditor) body.editor = resolved.detectedEditor;
        if (resolved.agentPid) body.agent_pid = resolved.agentPid;
        if (resolved.pidChain && resolved.pidChain.length) body.pid_chain = resolved.pidChain;
        if (resolved.tmuxSocket) body.tmux_socket = resolved.tmuxSocket;
        if (resolved.tmuxClient) body.tmux_client = resolved.tmuxClient;
        applyOrcaPaneKey(body);
      }

      writeStdoutOnce(outLine);
      postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => {
        finish(outLine);
      });
    })
    .catch(() => finish("{}"));
}

if (require.main === module) {
  run();
} else {
  if (safetyTimer) clearTimeout(safetyTimer);
  _exited = true;
}

module.exports = {
  HOOK_MAP,
  stdoutForEvent,
  deriveSessionTitle,
  normalizeHookName,
  pickSessionId,
  SESSION_TITLE_MAX,
  GROK_AGENT_NAMES,
  isGrokCommandLine,
};
