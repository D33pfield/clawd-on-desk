# Outlaw Clawd

Cowboy theme + roam fence, built 2026-08-04.

## What's here

- `../../themes/clawd-outlaw/` — full theme: every clawd sprite restamped with a pixel cowboy hat (creased crown, wide curled brim), a toggleable cigarette layer (ember pulse + drifting smoke), and `clawd-outlaw-bender.svg`, a 15-second idle animation where a bored Clawd drinks, smokes, sways, and passes out with floating Zzz. Sleep sprites stay bare (he takes the hat off for the night).
- `build-outlaw-theme.py` — regenerates the theme from the app's stock sprites. Hat and cigarette are defined once as pixel-rect groups and injected after each sprite's torso rect, inside the animated body group, so accessories track every pose. Edit the `HAT_STD` / `CIG` constants and rerun to restyle.
- `clawd-cig.sh` — `clawd-cig on|off`: toggles the cigarette layer across the theme and restarts the pet.
- `clawd-roam.sh` — `clawd-roam bottom-right|bottom|full|<l> <t> <r> <b>`: writes `~/.clawd/roam-area.json`, the roam fence read live by the patched `src/roam.js` (fractions of the work area, applied on the next wander, no restart).

## Install (local machine)

Theme goes to `~/Library/Application Support/clawd-on-desk/themes/clawd-outlaw/`, scripts symlink into PATH. The roam fence needs the patched `src/roam.js` in the running app.

## Gotcha

Never launch the app from a VSCode/Claude Code shell without a clean env: `ELECTRON_RUN_AS_NODE=1` is inherited and makes Electron exit silently. Use:

```sh
env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin /usr/bin/open -a "Clawd on Desk"
```
