## v0.15.0

v0.15.0 is a quota-legibility, free-roam, and platform-reliability release. The
subscription quota ring becomes readable at a glance — identity-based colors, vendor
glyphs, and a readout that follows whichever window is actually raising the alarm.
Free roam gains two independent ways to bound where the pet wanders. The OpenCode
family, Codex, macOS, and Windows runtime paths each closed a set of real-world
defects reported against v0.14.0.

This release also takes over WinGet manifest publishing after discovering that x64
users had been receiving the ARM64 installer since v0.6.2, and welcomes **three
first-time contributors**.

### Subscription Quota And Usage

- **Identity-based ring colors and vendor glyphs** (#863) — healthy rings are colored
  by source identity rather than headroom, so the rolling and weekly windows stay
  distinguishable instead of collapsing into one thick green band. The Claude coin now
  carries the vendor mark from the same MIT icon upstream as the other 21 runtime
  icons; the remaining icons are byte-for-byte unchanged, with provenance and hashes
  updated in `source-manifest.json` and the MIT attribution list in `NOTICE.md`.
- **The readout follows the alert** (#864) — the coin used to always print the rolling
  window while the ring colored itself from the tightest window, so a coin could read
  "1% 5h" while the inner ring sat at 61% amber. The title now hands over to the
  tightest window once it crosses the warning threshold, which keeps color from being
  the only carrier of an alert. A flashback briefly replays the rolling number at the
  moments it is most likely to be asked about, and each coin's glyph is scaled to its
  own artwork rather than one shared zoom.
- **Used / Remaining display modes** (#789) — a persisted preference selects whether
  the ring reports consumption or headroom, without changing quota ingestion or the
  warning thresholds. The same change consolidates reusable Settings buttons, warning
  dialogs, segmented choices, and dropdown behavior, and stabilizes Settings scrolling
  and dropdown lifecycles — including the theme-accessory case that previously lost its
  real scroll range after a selection. Thanks to @YOIMIYA66.
- **Correct context windows for custom Claude models** (#809, issue #797) — context
  usage is read from the Claude statusline rather than inferred, so a custom model no
  longer displays a context length that does not match the model actually in use.

### Free Roam

- **Constrain to axis** (#795, issue #686) — an opt-in setting restricts idle wandering
  to horizontal or vertical movement only, for users who prefer grid-aligned motion
  over diagonal drift. Default off, so existing behavior is unchanged. Thanks to
  first-time contributor @weed33834.
- **Optional roam fence** (#810) — free roam can be bounded to a rectangle expressed as
  fractions of the work area, so the pet can be kept to, say, the bottom-right quadrant.
  The fence is re-read on every target pick, so edits apply live without a restart, and
  the minimum hop distance scales down so small fences still produce reachable targets.
  Thanks to @anthonyonazure.
- **Hardened axis targets** (#819) — axis-constrained targets are clamped against the
  same bounds as unconstrained ones, and the movement-style wording is clarified.

### OpenCode Family

- **Real session titles in the HUD** (#841, issue #829) — OpenCode sessions show their
  actual title instead of the project folder, and the title updates after OpenCode
  renames a session. Titles are bounded, kept out of logs, and carry no telemetry
  stamp. Thanks to first-time contributor @xiaoshidefeng.
- **No premature idle during long active work** (#853, issue #850) — an active agent
  could fall back to idle mid-task and release the session; the stale floor is now
  scoped to interactive sessions and no longer fires while tools are still running.
  Thanks to @PeterShanxin.
- **Ordered state delivery and directory-scoped disposal** (#855, #858) — `/state`
  requests for one session are serialized so an older lifecycle request can no longer
  arrive after a newer rename and restore the stale title, and
  `server.instance.disposed` clears only the disposing directory's sessions instead of
  every cached session process-wide. Regression coverage locks the stale-floor
  boundaries.
- **Session cwd bound to its owning session** (#798, issue #796) — a session's working
  directory can no longer be attributed to a different session.

### Codex Runtime

- **Terminal turns fenced across event sources** (#831, issue #821) — after a Codex turn
  ends, late `PreToolUse` / `PostToolUse` events can no longer pull the pet back into a
  typing state, and `token_count` telemetry is separated from session liveness so a
  metadata refresh cannot keep a stuck working session from timing out.
- **Bounded rollout log reads** (#820, issue #817) — rollout log consumption is bounded
  and recovery retries are hardened, closing a main-process error path.
- **No flicker during Codex Pet drag transitions** (#804, issue #620) — drag direction,
  release, and state changes switch animation rows inside the already-loaded SVG
  document rather than rebuilding the spritesheet, removing the intermittent transparent
  frame. (#803 reverts an earlier direct push of the same fix so it could land through
  review.)

### Platform: macOS

- **Menu bar and Dock settings restored** (#851) — the menu-bar and Dock visibility
  preferences apply and persist correctly again.
- **Pinning against physical display bounds** (#826, issue #241) — edge pinning uses
  physical display bounds, so the pet can reach the bottom of the screen when the Dock
  is present and bottom pinning stays on-screen.

### Platform: Windows

- **Server-side process-chain resolution** (#837, issue #694) — native Windows process
  ancestry queries (`NtQueryInformationProcess` primary, Toolhelp comparison) move
  eligible `/state` and Codex `/permission` process-metadata resolution into the server,
  with per-agent `legacy | shadow | b1a-authoritative` capability routing and bounded
  shadow parity diagnostics. In authoritative mode the legacy hook-side PowerShell
  snapshot is structurally skipped.
- **Hardened FFI initialization and per-registry Koffi caching** (#839, #840, issue
  #838) — process-query FFI initialization no longer fails open, and Koffi bindings are
  cached per registry rather than re-resolved.
- **Target-native Koffi packaging and foreign-native audit** (#824, issue #763) — each
  release target keeps exactly one architecture-matching `koffi.node`, and a native
  inventory audit rejects every foreign-architecture binary except the
  electron-builder-managed Windows ia32 `elevate.exe` helper.

### Agents And Diagnostics

- **QwenWork (千问办公)** (#843) — a hook-only, state-only integration modeled on
  QoderWork. The pet reflects QwenWork lifecycle state while permission decisions stay
  entirely in QwenWork's native flow: `PermissionRequest` / `PermissionDenied` are
  observation-only and the hook always returns `{}`. Detection, install, and uninstall
  go through `~/.QwenWorkCN/settings.json`. Windows and macOS only — QwenWork currently
  ships no official Linux client. Thanks to first-time contributor @xiaoshidefeng.
- **Hermes WSL Pair and Unpair** (#842, issue #540) — pairing and unpairing work against
  WSL targets.
- **Unreviewed Codex hooks explained in Doctor** (#854) — Doctor distinguishes "hooks
  are missing" from "hooks are installed but still need review in Codex `/hooks`", which
  was the actual cause behind several "no permission prompt appears" reports.

### Dashboard, Remote Access, And Notifications

- **Persisted Sessions/Dashboard window bounds** (#807, #814, issue #801) — the window
  remembers its position and size, with hardened persistence against invalid or
  off-screen bounds. Thanks to @KaiC5504.
- **Serialized Codespaces SSH transport** (#845, issue #546) — concurrent Codespaces
  `gh cs ssh --stdio` activity no longer breaks Remote SSH deploy/probe on Windows.
- **Safe Remote SSH reconnects** (#808, issue #800) — reconnect after a dropped
  connection recovers instead of failing permanently.
- **Safe HTML in Telegram messages** (#802, issue #766) — message rendering escapes
  agent-controlled content instead of emitting it into Telegram's HTML parse mode.

### Packaging, Security, And Localization

- **WinGet manifest self-publishing groundwork** (#861, issue #860) — a prepare-only
  workflow generates the manifest komac would submit and gates it on an architecture
  contract. `rullerzhou-afk.clawd-on-desk` has been live in `microsoft/winget-pkgs`
  since 2026-04-20 without ever being submitted by this project: a third-party release
  tracker picked it up and, from v0.6.2 onward, produced manifests declaring two
  `Architecture: x64` entries that both pointed at the **ARM64** installer. The NSIS
  stub runs on x64, so the install reported success and the app then failed to launch.
  Automatic submission stays deliberately disabled until the upstream manifest is
  repaired by hand and komac's output is validated.
- **npm dependency security hardening** (#846) — dependency and package validation are
  tightened.
- **Brazilian Portuguese (pt-BR)** (#822, #827) — a full pt-BR locale, with references
  and language entry points synced. Thanks to first-time contributor @arismarioneves.
- **Documentation accuracy** (#828, #849) — AGENTS references are corrected, contributor
  credits updated, and runtime/safety boundaries synced with the code.

### Contributors

Three first-time contributors landed changes in this release:

- @weed33834 — axis-constrained roam mode (#795)
- @arismarioneves — Brazilian Portuguese locale (#822)
- @xiaoshidefeng — OpenCode session titles (#841) and the QwenWork integration (#843)

Returning contributors: @YOIMIYA66 (#789), @PeterShanxin (#853), @KaiC5504 (#807), and
@anthonyonazure (#810), whose accessory and tint work shipped in v0.14.0 through
co-author credit and who now lands a directly authored change.

### Upgrade Notes

- Launch Clawd once after upgrading so installed and enabled integrations can reconcile
  their managed hooks/plugins against the packaged v0.15.0 files.
- QwenWork is a new state-only integration and is not enabled by default. It requires
  the QwenWork desktop application on Windows or macOS.
- Quota ring display mode (Used / Remaining) defaults to the existing behavior; no
  action is required to keep the previous readout.
- Free roam fence and axis constraint are both opt-in. With no fence file and the axis
  setting off, roaming behaves exactly as in v0.14.0.
- Windows installs that used a WinGet-provided package before this release may be on the
  ARM64 build regardless of their architecture. Reinstalling from the GitHub release
  asset for the correct architecture is the reliable path until the corrected WinGet
  manifest is live.

### Validation Status

> **Draft — not yet filled in.** This section is completed after the draft release is
> built and smoke-tested, following `docs/project/release-process.md`. It must record:
> the review passes that ran, the automated suite result, the asset audit, the final
> multi-platform package build, which platforms received real-machine validation, and
> any platform recorded as not real-machine validated.
