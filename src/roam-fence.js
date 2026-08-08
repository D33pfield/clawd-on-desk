"use strict";

// src/roam-fence.js — validated loader for the optional roam fence file.
//
// The fence lets users limit where free roam wanders without opening the
// settings UI: a JSON file describing a rectangle as fractions of the work
// area. External tools can rewrite the file while the app runs.
// User-facing contract: docs/guides/roam-fence.md (keep both in sync).
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
// Failure semantics (never fail open — PR #810 review, pass 3):
//   • before the first confirmed read      → status UNKNOWN (get() returns
//     null); roam skips its round rather than roaming the full area on a
//     fence that merely hasn't loaded yet
//   • file missing (ENOENT), no fence yet  → confirmed "no fence" immediately
//   • file missing (ENOENT), fence active  → an isolated ENOENT is treated as
//     a replace-style save in flight: the last-known-good fence is retained;
//     only a second consecutive ENOENT confirms removal and disables the fence
//   • malformed JSON / invalid schema      → keep last known good state
//     (or stay UNKNOWN before the first valid read) + one deduplicated warning
//   • transient read errors (EACCES…)      → keep last known good state
//   • not a regular file / oversized file  → treated as invalid content; the
//     stat guard runs before the read so a FIFO can never wedge the single
//     coalesced refresh slot forever
// A partially written save therefore cannot momentarily restore full-area
// roaming; the previous fence keeps applying until a valid save lands.

const MAX_FENCE_FILE_BYTES = 64 * 1024;

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

// deps are injectable for tests:
//   { readFile: async (path) => string, stat: async (path) => fs.Stats-like,
//     warn: (message) => void, filePath }
// When readFile is injected without stat, the stat guard is skipped — unit
// tests feed content directly and must not hit the real filesystem.
module.exports = function createRoamFenceLoader(deps = {}) {
  const readFile =
    deps.readFile ||
    ((p) => require("fs").promises.readFile(p, "utf8"));
  const statFile =
    deps.stat || (deps.readFile ? null : (p) => require("fs").promises.stat(p));
  const warn = deps.warn || ((message) => console.warn(message));
  const filePath =
    deps.filePath ||
    require("path").join(require("os").homedir(), ".clawd", "roam-area.json");

  // null = UNKNOWN: nothing confirmed yet. Roam treats it as "hold this
  // round" — see pickRandomTarget() in src/roam.js.
  let state = null;
  let enoentSeenWhileActive = false;
  let lastWarnKey = null;
  let pending = null;
  let trailingRequested = false;

  function warnOnce(key, reason) {
    // Dedup: the same broken content produces exactly one warning, not one
    // per 4s roam pause. A different problem (or a fix followed by a new
    // break) warns again.
    if (lastWarnKey === key) return;
    lastWarnKey = key;
    const consequence = state
      ? state.active
        ? "keeping the previous fence"
        : "fence stays disabled"
      : "free roam stays paused until the file is fixed or removed";
    warn(`[roam-fence] ${filePath}: ${reason}; ${consequence}.`);
  }

  // One read: stat guard → read → classify. Extracted so refresh() can run a
  // trailing read when a request arrived while another read was in flight.
  async function readOnce() {
    try {
      if (statFile) {
        const st = await statFile(filePath);
        if (st && typeof st.isFile === "function" && !st.isFile()) {
          enoentSeenWhileActive = false;
          warnOnce("not-file", "not a regular file");
          return;
        }
        if (st && Number.isFinite(st.size) && st.size > MAX_FENCE_FILE_BYTES) {
          enoentSeenWhileActive = false;
          warnOnce(
            `size:${st.size}`,
            `file is ${st.size} bytes (limit ${MAX_FENCE_FILE_BYTES})`,
          );
          return;
        }
      }
      const raw = await readFile(filePath);
      enoentSeenWhileActive = false;
      const next = parseFence(raw);
      if (next) {
        state = next;
        lastWarnKey = null;
      } else {
        warnOnce(`invalid:${raw}`, "invalid fence JSON");
      }
    } catch (err) {
      if (err && err.code === "ENOENT") {
        // A replace-style save (unlink + rename) can expose one ENOENT
        // between two valid reads. Never drop an active fence on the first
        // one — require a second consecutive ENOENT as confirmation.
        if (state && state.active && !enoentSeenWhileActive) {
          enoentSeenWhileActive = true;
        } else {
          enoentSeenWhileActive = false;
          state = { ...INACTIVE };
          lastWarnKey = null;
        }
      } else {
        // #810 round-3: any non-ENOENT outcome breaks the consecutive-ENOENT
        // streak — valid → ENOENT → EACCES → ENOENT is NOT two consecutive
        // misses and must not disable the fence. Warn (deduplicated) so a
        // persistently unreadable file is diagnosable rather than silent.
        enoentSeenWhileActive = false;
        warnOnce(
          `read-error:${(err && err.code) || "unknown"}`,
          `read failed (${(err && err.code) || err})`,
        );
      }
    }
  }

  // Async and coalesced: roam kicks this fire-and-forget when scheduling a
  // walk, then reads get() at pick time seconds later — no synchronous disk
  // I/O ever happens inside target selection.
  // #810 round-3: a request that arrives while a read is in flight marks a
  // trailing read instead of being dropped — the in-flight read may have
  // captured pre-edit content, so the LAST requester's view must win. The
  // returned promise settles only after the trailing read completes.
  function refresh() {
    if (pending) {
      trailingRequested = true;
      return pending;
    }
    pending = (async () => {
      try {
        do {
          trailingRequested = false;
          await readOnce();
        } while (trailingRequested);
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return {
    // null until the loader has confirmed a real status (valid file,
    // valid enabled:false, or confirmed-missing).
    get: () => state,
    refresh,
    filePath,
  };
};

module.exports.parseFence = parseFence;
