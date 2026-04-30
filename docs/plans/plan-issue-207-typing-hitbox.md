# Plan: Issue #207 Typing Terminal Hitbox

## Context

Issue #207 reports that `clawd-working-typing.svg` visually invites users to click the small terminal / computer above Clawd, but that area is not clickable:

> workingTiers[clawd-working-typing.svg] 这个图标，我总想点击小电脑

Follow-up asks whether Clawd plans to adjust the clickable area. The current behavior is understandable: the typing asset draws the mini screen at roughly `y=-6..4.5` in the Clawd viewBox, while the default hitbox starts at `y=5`. Even the existing `wide` hitbox starts at `y=3`, so it only catches the very bottom of the screen, not the main visual target.

## Current Architecture

Clawd uses a dual-window input model:

- `win` renders the visible pet and is permanently click-through.
- `hitWin` is a separate transparent input window clipped to a rectangular hitbox by `setShape()`.
- `src/main.js:syncHitWin()` positions `hitWin` from `hitGeometry.getHitRectScreen(...)`.
- `src/state.js` currently chooses `currentHitBox` from three theme-level buckets:
  - `hitBoxes.default`
  - `hitBoxes.wide` when `currentSvg` is in `wideHitboxFiles`
  - `hitBoxes.sleeping` when `currentSvg` is in `sleepingHitboxFiles`

For non-idle states, `src/hit-renderer.js` already routes a click to `focusTerminal()`. Therefore the missing behavior is not a new action; it is only a geometry problem.

## Goals

1. Make the mini terminal / computer area in `clawd-working-typing.svg` clickable.
2. Keep the existing dual-window input model unchanged.
3. Avoid impacting Calico, user themes, and existing theme overrides unless they opt into the new field.
4. Make the change a reusable theme capability instead of hardcoding one Clawd filename in runtime code.

## Non-Goals

- No per-pixel SVG hit testing.
- No change to `win.setIgnoreMouseEvents(true)`.
- No Settings UI for editing arbitrary hitboxes in this pass.
- No attempt to make every decorative animation element clickable.
- No multi-rect hit shapes in this pass unless review finds the single-rect approach unacceptable.

## Proposed Design

Add a new optional theme field:

```json
"fileHitBoxes": {
  "clawd-working-typing.svg": {
    "x": -2,
    "y": -7,
    "w": 20,
    "h": 24
  }
}
```

Coordinates use the same viewBox coordinate system as `hitBoxes.default / wide / sleeping`.

All keys must be normalized with the same basename rules as other theme file references. Runtime state stores `currentSvg` as the basename returned by `resolveVisualBinding()` / `getSvgOverride()`, so file-hitbox lookup must use basename keys too.

Selection priority:

1. `theme.fileHitBoxes[currentSvg]`
2. `theme.hitBoxes.sleeping` if `currentSvg` is in `sleepingHitboxFiles`
3. `theme.hitBoxes.wide` if `currentSvg` is in `wideHitboxFiles`
4. `theme.hitBoxes.default`

Rationale:

- File-specific configuration is the strongest author intent.
- Existing themes remain unchanged because `fileHitBoxes` is optional and empty by default.
- The runtime keeps using one rectangular `hitWin` shape, so Windows drag/click behavior stays on the proven path.
- A single larger rectangle is enough for #207: clicking the small screen should focus the terminal, and small transparent margins around the screen are acceptable.

## Implementation Plan

### 1. Theme Loader

File: `src/theme-loader.js`

- Add `fileHitBoxes` to merged theme output, defaulting to `{}`.
- Add a normalizer helper, for example `normalizeFileHitBoxes(value)`, and call it from `mergeDefaults`.
- Normalize entries defensively:
  - key must be normalized with `_basenameOnly(key)`
  - value must have finite numeric `x`, `y`, `w`, `h`
  - `w > 0`, `h > 0`
- Add `fileHitBoxes` to `VARIANT_ALLOWED_KEYS`.
- Add dedicated variant merge behavior for `fileHitBoxes`:
  - top-level file keys merge so variants can add one file without replacing the entire map
  - each file's rect replaces as a whole
  - do **not** use the default `_deepMergeObject()` behavior for individual rects, because `{ "typing.svg": { "x": 5 } }` should not silently inherit old `y/w/h`
- In `_applyVariantPatch()`, handle `key === "fileHitBoxes"` with an explicit early branch after the allow-list check and before the default `VARIANT_REPLACE_FIELDS` / `_deepMergeObject()` dispatch. Adding the field to `VARIANT_ALLOWED_KEYS` is not enough; without this branch, it will fall back to the exact deep-merge behavior this plan is avoiding.
- When a `fileHitBoxes` entry is rejected, emit a `console.warn` with the raw key and reason. Invalid hand-authored geometry should not fail silently.

Sketch:

```js
function normalizeFileHitBoxes(value) {
  const out = {};
  if (!_isPlainObject(value)) return out;
  for (const [rawKey, box] of Object.entries(value)) {
    const key = _basenameOnly(rawKey);
    if (!key || !_isPlainObject(box)) {
      console.warn(`[theme-loader] fileHitBoxes["${rawKey}"] dropped: expected object with finite x/y/w/h`);
      continue;
    }
    const { x, y, w, h } = box;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      console.warn(`[theme-loader] fileHitBoxes["${rawKey}"] dropped: missing/invalid x/y/w/h`);
      continue;
    }
    out[key] = { x, y, w, h };
  }
  return out;
}
```

Variant merge sketch:

```js
function mergeFileHitBoxes(base, patch) {
  return {
    ...normalizeFileHitBoxes(base),
    ...normalizeFileHitBoxes(patch),
  };
}
```

Required `_applyVariantPatch()` hook:

```js
if (key === "fileHitBoxes") {
  patched.fileHitBoxes = mergeFileHitBoxes(patched.fileHitBoxes, value);
  continue;
}
```

Open question for review:

- Should validation require the filename to resolve to a known asset, or only normalize shape and let unused entries be harmless? Strict validation catches typos, but loose validation is more compatible with theme authors during iteration.

### 2. State Hitbox Selection

File: `src/state.js`

- Add a small helper, for example:

```js
function resolveHitBoxForSvg(svg) {
  if (svg && FILE_HIT_BOXES[svg]) return FILE_HIT_BOXES[svg];
  if (svg && SLEEPING_SVGS.has(svg)) return HIT_BOXES.sleeping;
  if (svg && WIDE_SVGS.has(svg)) return HIT_BOXES.wide;
  return HIT_BOXES.default;
}
```

- Use it in both existing places that currently duplicate hitbox selection:
  - `refreshTheme()`
  - `applyState()`

This keeps runtime behavior identical except for files explicitly configured in `fileHitBoxes`.

### 3. Clawd Theme Config

File: `themes/clawd/theme.json`

- Add one entry for `clawd-working-typing.svg`.
- Tune the rectangle against the current SVG:
  - include the mini screen at `x≈0.75..14.25`, `y≈-6..4.5`
  - include the body / keyboard so drag remains natural from the lower visible shape
  - avoid expanding far into the left-side transparent padding
- If a variant or override swaps the typing visual to a different filename, add a matching `fileHitBoxes` entry for that final filename too. For example, `assets/svg/old/clawd-working-typing-boss.svg` was added in `f881648` for #207; if it becomes a Clawd variant asset, the variant must provide its own file hitbox.

Initial candidate:

```json
"fileHitBoxes": {
  "clawd-working-typing.svg": {
    "x": -2,
    "y": -7,
    "w": 20,
    "h": 24
  }
}
```

This roughly covers `x=-2..18`, `y=-7..17`, including screen, body, keyboard, and a small margin.

Important behavior note:

- `fileHitBoxes` applies to the final displayed SVG filename, not the logical state name.
- For `working`, the displayed file may be chosen by display hint first, then `workingTiers` (`1 -> typing`, `2 -> juggling`, `3+ -> building`).
- Therefore this #207 entry affects cases where the final file is `clawd-working-typing.svg`. If another display hint or tier chooses a different file, that file needs its own entry.

### 4. Tests

Recommended tests:

- `test/theme-loader.test.js`
  - loads themes without `fileHitBoxes` as `{}` or equivalent empty object
  - preserves a valid `fileHitBoxes` entry
  - normalizes path-like keys with `_basenameOnly()`
  - drops invalid boxes
  - variant can add a file hitbox without replacing the whole map
  - variant replacing a file rect does not deep-merge partial rect fields
- `test/state.test.js` or a focused state display test
  - when current SVG has a file hitbox, `getCurrentHitBox()` returns it
  - sleeping / wide / default fallback still works for files without file-specific entries
- `test/hit-geometry.test.js`
  - optional numeric assertion that Clawd typing hit rect top moves above the default/wide top

Manual verification:

- Start Clawd.
- Force working typing state.
- Click the mini screen area: terminal focus should trigger.
- Drag from screen/body/keyboard: drag should still begin and end normally.
- Right-click the enlarged typing hitbox: context menu should still open.
- Switch to Calico and confirm hit area is unchanged.
- If `bubbleFollowPet` is enabled, verify permission/update bubble and Session HUD placement around typing still looks acceptable. Some follow-pet layouts use `getHitRectScreen()`, so a taller typing hitbox can move anchors.

## Risk Analysis

### Low Risk

- Existing themes do not use `fileHitBoxes`, so their geometry remains unchanged.
- `hitWin` remains a single rectangular input window using the existing `setBounds()` + `setShape()` path.
- Click action behavior already exists for non-idle states.

### Medium Risk

- A taller typing hitbox means transparent pixels around the mini screen can intercept clicks. This is acceptable if the rectangle is tightly tuned, but it should be manually checked at S/M/L sizes.
- A file-specific hitbox can affect drag initiation from the top screen area. That is desirable for this issue, but should be tested on Windows because `hitWin.focusable = true` is sensitive infrastructure.
- If theme variants replace the typing asset with a visually different file, the final filename needs its own file hitbox. If a variant keeps the same filename but changes the visual shape, the inherited file hitbox may no longer fit. This is already true for `wideHitboxFiles`, but the stronger geometry makes it more visible.
- Follow-pet UI positions can be influenced by the larger hitbox. Update bubble usually prefers a stable anchor / margin box when available, but permission bubbles and Session HUD can use the current hit rect.

## Alternatives Considered

### Add `clawd-working-typing.svg` to `wideHitboxFiles`

Rejected for #207. The `wide` hitbox starts at `y=3`; the screen mostly lives above that. It would only make the bottom edge clickable, not the user-visible target.

### Hardcode Typing Hitbox in `state.js`

Rejected. It fixes the immediate issue but breaks the theme abstraction and creates a special runtime rule for one asset name.

### Per-Pixel SVG Hit Testing

Rejected for now. It would require moving input decisions closer to the render layer or maintaining a more complex native shape. That would increase cross-platform risk, especially around Windows drag behavior.

### Multi-Rect `setShape()`

Potential future option. Electron `setShape()` supports multiple rectangles, so the mini screen and body could be separate hit regions. For #207, a single tuned rectangle is much simpler and likely sufficient.

## Review Questions

1. Is `fileHitBoxes` the right top-level name, or should this be grouped under `hitBoxes.files`?
2. Should file-specific hitbox override sleeping/wide/default, or should sleeping always win?
3. Should variants be allowed to override `fileHitBoxes` in v1? Proposed answer: yes, using top-level file-key merge with whole-rect replacement.
4. Is single-rectangle precision acceptable for the typing screen, or do we need multi-rect support immediately?
5. Should the field be documented in `docs/guides/guide-theme-creation.md` in the same PR, or can docs follow after the runtime change?

## Suggested Scope

Recommended first PR scope:

1. Add `fileHitBoxes` runtime support.
2. Add Clawd typing hitbox config.
3. Add focused unit tests.
4. Add a short theme author doc note.

Defer Settings UI and multi-rect editing until there is a second concrete need.
