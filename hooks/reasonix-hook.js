#!/usr/bin/env node
// Clawd — Reasonix state-only hook.
// Registered in <Reasonix home>/settings.json by hooks/reasonix-install.js
//
// All events: POST /state, fire-and-forget, exit immediately.
// Reasonix owns its own permission flow natively (Gate + terminal prompt);
// Clawd only observes state for the desktop pet animation.

const { postStateToRunningServer, readHostPrefix, applyWslSourceFields } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "attention",
  SubagentStop: "working",
  Notification: "notification",
  PreCompact: "sweeping",
};

// #634: lifecycle for the shared resolver's cross-process pid cache. Stop is
// deliberately NOT "end" (turn completion; Reasonix even delays its Stop POST).
const EVENT_TO_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
  SessionEnd: "end",
};

const config = getPlatformConfig();
const resolve = createPidResolver({
  agentNames: {
    win: new Set(["reasonix.exe"]),
    mac: new Set(["reasonix"]),
    linux: new Set(["reasonix"]),
  },
  platformConfig: config,
});

function normalizeReasonixSessionId(value) {
  const raw = value != null && value !== "" ? String(value) : "default";
  return raw.startsWith("reasonix:") ? raw : `reasonix:${raw}`;
}

// Reasonix fires PostToolUse and Stop in quick succession when a turn ends.
// Both spawn separate hook processes — if Stop's POST arrives at the server
// before PostToolUse's, the state ends up as "working" instead of "attention".
// A short delay on Stop lets PostToolUse's POST land first.
const STOP_DELAY_MS = 200;

// Safety timeout: guarantee the hook exits even if stdin never arrives.
// Stop gets extra time to accommodate the delay above.
const SAFETY_TIMEOUT_MS = 800;
const SAFETY_TIMEOUT_STOP_MS = SAFETY_TIMEOUT_MS + STOP_DELAY_MS + 200;
let _exited = false;
let safetyTimer = null;

function safeExit(code) {
  if (_exited) return;
  _exited = true;
  if (safetyTimer) clearTimeout(safetyTimer);
  // Reasonix consumes stdout as text for PreCompact/PostLLMCall hooks; this
  // state-only observer must stay silent and rely on exit code 0 as pass.
  process.exit(code);
}

safetyTimer = setTimeout(() => safeExit(0), SAFETY_TIMEOUT_MS);

readStdinJson()
  .then((payload) => {
    const hookName = (payload && typeof payload.event === "string" && payload.event) || "";
    const mapped = EVENT_TO_STATE[hookName];
    if (!mapped) {
      safeExit(0);
      return;
    }

    const remote = !!process.env.CLAWD_REMOTE;
    const host = remote ? readHostPrefix() : undefined;

    if (hookName === "SessionStart" && !remote) resolve();

    // Use longer safety timeout for Stop to accommodate the delay
    if (hookName === "Stop") {
      if (safetyTimer) clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => safeExit(0), SAFETY_TIMEOUT_STOP_MS);
    }

    const body = {
      state: mapped,
      session_id: normalizeReasonixSessionId(payload && payload.session_id),
      event: hookName,
      agent_id: "reasonix",
    };

    if (payload && typeof payload.cwd === "string" && payload.cwd) body.cwd = payload.cwd;

    if (hookName === "PreToolUse" || hookName === "PostToolUse") {
      const toolName = payload && typeof payload.toolName === "string" ? payload.toolName : null;
      if (toolName) body.tool_name = toolName;
    }

    if (remote) {
      body.host = host;
      applyWslSourceFields(body, { remote: true });
    } else {
      applyWslSourceFields(body);
      // #634: cacheable keys off the RAW session id — the normalized value is
      // prefixed, so its "reasonix:default" fallback would defeat the #583
      // guard; a literal raw "default" is rejected for the same reason.
      const rawSessionId = (payload && payload.session_id) || "";
      const { stablePid, agentPid, detectedEditor, pidChain } = resolve({
        namespace: "reasonix",
        sessionId: body.session_id,
        cacheCwd: body.cwd || "",
        lifecycle: EVENT_TO_LIFECYCLE[hookName] || "event",
        cacheable: !!rawSessionId && rawSessionId !== "default" && !!body.cwd,
      });
      if (Number.isFinite(stablePid) && stablePid > 0) body.source_pid = Math.floor(stablePid);
      if (detectedEditor) body.editor = detectedEditor;
      if (Number.isFinite(agentPid) && agentPid > 0) body.agent_pid = Math.floor(agentPid);
      if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
    }

    // For Stop: delay the POST so PostToolUse's POST arrives at the server first
    const postFn = () => {
      postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => {
        safeExit(0);
      });
    };

    if (hookName === "Stop") {
      setTimeout(postFn, STOP_DELAY_MS);
    } else {
      postFn();
    }
  })
  .catch(() => safeExit(0));
