# DeepSeek Harness Integration

[Back to the setup guide](setup-guide.md)

Clawd integrates [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) in two layers:

1. **Perception (zero-touch)** — a built-in monitor polls the durable JSON side of the harness (the same data files the web UI's own read models persist to) and derives pet states. Nothing is written into DSH.
2. **Interaction (opt-in, Clawd-managed)** — when you explicitly install the integration, Clawd registers its `@dsh-external/dsh-clawd-bridge` plugin into the DSH web profile. The bridge forwards DSH's `ask_user_question` and sandbox-approval requests to Clawd's permission bubbles and returns your decision to DSH.

## How it works

### Perception

DSH persists two plain-JSON files under `$DSH_HOME` (default `~/.dsh`, or `C:\Users\<you>\.dsh` on Windows), both atomically rewritten (temp file + rename):

| File | What Clawd reads |
|---|---|
| `storages/workspace.json` | which sessions exist (workspace → session IDs) and the archived-session list |
| `storages/session_projcache.json` | per-session projection cache: `sessionStats.openStep` / `pendingCalls` (the agent is working right now), `sessionListMetadata.lastPromptAt` (the user just submitted a prompt), `title`, and `identity.cwd` |

The monitor maps that data to Clawd states:

| DSH signal | Clawd state |
|---|---|
| session first seen | `idle` / `SessionStart` |
| fresh `lastPromptAt` | `thinking` / `UserPromptSubmit` |
| open LLM step or pending tool call (cache freshly written) | `working` / `PreToolUse` |
| work stopped, no new prompt | `attention` / `Stop` |
| session removed / archived | `idle` / `SessionEnd` |

### Interaction (the bridge)

The bridge plugin lives in this repository at `hooks/dsh-clawd-bridge/` and is installed into the DSH **web profile** (the default `dsh web` surface) with the official `dsh plugin --profile web add` command, which runs pnpm and reconciles the profile's bundle layer automatically. It is only installed on an explicit user action — the Settings Install button or a doctor repair — never during startup sync.

| DSH request | Bridge behavior | Clawd surface |
|---|---|---|
| `ask_user_question` tool call | POST `/permission` with `hook_event_name: AskUserQuestion` | elicitation bubble with the question and options; the chosen answer is returned to DSH |
| sandbox escalation (`approval/request`) | POST `/permission` with `hook_event_name: PermissionRequest` | permission bubble with the tool arguments and reason; allow/deny is returned to DSH |

Failure behavior is fail-closed on both sides:

- Clawd unreachable or declining → the bridge falls back to DSH's own web UI answerer for questions, and the approval fails closed (`unavailable`) for escalations.
- Bridge registration/removal failure → reported as an integration error; DSH detection and the monitor are unaffected.
- Uninstall removes the bridge plugin from the DSH profile (`dsh plugin --profile web remove`) — the perception layer has nothing to remove.

## Latency and fidelity

- DSH writes the projection cache on a throttle (web profile: every 200 events or 5 s after the first dirty event) plus mandatory `turn/end` and session-dispose checkpoints. The monitor polls on a ~1.5 s interval, so state changes appear with **seconds-level latency**, not event-exact.
- A cached "working" signal older than ~30 s is ignored, so a session left open when DSH was quit does not get stuck animating forever.
- Sessions already present when Clawd starts are announced idle; their historical prompt timestamp is seeded so an old prompt never replays as a fresh submission.

## Requirements

- **DeepSeek Harness** running on the same machine with its default `$DSH_HOME` (`~/.dsh`). If you relocated DSH home, set the `DSH_HOME` environment variable when launching Clawd.
- The web profile (the default `dsh web` surface) — its bundle configures the projection cache that the monitor reads.
- The `dsh` CLI on `PATH` (for bridge install/uninstall; the perception layer only needs the data files).

## Install

1. Open **Settings → Agents**.
2. Find **DeepSeek Harness** and click **Install** — this enables detection **and** registers the interactive bridge plugin into the DSH web profile (idempotent; a re-install is a no-op).
3. Make sure the agent is **enabled**.
4. The permission bubble toggle for DeepSeek Harness must stay on (it is on by default).

Or from the command line:

```bash
npm run install:dsh                    # detection only (zero-touch)
node hooks/dsh-install.js --install-bridge      # register the bridge plugin
node hooks/dsh-install.js --uninstall-bridge    # remove the bridge plugin
npm run uninstall:dsh                  # detection-only uninstall + bridge removal
```

After installing or removing the bridge, restart DSH (`dsh web`) so its profile picks up the change.

## Notes

- **Perception is state-only**: reading DSH's data files never modifies DSH. Only the explicit bridge install writes into the DSH profile (the Clawd-managed plugin dependency), and uninstall removes it.
- **Interactive requests**: with the bridge installed, `ask_user_question` and sandbox escalations surface as Clawd permission bubbles; without it, DSH keeps its native web-UI answerer and fails escalations closed when no answerer is available.
- **No terminal focus**: DSH is a browser surface, so sessions are marked `webui` and are excluded from terminal-focus and process-chain logic.
- **Local only**: the monitor reads DSH's data on this machine. Remote SSH / WSL deployment of DSH is not supported in this version.
