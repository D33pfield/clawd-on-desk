// Grok Build / Grok CLI agent configuration
// Hook-based integration — Claude Code-compatible event names, camelCase stdin
// Settings: ~/.grok/hooks/clawd.json (or $GROK_HOME/hooks/clawd.json)

module.exports = {
  id: "grok",
  name: "Grok Build",
  processNames: {
    win: ["grok.exe"],
    mac: ["grok"],
    linux: ["grok"],
  },
  startupRecoveryProcessNames: {
    win: ["grok.exe"],
    mac: ["grok"],
    linux: ["grok"],
  },
  eventSource: "hook",
  // PascalCase event names match Grok's Claude-compatible hook_event_name.
  // NOTE: no PermissionRequest. Grok has no blocking approval hook; permission
  // prompts stay in the TUI. Notification is enough for the bell/attention cue.
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    StopCancelled: "idle",
    Notification: "notification",
    SubagentStart: "juggling",
    SubagentStop: "working",
    PreCompact: "sweeping",
    PostCompact: "thinking",
    PermissionDenied: "notification",
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
    configFormat: "claude-code-compatible",
  },
  stdinFormat: "grokHookJson",
  pidField: "grok_pid",
};
