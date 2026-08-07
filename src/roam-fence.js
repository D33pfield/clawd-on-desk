"use strict";

// src/roam-fence.js — validated loader for the optional roam fence file.
//
// The fence lets users limit where free roam wanders without opening the
// settings UI: a JSON file describing a rectangle as fractions of the work
// area. External tools can rewrite the file while the app runs.
//
// File: ~/.clawd/roam-area.json
// Format:
//   {
//     "enabled": true,     // boolean, required — anything else is invalid
//     "left": 0.25,        // fractions of the work area, all optional
//     "top": 0.0,          // (missing edges default to the full range)
//     "right": 0.75,
//     "bottom": 1.0
//   }
// Validation is strict: `enabled` must be a real boolean and every present
// edge a finite number with 0 <= left < right <= 1 and 0 <= top < bottom <= 1.
// Strings that would coerce through Number() are rejected.
//
// Live-update timing: roam calls refresh() when it schedules the next walk,
// so an edit applies to the walk after the one currently pending — within
// one roam pause (~4–8s) — without restarting the app.
//
// Failure semantics (never fail open mid-save):
//   • file missing (ENOENT)            → fence disabled (full-area roam)
//   • malformed JSON / invalid schema  → keep last known good state
//   • transient read errors (EACCES…)  → keep last known good state
// A partially written save therefore cannot momentarily restore full-area
// roaming; the previous fence keeps applying until a valid save lands.

const INACTIVE = Object.freeze({
  active: false,
  left: 0,
  top: 0,
  right: 1,
  bottom: 1,
});

function parseFence(raw) {
  // Windows editors (and some JSON writers) prepend a UTF-8 BOM; JSON.parse
  // rejects it, so strip a leading U+FEFF before parsing.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  if (typeof parsed.enabled !== "boolean") return null;
  const left = parsed.left === undefined ? 0 : parsed.left;
  const top = parsed.top === undefined ? 0 : parsed.top;
  const right = parsed.right === undefined ? 1 : parsed.right;
  const bottom = parsed.bottom === undefined ? 1 : parsed.bottom;
  for (const v of [left, top, right, bottom]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  if (!(left >= 0 && right <= 1 && left < right)) return null;
  if (!(top >= 0 && bottom <= 1 && top < bottom)) return null;
  if (!parsed.enabled) return { ...INACTIVE };
  return { active: true, left, top, right, bottom };
}

// deps are injectable for tests: { readFile: async (path) => string, filePath }
module.exports = function createRoamFenceLoader(deps = {}) {
  const readFile =
    deps.readFile ||
    ((p) => require("fs").promises.readFile(p, "utf8"));
  const filePath =
    deps.filePath ||
    require("path").join(require("os").homedir(), ".clawd", "roam-area.json");

  let state = { ...INACTIVE };
  let pending = null;

  // Async and coalesced: roam kicks this fire-and-forget when scheduling a
  // walk, then reads get() at pick time seconds later — no synchronous disk
  // I/O ever happens inside target selection.
  function refresh() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const next = parseFence(await readFile(filePath));
        if (next) state = next;
      } catch (err) {
        if (err && err.code === "ENOENT") state = { ...INACTIVE };
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return {
    get: () => state,
    refresh,
    filePath,
  };
};

module.exports.parseFence = parseFence;
