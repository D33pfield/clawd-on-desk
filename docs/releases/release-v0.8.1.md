## v0.8.1

### New Features

- **Copilot CLI hook auto-sync** (#341) - Copilot CLI hooks now auto-register at Clawd startup like Claude Code / Codex / Cursor — no more manual `~/.copilot/hooks/hooks.json` setup. Path resolution honors `$COPILOT_HOME` (trimmed; empty / whitespace falls back to `~/.copilot`); 10 events covered (the previously missing `preCompact` is now included so compaction shows the sweeping animation). Doctor switches Copilot to a dedicated `copilot-hooks` mode that scans `bash` / `powershell` / `command` fields, validates per-event coverage, and surfaces `disableAllHooks: true` (in `hooks.json` or `settings.json`) as `not-connected + level: warning + supplementary` with the Fix button intentionally suppressed so Clawd never overrides an explicit opt-out. marker-based merge preserves your other hook entries and other `hooks/*.json` files untouched.

### Bug Fixes

- **Pi agent restored to state-only mode** (#322) - Pi extension reports lifecycle and tool activity only. Clawd no longer shows Pi permission bubbles, no longer calls Pi terminal confirmation, and preserves Pi's default YOLO execution behavior.
- **Legacy Pi permission hook compatibility** - Older in-memory Pi extension instances that still POST `/permission` now receive an allow response from Clawd, so they do not get blocked by stale bubble logic while the user is upgrading.

### Upgrade Notes

- Existing v0.8.0 profiles with the Pi permission bubble subgate enabled are migrated back to `false` because the subgate no longer has runtime effect.
- Restart already-running Pi agent sessions after upgrading. Until restart, an old in-memory extension may still try the former `/permission` path; Clawd online will allow it, but if Clawd is offline that old extension can still fall back to Pi terminal confirmation.
- **Copilot CLI hooks are now auto-synced on first launch.** If you previously hand-wrote `~/.copilot/hooks/hooks.json` (or `$COPILOT_HOME/hooks/hooks.json`), Clawd-owned entries — anything whose `bash` / `powershell` / `command` references `copilot-hook.js` — get rewritten to use the resolved absolute Node binary path and the canonical 10-event set. Non-Clawd entries and other files under `hooks/` are left untouched. Back up `hooks.json` first if you have customized any Clawd-marker entries you want to preserve. (#341)
