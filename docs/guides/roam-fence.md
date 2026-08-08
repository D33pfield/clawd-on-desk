# Roam Fence — limit where free roam wanders

When Free Roam is on, the pet periodically walks to a random spot on the
screen. The roam fence is an optional, file-based way to keep those walks
inside a rectangle you choose — for example the bottom-right quarter of the
screen, or a strip above the dock. No settings UI is involved, which also
means external tools and scripts can move the fence live while the app runs.

## The file

Create `~/.clawd/roam-area.json`:

```json
{
  "enabled": true,
  "left": 0.5,
  "top": 0.5,
  "right": 1.0,
  "bottom": 1.0
}
```

That example confines roaming to the bottom-right quarter of the work area.

| Field | Meaning |
| --- | --- |
| `enabled` | Must be exactly `true` or `false` (a real JSON boolean). `false` disables the fence without deleting the file. |
| `left`, `top`, `right`, `bottom` | Fractions of the work area (`0` = left/top edge, `1` = right/bottom edge). Each is optional; a missing edge defaults to the full range. |

Rules: every present edge must be a finite number with
`0 <= left < right <= 1` and `0 <= top < bottom <= 1`. Strings (`"0.5"`),
reversed intervals, and out-of-range values make the file invalid. The whole
pet must fit inside the rectangle, so a fence narrower or shorter than the pet
produces no movement on that axis (a corridor exactly the pet's size is fine —
the pet then only moves along the other axis).

Delete the file (or set `"enabled": false`) to return to normal full-area
roaming.

## When changes apply

The file is re-read in the background each time the next walk is scheduled, so
an edit applies within one roam pause (about 4–8 seconds). No restart needed.

## Failure behavior (by design, the fence never "falls open")

- A malformed or half-saved file keeps the **previous** fence until a valid
  save lands, and logs one deduplicated warning.
- Deleting the file counts only after it stays gone for two consecutive
  checks, so atomic replace-style saves can't flash the fence off.
- Until the loader has confirmed a first status (valid file, or confirmed
  missing), roam holds its rounds instead of wandering the full area.
- If the pet starts outside the fence, its next walk brings it back inside;
  in axis-constrained mode the walk moves along whichever axis is out of
  bounds, and if both are, the pet stays put for that round.
