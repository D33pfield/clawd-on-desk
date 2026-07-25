// Reasonix agent configuration
// Hook-only integration via ~/.reasonix/settings.json
// Reasonix is a Go CLI coding agent; Phase 1 is state-only (no permission bubble).
// Reasonix owns its own permission flow natively via its Gate + terminal prompt.

module.exports = {
  id: "reasonix",
  name: "Reasonix",
  processNames: { win: ["reasonix.exe", "reasonix-desktop.exe", "reasonix-cli.exe"], mac: ["reasonix", "reasonix-desktop"], linux: ["reasonix", "reasonix-desktop"] },
  startupRecoveryProcessNames: { win: ["reasonix.exe", "reasonix-desktop.exe", "reasonix-cli.exe"], mac: ["reasonix", "reasonix-desktop"], linux: ["reasonix", "reasonix-desktop"] },
  eventSource: "hook",
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    Stop: "attention",
    SubagentStop: "working",
    Notification: "notification",
    PreCompact: "sweeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    interactiveBubble: false,
    notificationHook: true,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "reasonix-settings-json",
  },
  stdinFormat: "reasonixHookJson",
  pidField: "reasonix_pid",
};
