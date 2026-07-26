// ZCode agent configuration
// ZCode is 智谱/Z.ai's Electron desktop ADE; it spawns `zcode-cli` as the
// per-session agent runtime. `zcode-cli` reads ~/.zcode/cli/config.json, whose
// hook schema is documented in ZCode's official `zcode-configuration-guide` /
// `diagnosing-hooks` skills. Config-file hooks nest under `hooks.events.*`
// (NOT `hooks.*` like plugin hooks.json), require `hooks.enabled: true`, and
// the matcher is a case-sensitive REGEX (so "*" silently never matches —
// omit the matcher to match everything).
// ZCode supports exactly 7 events: SessionStart, UserPromptSubmit, PreToolUse,
// PermissionRequest, PostToolUse, PostToolUseFailure, Stop. It does NOT support
// SessionEnd or Notification.
// Phase 1: state-only hook integration (no PermissionRequest bubble).

module.exports = {
  id: "zcode",
  name: "ZCode",
  // The ZCode desktop app (Electron) spawns a per-session agent runtime.
  // Process tree: ZCode (main shell) -> zcode-host-local -> zcode-cli (runtime).
  // Detect the runtime (zcode-cli), NOT the Electron shell (`ZCode`) or the
  // host bridge.
  //
  // CROSS-PLATFORM NOTE (real-machine smoke, ZCode 3.4.2):
  //   - macOS / Linux: the runtime is a standalone binary `zcode-cli` (one per
  //     live session). Verified on macOS 3.4.2 — confirmed unambiguous.
  //   - Windows: per reviewer's audit of the 3.3.6 installer, the app reuses
  //     the Electron shell via `ZCode.exe resources/glm/zcode.cjs app-server
  //     --stdio` with ELECTRON_RUN_AS_NODE=1 — i.e. the working process is
  //     `ZCode.exe` with a distinctive cmdline, NOT a `zcode-cli.exe` binary.
  //     `zcode-cli.exe` below is a placeholder until a Windows smoke confirms
  //     the exact name; the hook adapter's cmdline check (`zcode.cjs`) is the
  //     authoritative Windows signal today.
  processNames: { win: ["zcode-cli.exe"], mac: ["zcode-cli"], linux: ["zcode-cli"] },
  // startupRecoveryProcessNames drives state.js's running-agent detection.
  //   - mac/linux: `zcode-cli` is the unambiguous standalone runtime (verified
  //     on macOS 3.4.2), so it participates directly.
  //   - win: the Windows runtime is the desktop shell `ZCode.exe` reused to run
  //     `... zcode.cjs app-server` (ELECTRON_RUN_AS_NODE=1). The bare name is
  //     ambiguous (the always-running shell would be mis-credited), so win
  //     uses the `(Name='ZCode.exe' AND CommandLine LIKE '%zcode.cjs%')` joint
  //     form declared separately in state.js's commandLineNeedles — NOT this
  //     name list. Leaving win:[] here keeps the shell out of the pure-name
  //     scan while the joint clause catches the real working process.
  startupRecoveryProcessNames: { win: [], mac: ["zcode-cli"], linux: ["zcode-cli"] },
  eventSource: "hook",
  // ZCode has no SessionEnd event; session completion relies on Stop + the
  // app's auto-fallback timeout. PostToolUseFailure maps to `error` (a tool
  // failed), matching the authoritative state-mapping table and Qoder.
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    notificationHook: false,
    interactiveBubble: false,
    sessionEnd: false,
    subagent: false,
  },
  hookConfig: {
    configFormat: "zcode-config-json",
  },
  stdinFormat: "qwenHookJson",
};
