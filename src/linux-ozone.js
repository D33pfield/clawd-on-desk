"use strict";

// ── Linux / Wayland: default to XWayland (issue #441) ──
//
// Native Wayland forbids two things this desktop pet depends on:
//   1. Client-side window positioning — the BrowserWindow x/y and later
//      setBounds() calls are ignored by the compositor, so the pet spawns
//      centered and can't be dragged by following the cursor.
//   2. Global cursor queries — screen.getCursorScreenPoint() is unsupported,
//      so there is no mouse tracking.
//
// Forcing XWayland (--ozone-platform=x11) restores window positioning (drag
// works again), matching the workaround reporters find by hand. Cursor
// tracking stays limited to our own surfaces; full-screen tracking is NOT
// recoverable under Wayland for an ordinary client — that needs a real X11
// session (Xorg login), which is a user-side choice we can't paper over.
//
// Priority (highest first):
//   1. CLAWD_OZONE_PLATFORM env override — most explicit user intent:
//        x11     → force XWayland
//        wayland → force native Wayland (--ozone-platform=wayland)
//        auto    → don't force anything here; leave any existing CLI switch /
//                  Electron's own default untouched
//   2. An explicit --ozone-platform already on argv (user / .desktop /
//      AppImage wrapper) — respected; auto-detection won't override it.
//   3. Auto-detection — x11 when on a Wayland session AND an X server
//      (DISPLAY) is present for XWayland.
//
// The DISPLAY guard matters: forcing x11 with no reachable X server makes the
// Chromium X11 Ozone backend abort at platform init with a native fatal/CHECK
// (e.g. "Missing X server or $DISPLAY") — that is not a catchable JS exception
// and happens before app.whenReady. DISPLAY only proves the variable is set,
// not that the server is reachable; a heavyweight probe (xdpyinfo/xset) isn't
// worth it, so we keep the cheap guard plus the CLAWD_OZONE_PLATFORM escape
// hatch and a startup log line.
//
// `cliOzonePlatform` is the value already on argv for --ozone-platform (or
// null/empty), passed in by the caller so this stays a pure, testable
// function. Returns the value the app should run with ("x11" | "wayland"), or
// null to leave the command line untouched.
function resolveLinuxOzonePlatform(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") return null;

  const env = options.env || process.env;

  // 1. Explicit env override wins over everything (including an existing CLI
  //    switch — the caller removes/replaces it when our value differs).
  const override = String(env.CLAWD_OZONE_PLATFORM || "").trim().toLowerCase();
  if (override === "x11") return "x11";
  if (override === "wayland") return "wayland";
  if (override === "auto") return null;

  // 2. No env override → respect an explicit --ozone-platform already on argv.
  const cli = String(options.cliOzonePlatform || "").trim().toLowerCase();
  if (cli) return null;

  // 3. Auto-detect: force XWayland on a Wayland session when XWayland is
  //    actually reachable.
  const sessionType = String(env.XDG_SESSION_TYPE || "").trim().toLowerCase();
  const underWayland = sessionType === "wayland" || !!String(env.WAYLAND_DISPLAY || "").trim();
  const xwaylandAvailable = !!String(env.DISPLAY || "").trim();

  return underWayland && xwaylandAvailable ? "x11" : null;
}

module.exports = { resolveLinuxOzonePlatform };
