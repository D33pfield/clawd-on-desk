// WorkBuddy IDE/CLI agent configuration
// Hook-based integration — Claude Code-compatible hook format
// Settings: ~/.workbuddy/settings.json
// Docs: https://www.codebuddy.cn/docs/workbuddy/Overview

module.exports = {
  id: "workbuddy",
  name: "WorkBuddy",
  processNames: {
    // NOTE on process names — WorkBuddy is a GUI Electron app, not a bare CLI
    // like `claude`/`codebuddy`. Hooks fire from inside the app, so this list
    // only feeds src/state.js zero-session startup recovery (it never creates
    // or reaps tracked sessions). Verified on macOS: the app bundle ships
    // "WorkBuddy Helper", "WorkBuddy Helper (Renderer|GPU|Plugin)"; the main
    // executable is the bare "Electron" binary, which we deliberately DO NOT
    // list — matching it would false-positive on dev-mode Clawd and other
    // unrenamed Electron apps. Windows/Linux names are best-guess assumptions
    // pending real-device confirmation (tasklist / ps).
    win: ["WorkBuddy.exe", "workbuddy.exe"],
    mac: ["WorkBuddy Helper", "WorkBuddy Helper (Renderer)"],
    linux: ["workbuddy", "WorkBuddy"],
  },
  eventSource: "hook",
  // PascalCase event names — identical to Claude Code hook system
  eventMap: {
    SessionStart:     "idle",
    SessionEnd:       "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse:       "working",
    PostToolUse:      "working",
    Stop:             "attention",
    PermissionRequest:"notification",
    Notification:     "notification",
    PreCompact:       "sweeping",
  },
  capabilities: {
    httpHook: true,
    permissionApproval: true,
    notificationHook: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "claude-code-compatible",
  },
  stdinFormat: "claudeCodeHookJson",
  pidField: "workbuddy_pid",
};
