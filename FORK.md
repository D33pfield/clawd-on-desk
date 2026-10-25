# Fork notes

This is a personal fork of [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) (upstream), maintained at [D33pfield/clawd-on-desk](https://github.com/D33pfield/clawd-on-desk). It is not affiliated with or endorsed by the upstream project, and it does not expect to be merged back. For the official app, releases, translations and support, use upstream.

Everything upstream does still works. The fork adds three optional features and two small defaults changes, kept in separate commits so each can be reviewed, reverted or cherry-picked on its own. This file explains what they are, how the repository works, and how to keep the fork in step with upstream.

- [What the fork adds](#what-the-fork-adds)
- [What is not in this repository](#what-is-not-in-this-repository)
- [How the repository works](#how-the-repository-works)
- [Fork touchpoints](#fork-touchpoints)
- [Keeping up with upstream](#keeping-up-with-upstream)
- [Privacy and security](#privacy-and-security)

## What the fork adds

### Mood moments

Four independent, leaky mood channels (stress, satisfaction, fatigue, boredom) are fed by hook events: tool failures, failing and passing tests, clean finishes, permission decisions, time awake and time since the agent last did anything. While the pet is idle it occasionally plays a short animation for the strongest mood. Values are only ever shown as plain bars in a **Mood** window (menu: *Open Mood*); there are no numbers and no combined moods. State is saved to `~/.clawd/mood.json`.

- On by default (`moodEnabled`). Logic is in `src/mood.js` (pure functions with an explicit clock), persistence in `src/mood-store.js`, the window in `src/mood-window.js`.
- Themes opt in with an `idleMoods` list. The built-in Clawd theme lists placeholders that reuse existing animations, so it works with no extra art.

### Music headphones

While Spotify is playing on Windows the pet wears headphones, with two music notes floating up and a gentle nod at 60 bpm, on top of whatever animation is playing.

- `src/music.js` polls the Windows media session (a short hidden PowerShell call every 4 seconds, no helper program) and debounces the result. It does nothing on other platforms.
- The renderer has a renderer-only accessory slot called `music` that borrows the head slot's placement, so it follows the body and hides wherever hats hide. It is not part of the accessory catalog, settings or hit geometry.
- The headphones artwork is loaded by name (`music-headphones.svg`) from the active theme's assets. Themes without that file simply show nothing. The artwork is not in this repository (see below).
- There is currently no switch to turn the polling off.

### Chatter (local-LLM speech bubbles)

A local [Ollama](https://ollama.com) model writes one short line for the pet to say in a speech bubble. The code decides when to speak and what the model may know; the model only writes the words. **Off by default.**

- Turn it on from the tray or right-click menu (*Chatter*) or **Settings → Chatter**. It needs Ollama running on `127.0.0.1:11434` with at least one model installed. Nothing is sent anywhere else.
- Triggers: a random check-in timer (only while you are active), tests passing after failures, Claude hitting an error, you coming back after a long gap, and music starting. A hotkey (unassigned by default, set it under **Settings → Chatter** or **Shortcuts**) asks for a line immediately.
- Settings: personality (deadpan, wholesome, anxious, or your own text), model picker, check-in interval, how long a bubble stays up, a switch per situation, and a switch for showing the bubble at all (lines are still logged when it is off). Click a bubble to dismiss it. Turning chatter off unloads the model from memory.
- The model sees a short fact sheet built from whitelisted fields only (a trigger sentence, mood words, Claude's status and a coarse activity such as "editing files", a time-of-day bucket, whether music is playing, a streak). Prompts, command text, file names and paths are never passed to it.
- Lines, and the fact sheet behind each, are written to `session-debug.log` as `chatter trigger=... line=... facts=...`.
- Code: `src/chatter.js` (triggers, prompt, filters, Ollama calls), `src/chatter-bubble.js` and `chatter-bubble.html` (the bubble window), `src/settings-tab-chatter.js` (the Settings tab).

### Defaults and housekeeping

- `package-lock.json` points at `registry.npmjs.org` instead of `registry.npmmirror.com` (the same packages; every tarball hash is unchanged).
- `autoUpdateCheck` defaults to off, so this build never polls upstream releases.

## What is not in this repository

- **Artwork.** Clawd's art belongs to Anthropic (`assets/LICENSE`: all rights reserved, personal use only), so none of the fork's art is committed or published. The mood animations, the headphones, and the personal theme that carries them live outside the repository. The fork's code only refers to art by file name and degrades quietly when a file is missing.
- **Personal notes and the maintainer's own tooling** (design notes, sync scripts, the theme build script) are kept outside the repository.
- **No credentials.** The fork contains no API keys, tokens, passwords or personal addresses.

The application code is licensed under AGPL-3.0, as upstream. See `LICENSE` and `NOTICE.md`.

## How the repository works

This section is a short map for working on the fork. The authoritative references are `AGENTS.md` (commands, architecture, the rules for agent integrations) and `CONTRIBUTING.md`; `docs/project/` has the durable architecture notes.

**Shape.** Clawd is an Electron desktop pet. Agents report their state through hooks, plugins or log polling; the main process turns that into one shared state, and a separate render window plays the animation while an input window handles the mouse.

- Hook → `src/server.js` → `src/server-route-state.js` → `src/agent-runtime-main.js` → `src/state.js` → IPC to the renderer. `main.js` is the composition root that wires everything together.
- Settings: `src/prefs.js` (schema, defaults, load/save/validate) → `src/settings-controller.js` (the only writer) → `src/settings-store.js`. `src/settings-actions*.js` validate updates; `src/settings-effect-router.js` applies runtime effects after a commit. The Settings window is plain scripts, one per tab (`src/settings-tab-*.js`), built from helpers in `src/settings-ui-core.js`.
- Windows and surfaces: `src/pet-window-runtime.js` owns the pet's windows; `src/floating-window-runtime.js` repositions bubbles and floating windows when the pet moves or hides.
- Themes: `src/theme-loader.js` loads and sanitizes themes. Every `.svg` in a user theme's `assets` folder is sanitized and served, referenced or not.
- Shortcuts: actions are declared in `src/shortcut-actions.js` and bound to handlers in `main.js`; the Shortcuts tab lists every action.

**Rules that tests enforce.**

- A new pref needs an entry in `SCHEMA` in `src/prefs.js` and a validator in `updateRegistry` in `src/settings-actions.js`.
- Every UI string must exist in **all seven** locales in both `src/i18n.js` (menus) and `src/settings-i18n.js` (Settings); `test/i18n.test.js` fails on a missing key. The fork copies the English text into the other locales for its own strings.
- A new Settings tab must also be added to `SIDEBAR_TABS` and the `ALLOWED_TABS` deep-link list, with an icon in `src/settings-icons.js` and a script tag in `src/settings.html`.
- A new shortcut action needs a handler in `main.js`, and tests that list the default shortcut map need the new entry.

**Commands.**

```bash
npm install
npm start                       # run from source
npm test                        # the whole suite (node --test)
node --test test/music.test.js  # one file
npm run audit:assets            # after adding or changing artwork
```

The suite has some known failures that are environment-related, not caused by the fork: hook-installer and Windows-path tests, and the Electron-based tests on Linux/WSL without a display. Compare against a clean checkout of upstream before assuming a failure is yours.

**Commit style.** A light conventional style, for example `feat(chatter): ...`, `fix(music): ...`, `docs(fork): ...`. One responsibility per commit.

## Fork touchpoints

New files are listed per feature. Edits to upstream files are kept small, with the logic in the new files, to keep upstream merges easy. These are the places a merge conflict is likely.

### Mood (`feat(mood)`)

New: `src/mood.js`, `src/mood-store.js`, `src/mood-window.js`, `src/mood.html`, `src/mood-renderer.js`, `src/preload-mood.js`, and tests `test/mood*.test.js`, `test/menu-mood.test.js`, `test/permission-mood-tap.test.js`.

| Upstream file | Why it is touched |
|---|---|
| `src/main.js` | create the tracker, store and window; flush on quit; feed the idle roll |
| `src/server-route-state.js` | tap hook events (tool failures, test results, stops) into the tracker |
| `src/permission.js` | tap allow/deny clicks |
| `src/tick.js` | the idle roll that may play a mood moment |
| `src/theme-schema.js`, `themes/clawd/theme.json` | the `idleMoods` theme field and its placeholders |
| `src/prefs.js`, `src/settings-actions.js` | the `moodEnabled` pref |
| `src/menu.js`, `src/i18n.js` | the *Open Mood* menu item |

### Music headphones (`feat(music)`)

New: `src/music.js`, `test/music.test.js`.

| Upstream file | Why it is touched |
|---|---|
| `src/main.js` | create and start the detector; send its state to the renderer; resend after a renderer reload |
| `src/renderer.js` | the renderer-only `music` slot and the nod toggle |
| `src/index.html`, `src/styles.css` | the slot's layer (behind the pet) and the 60 bpm nod |
| `src/preload.js` | the `music-state` channel |
| `test/renderer-low-power.test.js` | renderer harness additions and the slot's tests |

### Chatter (`feat(chatter)`)

New: `src/chatter.js`, `src/chatter-bubble.js`, `src/chatter-bubble.html`, `src/preload-chatter-bubble.js`, `src/settings-tab-chatter.js`, and tests `test/chatter*.test.js`, `test/settings-tab-chatter.test.js`.

| Upstream file | Why it is touched |
|---|---|
| `src/main.js` | create the chatter and its bubble; read prefs; the hotkey handler; pref-change reactions; the music hook |
| `src/server-route-state.js` | a separate tap for chatter (its own flag; skips headless sessions) |
| `src/prefs.js`, `src/settings-actions.js` | the twelve `chatter*` prefs and validators |
| `src/settings-ui-core.js` | repaint shortcut recording on the Chatter tab as well as the Shortcuts tab |
| `src/settings-renderer.js`, `src/settings.html`, `src/settings-window.js`, `src/settings-icons.js`, `src/settings-i18n.js` | register the Chatter tab, its icon and strings |
| `src/settings-tab-shortcuts.js`, `src/shortcut-actions.js` | the `chatterNow` hotkey and a reusable shortcut row |
| `src/settings-ipc.js`, `src/preload-settings.js` | the installed-models list for the model picker |
| `src/settings-effect-router.js`, `src/menu.js`, `src/i18n.js` | rebuild the menu on change; the *Chatter* menu checkbox |
| `src/floating-window-runtime.js` | move and hide the bubble with the pet |
| `src/renderer.js` | `getDisplayedContentTop()`, so the bubble sits just above the current artwork |
| tests listing the default shortcut map | one more entry, `chatterNow` |

### Housekeeping (`chore(fork)`)

`package-lock.json` (registry host), `src/updater.js` and `src/prefs.js` (`autoUpdateCheck` defaults to off).

## Keeping up with upstream

Upstream moves quickly. The fork pulls changes with merges, not rebases, because the fork is public and rebasing would mean force-pushing.

```bash
git fetch upstream
git switch -c sync/$(date +%Y-%m-%d) main
git merge upstream/main          # resolve conflicts, usually in the files listed above
npm test                         # compare failures against a clean upstream checkout
# fix anything the merge broke, then:
git switch main && git merge --no-ff sync/<date>
```

After a merge: re-run the tests, rebuild any personal theme that carries the optional artwork, and restart the app. Conflicts concentrate in `src/main.js`, `src/prefs.js`, `src/settings-ui-core.js`, `src/settings-i18n.js` and `src/i18n.js`; the touchpoint tables above say what each fork edit is for.

If upstream ever changes a convention the fork relies on (the pref schema, the i18n parity rule, the shortcut map), the tests listed under "Rules that tests enforce" will say so.

## Privacy and security

- The fork makes no network requests of its own except to a local Ollama server (`127.0.0.1:11434`) when chatter is turned on, and a local PowerShell call for the music detector on Windows.
- Chatter's prompt is built only from whitelisted fields (see above). Its output is shown with `textContent`, never as markup, and its bubble window ignores the mouse except while the pointer is over the bubble.
- Do not open public issues for security problems. Use upstream's private vulnerability reporting for anything that concerns upstream code, or contact the fork's maintainer through GitHub for fork-only code.
