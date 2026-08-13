// DeepSeek Harness agent configuration
// Perception via the dsh state-file monitor (agents/deepseek-harness-monitor.js):
// it polls the durable JSON side of the DeepSeek Harness web UI
// ($DSH_HOME/storages/workspace.json + session_projcache.json) and emits the
// Clawd-internal event vocabulary below. No hook is installed anywhere and no
// DSH config is touched — DSH stays completely unmodified.
//
// State-only: DSH owns permission decisions natively (approval presets), so
// Clawd must never add a permission layer on top of it.

module.exports = {
  id: "deepseek-harness",
  name: "DeepSeek Harness",
  // DSH runs as a plain node process (node.exe / node on any platform), so
  // process-name detection is intentionally empty on every platform — DSH
  // presence is decided by the monitor's $DSH_HOME files instead.
  processNames: { win: [], mac: [], linux: [] },
  startupRecoveryProcessNames: { win: [], mac: [], linux: [] },
  eventSource: "dsh-monitor",
  // Clawd-internal event names. The monitor derives these from the projection
  // cache: a fresh lastPromptAt = UserPromptSubmit, an open LLM step or a
  // pending tool call = PreToolUse/PostToolUse, no activity after a working
  // state = Stop, lifecycle edges = SessionStart/SessionEnd.
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    Stop: "attention",
    SessionEnd: "idle",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    notificationHook: false,
    interactiveBubble: false,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "dsh-state-files",
  },
};
