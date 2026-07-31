#!/usr/bin/env node
// Clawd — Reasonix state-only hook.
// Registered in <Reasonix home>/settings.json by hooks/reasonix-install.js
//
// All events: POST /state, fire-and-forget, exit immediately.
// Reasonix owns its own permission flow natively (Gate + terminal prompt);
// Clawd only observes state for the desktop pet animation.

const { postStateToRunningServer, readHostPrefix, applyWslSourceFields } = require("./server-config");
const { createPidResolver, readStdinJsonDetailed, getPlatformConfig, applyOrcaPaneKey } = require("./shared-process");

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
    win: new Set(["reasonix.exe", "reasonix-desktop.exe", "reasonix-cli.exe"]),
    mac: new Set(["reasonix", "reasonix-desktop"]),
    // reasonix-deskto: Linux comm is truncated to TASK_COMM_LEN(16)-1 = 15
    // chars, so ps/pgrep never see the full "reasonix-desktop".
    linux: new Set(["reasonix", "reasonix-desktop", "reasonix-deskto"]),
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

// Reasonix (Go CLI / Wails desktop) can take longer than the shared 400ms
// default to flush the hook payload to stdin after a long idle period (Go
// scheduler warm-up + child-process pipe setup on first event). Use a wider
// 2000ms read window so the first post-idle event actually arrives.
const STDIN_READ_TIMEOUT_MS = 2000;

// Safety timeout: guarantee the hook exits even if stdin never arrives.
// Phased, deadline-based budgets instead of one blanket 800ms — the single
// budget fired while a cold machine was still legitimately working (post-idle
// stdin flush + cold WMI snapshot inside resolve()), and safeExit(0)
// swallowed the event BEFORE the POST with a clean exit 0: no error anywhere,
// the pet just looked "disconnected" after every long idle.
// Blocking hooks (UserPromptSubmit/PreToolUse) get a 5s budget from Reasonix
// and a timeout becomes a DecisionBlock that ABORTS the user's turn, so the
// absolute deadline stays below it — including the cmd/PowerShell startup
// before node that we cannot observe from here. Non-blocking events (upstream
// budget 30s) use a relaxed deadline instead.
const startedAt = Date.now();
const HARD_DEADLINE_MS = 4500;
const RELAXED_DEADLINE_MS = 15000;
const STDIN_PHASE_BUDGET_MS = STDIN_READ_TIMEOUT_MS + 500;
const POST_STDIN_BUDGET_MS = 3500;
const STOP_EXTRA_MS = STOP_DELAY_MS + 200;
const BLOCKING_HOOKS = new Set(["UserPromptSubmit", "PreToolUse"]);
let _exited = false;
let safetyTimer = null;

function armSafety(ms, deadlineMs = HARD_DEADLINE_MS) {
  if (safetyTimer) clearTimeout(safetyTimer);
  const remaining = deadlineMs - (Date.now() - startedAt);
  safetyTimer = setTimeout(() => safeExit(0), Math.max(1, Math.min(ms, remaining)));
}

function safeExit(code) {
  if (_exited) return;
  _exited = true;
  if (safetyTimer) clearTimeout(safetyTimer);
  // Reasonix consumes stdout as text for PreCompact/PostLLMCall hooks; this
  // state-only observer must stay silent and rely on exit code 0 as pass.
  process.exit(code);
}

armSafety(STDIN_PHASE_BUDGET_MS);

readStdinJsonDetailed({ timeoutMs: STDIN_READ_TIMEOUT_MS })
  .then((result) => {
    const payload = result.payload;
    const hookName = (payload && typeof payload.event === "string" && payload.event) || "";

    // stdin settled (payload or read timeout) — re-arm for resolve() + POST.
    // Stop is non-blocking (30s upstream) and gets the relaxed deadline plus
    // its ordering-delay allowance.
    const isStop = hookName === "Stop";
    armSafety(
      isStop ? POST_STDIN_BUDGET_MS + STOP_EXTRA_MS : POST_STDIN_BUDGET_MS,
      BLOCKING_HOOKS.has(hookName) ? HARD_DEADLINE_MS : RELAXED_DEADLINE_MS
    );

    const mapped = EVENT_TO_STATE[hookName];
    if (!mapped) {
      safeExit(0);
      return;
    }

    const remote = !!process.env.CLAWD_REMOTE;
    const host = remote ? readHostPrefix() : undefined;

    if (hookName === "SessionStart" && !remote) resolve();

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
      applyOrcaPaneKey(body);
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
      applyOrcaPaneKey(body);
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
