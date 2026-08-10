# Manual validation: Remote SSH Codespaces serialization (#546)

This harness validates the Windows OpenSSH + `gh cs ssh --stdio` boundary that unit tests cannot prove. It creates (or accepts) one exact Codespace, generates an isolated SSH config under a timestamped evidence directory, runs the sequential control and effective-transport checks, then starts the development app with a temporary `USERPROFILE` so the user's real `~/.ssh/config` is not edited.

Run it from an elevated/out-of-sandbox PowerShell whose `gh auth status` includes the `codespace` scope. The development app receives an explicit temporary OpenSSH `-F` config through `CLAWD_REMOTE_SSH_CONFIG_FILE` and a temporary Electron `--user-data-dir`, so neither SSH config nor Clawd prefs are read from or written to the user's normal profile. (`USERPROFILE` alone does not redirect Windows OpenSSH.)

```powershell
pwsh -NoProfile -File scripts/manual/remote-ssh-codespaces-546.ps1 `
  -Repository owner/repository `
  -Branch main
```

Use `-ExistingCodespace <exact-name>` to reuse a dedicated test Codespace. The script deletes only a Codespace it created itself; `-KeepCodespace` disables that deletion. It never uses `taskkill`, `Stop-Process`, or process-name cleanup. If exact test residue remains, it records safe PID/role/command hashes, preserves the processes, and asks for manual inspection.

## App checklist (V3-V14)

Create one Remote SSH profile using the alias printed by the script. Do not copy the temporary SSH config into the real user config.

- V3 — Disable automatic Codex monitor, Connect, and confirm Connected with one managed SSH/ProxyCommand chain.
- V4 — Enable automatic Codex monitor, reconnect, and confirm monitor one-shots finish before the persistent tunnel.
- V5 — While Connected, run Deploy / Repair. Confirm the old tunnel closes naturally before the first deploy SSH/SCP and exactly one tunnel resumes afterward.
- V6 — Covered by module/manual composition and automated timeout tests; packaged builds expose no failure-injection switch.
- V7 — Start Deploy, click Disconnect during it, and confirm no tunnel resumes.
- V8 — Use a test profile with deliberately stale detected Node metadata; confirm rediscovery happens only after the prior tunnel closes.
- V9 — Use a test-owned remote port holder created by a completed sequential SSH command. Connect must surface `ExitOnForwardFailure`, never Connected. Stop the holder only after Connect has ended.
- V10 — Run the dedicated readiness contract against a test-only identity under `/tmp/clawd-546-<challenge>`; never edit a production Clawd identity or bypass lease/fencing.
- V11 — Add a second profile for the same Codespace. Its Connect must return busy and start no second ProxyCommand chain.
- V12 — Open Terminal must be blocked while the serialized managed session is non-idle, and work after explicit Disconnect.
- V13 — Stay Connected for at least 60 seconds (two ServerAlive intervals), send one real supported hook event, and observe the local state transition.
- V14 — Disconnect and quit Clawd normally. The harness checks for exact Codespace-related `ssh.exe`/`gh.exe` residue after app exit.

Record each observed result in the issue/PR alongside `evidence.json`. The evidence deliberately excludes raw SSH config, ProxyCommand, argv, identity data, paths, tokens, and routing nonces.

## V15 ordinary-host release blocker

The Codespaces script cannot validate the unchanged parallel path. Before release, use a separate ordinary Linux SSH host and verify Connect, Deploy / Repair, optional monitor, Disconnect, cleanup, and normal app quit. If no ordinary host is available, report V15 as pending; do not infer it from Codespaces or unit tests.
