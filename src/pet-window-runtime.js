"use strict";

const createPetGeometryMain = require("./pet-geometry-main");
const {
  computeLooseClamp,
  getDisplayInsets,
  findMatchingDisplay,
  isPointInAnyWorkArea,
  SYNTHETIC_WORK_AREA,
} = require("./work-area");
const {
  getThemeMarginBox,
  computeStableVisibleContentMargins,
  getLooseDragMargins,
  getRestClampMargins,
} = require("./visible-margins");
const {
  createDragSnapshot,
  computeAnchoredDragBounds,
  computeFinalDragBounds: computeFinalDragBoundsRaw,
  needsFinalClampAdjustment: needsFinalClampAdjustmentRaw,
  materializeVirtualBounds: materializeVirtualBoundsRaw,
} = require("./drag-position");
const { resolveHorizontalEdgeContext } = require("./display-edge");
const { classifyCloakState } = require("./win-cloak-recovery");

const noop = () => {};
const DEFAULT_CRASH_RELOAD_LIMIT = 5;
const DEFAULT_CRASH_RELOAD_WINDOW_MS = 30_000;
const NON_RELOADABLE_RENDER_GONE_REASONS = new Set([
  "clean-exit",
  "killed",
  "integrity-failure",
  "launch-failed",
]);

// Issue #690 GNOME/XWayland edge-virtualization constants — plan §4.3.
// RECONCILE_QUIET_MS: debounce window for the (not-yet-wired) native
// move/resize -> reconcile path. SETTLE_MS: bounded grace period after a
// write before an unexplained actual/expected mismatch stops being treated
// as "still settling"; must stay >= 3x RECONCILE_QUIET_MS to cover one WM
// round trip plus one debounce. HIT_QUIET_MS: the hit window's independent
// (longer) quiet period, so we don't fight a Mutter interactive grab. None of
// the reconcile/settle-sweep machinery that consumes these is implemented in
// this batch — see scheduleSettleSweep() below.
const RECONCILE_QUIET_MS = 100;
const SETTLE_MS = 400;
const HIT_QUIET_MS = 250;

function isLiveWindow(win) {
  return !!(win && typeof win.isDestroyed === "function" && !win.isDestroyed());
}

function getRenderGoneReason(details) {
  return details && typeof details.reason === "string" ? details.reason : "unknown";
}

function createRenderProcessGoneReloadGuard(options = {}) {
  const crashReloadLimit = Number.isFinite(options.crashReloadLimit)
    ? Math.max(0, Math.floor(options.crashReloadLimit))
    : DEFAULT_CRASH_RELOAD_LIMIT;
  const crashReloadWindowMs = Number.isFinite(options.crashReloadWindowMs)
    ? Math.max(0, options.crashReloadWindowMs)
    : DEFAULT_CRASH_RELOAD_WINDOW_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const log = typeof options.crashReloadLog === "function"
    ? options.crashReloadLog
    : (message) => console.warn(message);
  const reloadsByKey = new Map();

  return function shouldReloadAfterRenderProcessGone(crashKey, details) {
    const key = crashKey || "default";
    const reason = getRenderGoneReason(details);
    if (NON_RELOADABLE_RENDER_GONE_REASONS.has(reason)) {
      log(`Clawd: not reloading ${key} after render-process-gone (${reason})`);
      return false;
    }

    const ts = Number(now());
    const cutoff = ts - crashReloadWindowMs;
    const recent = (reloadsByKey.get(key) || []).filter((value) => value >= cutoff);
    if (recent.length >= crashReloadLimit) {
      log(`Clawd: stopped reloading ${key} after ${recent.length} crashes in ${crashReloadWindowMs}ms`);
      reloadsByKey.set(key, recent);
      return false;
    }

    recent.push(ts);
    reloadsByKey.set(key, recent);
    return true;
  };
}

function reloadWindowWebContents(win) {
  try {
    if (!isLiveWindow(win)) return false;
    const contents = win.webContents;
    if (!contents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    if (typeof contents.reload !== "function") return false;
    contents.reload();
    return true;
  } catch {
    return false;
  }
}

function createPetWindowRuntime(options = {}) {
  const screen = options.screen || {};
  const isWin = !!options.isWin;
  const isMac = !!options.isMac;
  const isLinux = !!options.isLinux;
  const linuxWindowType = options.linuxWindowType;
  const topmostLevel = options.topmostLevel;
  const getRenderWindow = options.getRenderWindow || (() => null);
  const getHitWindow = options.getHitWindow || (() => null);
  const getSettingsWindow = options.getSettingsWindow || (() => null);
  const getPrimaryWorkAreaSafe = options.getPrimaryWorkAreaSafe || (() => null);
  const getNearestWorkArea = options.getNearestWorkArea || (() => getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA);
  const getActiveTheme = options.getActiveTheme || (() => null);
  const getCurrentState = options.getCurrentState || (() => null);
  const getCurrentSvg = options.getCurrentSvg || (() => null);
  const getCurrentHitBox = options.getCurrentHitBox || (() => null);
  const getMiniMode = options.getMiniMode || (() => false);
  const getMiniTransitioning = options.getMiniTransitioning || (() => false);
  const getMiniContainedSeam = options.getMiniContainedSeam || (() => null);
  const getMiniPeekOffset = options.getMiniPeekOffset || (() => 0);
  const getCurrentPixelSize = options.getCurrentPixelSize || (() => null);
  const getEffectiveCurrentPixelSize = options.getEffectiveCurrentPixelSize || getCurrentPixelSize;
  const getKeepSizeAcrossDisplays = options.getKeepSizeAcrossDisplays || (() => false);
  const getAllowEdgePinning = options.getAllowEdgePinning || (() => false);
  const isProportionalMode = options.isProportionalMode || (() => false);
  const sendToRenderer = options.sendToRenderer || noop;
  const keepOutOfTaskbar = options.keepOutOfTaskbar || noop;
  const repositionSessionHud = options.repositionSessionHud || noop;
  const repositionAnchoredSurfaces = options.repositionAnchoredSurfaces || noop;
  const repositionFloatingBubbles = options.repositionFloatingBubbles || noop;
  const showFloatingSurfacesForPet = options.showFloatingSurfacesForPet || noop;
  const hideFloatingSurfacesForPet = options.hideFloatingSurfacesForPet || noop;
  const syncSessionHudVisibilityAndBubbles = options.syncSessionHudVisibilityAndBubbles || noop;
  const syncPermissionShortcuts = options.syncPermissionShortcuts || noop;
  const buildTrayMenu = options.buildTrayMenu || noop;
  const buildContextMenu = options.buildContextMenu || noop;
  const reapplyMacVisibility = options.reapplyMacVisibility || noop;
  // #640: re-run the editing-overlap dodge whenever the hit geometry syncs —
  // the hitbox can change without the window moving (state switches between
  // hitboxes, theme reload), which changes the overlap answer.
  const syncImeEditingPetDodge = options.syncImeEditingPetDodge || noop;
  const reassertWinTopmost = options.reassertWinTopmost || noop;
  const scheduleHwndRecovery = options.scheduleHwndRecovery || noop;
  // #525: DWM cloak probe + un-cloak primitives (win-cloak-recovery.js).
  // Absent/unavailable inspector degrades every cloak path to a no-op.
  const cloakInspector = options.cloakInspector || null;
  const isMiniAnimating = options.isMiniAnimating || (() => false);
  const now = options.now || (() => Date.now());
  const isNearWorkAreaEdge = options.isNearWorkAreaEdge || (() => false);
  // Low-noise diagnostics for the I2 offset legal-domain backstop and the
  // assertNoYOffset guard (plan §3 I2, §4.3.2). Mirrors the crashReloadLog
  // injection point below so tests can capture what would otherwise be a
  // bare console.warn.
  const edgeLog = options.edgeLog || ((message) => console.warn(message));
  const flushRuntimeStateToPrefs = options.flushRuntimeStateToPrefs || noop;
  const handleMiniDisplayChange = options.handleMiniDisplayChange || noop;
  const exitMiniMode = options.exitMiniMode || noop;
  const shouldReloadAfterRenderProcessGone = createRenderProcessGoneReloadGuard(options);

  function reloadRuntimeWindowWebContents(win, reloadOptions = {}) {
    if (
      reloadOptions
      && reloadOptions.crashKey
      && !shouldReloadAfterRenderProcessGone(reloadOptions.crashKey, reloadOptions.details)
    ) {
      return false;
    }
    return reloadWindowWebContents(win);
  }

  const petGeometryMain = createPetGeometryMain({
    getActiveTheme,
    getCurrentState,
    getCurrentSvg,
    getCurrentHitBox,
    getMiniMode,
    getMiniPeekOffset,
  });

  let viewportOffsetY = 0;
  // Issue #690 X-offset / logical-physical mapping state (plan §4.3 point 2).
  // lastLogicalBounds is the storage quantity I1/I2 make authoritative: only
  // its x/y are ever read back (width/height are recorded for log parity but
  // never consumed — §3 I2). expectedPhysical/writeGen/settleUntil exist so a
  // later batch can wire up deferred reconcile; this batch only maintains
  // them, it does not yet read them back anywhere.
  let viewportOffsetX = 0;
  let lastLogicalBounds = null;
  let expectedPhysical = null;
  let writeGen = 0;
  let settleUntil = 0;
  const loggedEdgeReasons = new Set();
  let petHidden = false;
  let dragLocked = false;
  let dragSnapshot = null;
  let hitShapeWidth = 0;
  let hitShapeHeight = 0;
  let settingsSizePreviewSyncFrozen = false;
  const themeMarginEnvelopeCache = new Map();

  function getPrimaryWorkAreaFallback() {
    return getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
  }

  function getAllDisplays() {
    return typeof screen.getAllDisplays === "function" ? screen.getAllDisplays() : [];
  }

  function getCursorScreenPoint() {
    return typeof screen.getCursorScreenPoint === "function"
      ? screen.getCursorScreenPoint()
      : null;
  }

  function getNearestDisplayBottomInset(cx, cy) {
    const point = { x: Math.round(cx), y: Math.round(cy) };
    let display = null;
    try {
      if (typeof screen.getDisplayNearestPoint === "function") {
        display = screen.getDisplayNearestPoint(point);
      }
    } catch {}
    if (!display || !display.bounds || !display.workArea) {
      try {
        if (typeof screen.getPrimaryDisplay === "function") display = screen.getPrimaryDisplay();
      } catch {}
    }
    return getDisplayInsets(display).bottom;
  }

  function setViewportOffsetY(offsetY) {
    const next = Number.isFinite(offsetY) ? Math.max(0, Math.round(offsetY)) : 0;
    if (next === viewportOffsetY) return;
    viewportOffsetY = next;
    sendToRenderer("viewport-offset", viewportOffsetY);
  }

  function getViewportOffsetY() {
    return viewportOffsetY;
  }

  // Signed X counterpart to setViewportOffsetY/getViewportOffsetY (plan §4.3
  // point 1). Unlike Y, X is never clamped to >= 0 here — I2 defines its
  // legal domain as the open interval (-width, +width), enforced by the
  // caller (see guardOffsetXLegalDomain below) because only the caller knows
  // the window width at the moment of the write.
  function setViewportOffsetX(offsetX) {
    const next = Number.isFinite(offsetX) ? Math.round(offsetX) : 0;
    if (next === viewportOffsetX) return;
    viewportOffsetX = next;
    sendToRenderer("viewport-offset-x", viewportOffsetX);
  }

  function getViewportOffsetX() {
    return viewportOffsetX;
  }

  function logEdgeOnce(reason, detail) {
    if (loggedEdgeReasons.has(reason)) return;
    loggedEdgeReasons.add(reason);
    edgeLog(`Clawd: edge-${reason} ${detail}`);
  }

  function clearLoggedEdgeReason(reason) {
    loggedEdgeReasons.delete(reason);
  }

  // getPetWindowBounds()'s null-on-dead-window contract is load-bearing and
  // MUST NOT change: src/roam.js:104-105, src/tick.js:236-238 and
  // src/pet-interaction-ipc.js:121-124 all depend on this null to no-op
  // gracefully, and pet-window-runtime.js's own handleDisplayMetricsChanged()
  // reads `current.x` with no null-check of its own, relying entirely on this
  // guard.
  //
  // Position now comes from the stored logical bounds (I1/I2): once
  // applyPetWindowBounds() has adopted a target, that target — not whatever
  // the live physical window has drifted to — is the position truth. Size is
  // never virtualized, so it always comes from the live window (plan §3 I2:
  // "位置" is a storage quantity, "尺寸" is not).
  function getPetWindowBounds() {
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return null;
    const live = win.getBounds();
    if (!lastLogicalBounds) return { ...live }; // cold start / never adopted
    return {
      x: lastLogicalBounds.x,
      y: lastLogicalBounds.y,
      width: live.width,
      height: live.height,
    };
  }

  function resolveWorkAreaFor(bounds) {
    return bounds
      ? getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      : null;
  }

  // Shared src/display-edge.js topology resolver (plan §4.1), scoped to a
  // single target rect. Only ever consulted on Linux — see
  // resolveHorizontalClampBounds below — so this never runs a displays
  // enumeration on Windows/macOS.
  function resolveEdgeContextForBounds(bounds, workArea) {
    if (!bounds || !isValidWorkArea(workArea)) return null;
    return resolveHorizontalEdgeContext({
      displays: getAllDisplays(),
      workArea,
      yMid: bounds.y + bounds.height / 2,
    });
  }

  // §4.2's leftBound/rightBound: null means "don't clamp that side". I3 is
  // enforced right here — Windows/macOS and any edge the shared helper
  // reports as an internal seam always get { null, null }, which reproduces
  // byte-identical pre-#690 physical-overflow behavior via
  // materializeVirtualBoundsRaw()'s existing null-bound fast path.
  //
  // observedClampInset (§4.3.14, "钳制内缩量必须被学习") is NOT implemented
  // this batch — a later batch subtracts/adds the learned inset here. Until
  // then this uses the raw workArea boundary, i.e. an inset of 0 throughout.
  function resolveHorizontalClampBounds(bounds, workArea, providedEdgeContext) {
    if (!isLinux) return { leftBound: null, rightBound: null };
    const edge = providedEdgeContext || resolveEdgeContextForBounds(bounds, workArea);
    if (!edge) return { leftBound: null, rightBound: null };
    return {
      leftBound: edge.left.isOuterWorkAreaEdge ? edge.left.workAreaBoundary : null,
      rightBound: edge.right.isOuterWorkAreaEdge ? edge.right.workAreaBoundary : null,
    };
  }

  // Shared materializer (plan §4.2/§4.3 point 4: "resolveStartupPlacement()
  // ... 使用相同 materializer"). Both applyPetWindowBounds() and
  // resolveStartupPlacement() call this exact function so a Linux outer-edge
  // window can never be constructed off-screen and then reconciled — the
  // startup bounds are already correct on the first native write.
  function materializeVirtualBounds(bounds, workArea, opts = {}) {
    if (!bounds) return null;
    const resolvedWorkArea = isValidWorkArea(workArea) ? workArea : resolveWorkAreaFor(bounds);
    const clampBounds = resolveHorizontalClampBounds(bounds, resolvedWorkArea, opts.edgeContext);
    return materializeVirtualBoundsRaw(bounds, resolvedWorkArea, clampBounds);
  }

  function sameRect(a, b) {
    return !!a && !!b
      && a.x === b.x && a.y === b.y
      && a.width === b.width && a.height === b.height;
  }

  // §4.3.2's recomputeOffsetsFrom: rederives both offsets from a known-good
  // (logical, actualPhysical) pair without going through materialize. The
  // reconcile path that normally calls this (adopt-clamp / rebase) is not
  // implemented in this batch; today the only caller is the I2 backstop
  // below, which needs exactly this "make offsets agree with a concrete
  // actual" computation.
  function recomputeOffsetsFrom(logical, actualPhysical) {
    setViewportOffsetX(isLinux ? (logical.x - actualPhysical.x) : 0);
    setViewportOffsetY(Math.max(0, actualPhysical.y - logical.y));
  }

  // §3 I2's legal-domain backstop for the one offset write point this batch
  // adds. #pet-container is a 100%-sized `overflow:hidden` box
  // (src/styles.css) — an |offsetX| that reaches the window width clips the
  // character out entirely with no visible affordance left to drag it back.
  // Refuse that value instead: log once, hard-resync lastLogicalBounds to the
  // physical rect we actually have, and zero both offsets so logical tracks
  // physical exactly. This is a rare backstop (a sane leftBound/rightBound
  // from resolveHorizontalClampBounds should never trigger it) — reconcile-
  // driven recomputes (adopt-clamp, rebase) will reuse it once a later batch
  // wires them up. Returns true when it fired (caller must skip the normal
  // setViewportOffsetX call in that case).
  function guardOffsetXLegalDomain(materialized) {
    const offsetX = materialized.viewportOffsetX;
    const width = materialized.bounds.width;
    if (Number.isFinite(offsetX) && width > 0 && Math.abs(offsetX) < width) {
      return false;
    }
    logEdgeOnce(
      "offset-out-of-range",
      `axis=x offsetX=${offsetX} width=${width} expected=${JSON.stringify(materialized.bounds)}`
    );
    recomputeOffsetsFrom(materialized.bounds, materialized.bounds);
    lastLogicalBounds = { x: materialized.bounds.x, y: materialized.bounds.y };
    return true;
  }

  // §4.3.13 stub. The real settle-sweep timer (a one-shot SETTLE_MS timeout
  // that calls runReconcile("settle-sweep", writeGen) so an unexplained
  // actual/expected mismatch is adopted even without a native move/resize
  // event) is not implemented in this batch — reconcile/adopt-clamp are out
  // of scope here. Left as a deliberate no-op, called from the same call site
  // the real implementation will occupy, so writeGen/settleUntil/
  // expectedPhysical already have a consumer to wire up next.
  function scheduleSettleSweep() {}

  // Regulates native writes plus derived offset/log state for one logical
  // bounds request. `next` is the caller's intended (possibly off-screen on
  // Linux) logical position; the return value is the physical rect actually
  // requested from the OS.
  //
  //  - force: write natively even when the materialized physical rect already
  //    matches the current live bounds (needed by #525's compositor refresh
  //    and topmost's nudge — see recoverVisiblePetAfterRendererLoad below).
  //  - workArea / edgeContext: let a caller that already resolved these
  //    (e.g. a future per-frame mini animation) skip re-resolving them here.
  //  - assertNoYOffset: mini's future per-frame X-only entry point. When the
  //    materialize result still has a non-zero Y offset (it shouldn't, if the
  //    caller clamped Y first), refuse to forward it to the renderer and log
  //    once instead of reopening the Y layout hot path.
  function applyPetWindowBounds(next, opts = {}) {
    const win = getRenderWindow();
    if (!isLiveWindow(win) || !next) return null;

    const m = materializeVirtualBounds(next, opts.workArea, { edgeContext: opts.edgeContext });
    if (!m) return null;

    // Key ordering (this batch's inviolable contract): the storage
    // quantities are updated BEFORE the native write below, so any business
    // read that lands after this point — even one triggered synchronously
    // from inside win.setBounds itself — observes the new logical position,
    // never a stale or WM-polluted one.
    lastLogicalBounds = { x: next.x, y: next.y, width: next.width, height: next.height };
    expectedPhysical = { ...m.bounds };
    writeGen += 1;
    settleUntil = now() + SETTLE_MS;

    const cur = win.getBounds();
    if (opts.force || !sameRect(cur, m.bounds)) win.setBounds(m.bounds);

    // guardOffsetXLegalDomain(), when it fires, already hard-resyncs BOTH
    // offsets to 0 via recomputeOffsetsFrom() and overwrites lastLogicalBounds
    // — the normal per-axis assignments below must be skipped entirely in
    // that case, or the unconditional Y branch would immediately clobber the
    // guard's reset back to the original (rejected) m.viewportOffsetY.
    if (!guardOffsetXLegalDomain(m)) {
      setViewportOffsetX(m.viewportOffsetX);
      clearLoggedEdgeReason("offset-out-of-range");

      if (!opts.assertNoYOffset) {
        setViewportOffsetY(m.viewportOffsetY);
        clearLoggedEdgeReason("assert-no-y-offset");
      } else if (m.viewportOffsetY !== 0) {
        logEdgeOnce("assert-no-y-offset", `viewportOffsetY=${m.viewportOffsetY}`);
      } else {
        clearLoggedEdgeReason("assert-no-y-offset");
      }
    }

    scheduleSettleSweep();

    repositionSessionHud();
    return m.bounds;
  }

  function applyPetWindowPosition(x, y, opts = {}) {
    const bounds = getPetWindowBounds();
    if (!bounds) return null;
    return applyPetWindowBounds({ ...bounds, x, y }, opts);
  }

  function isPetHidden() {
    return petHidden;
  }

  // #525: clear an abnormal DWM cloak before showing. showInactive() alone
  // does NOT un-cloak (hide/show cycling is unreliable for that — plan §1.2-B);
  // DwmSetWindowAttribute(DWMWA_CLOAK, FALSE) is the direct primitive. Windows
  // parked on another virtual desktop are deliberately left alone.
  function uncloakIfAbnormal(win) {
    if (!cloakInspector || !cloakInspector.available || !isLiveWindow(win)) return false;
    const flag = cloakInspector.readCloakState(win);
    const verdict = classifyCloakState(flag, flag === 0 ? true : cloakInspector.isOnCurrentVirtualDesktop(win));
    if (verdict !== "recover") return false;
    return cloakInspector.uncloak(win);
  }

  function showPetWindows() {
    const win = getRenderWindow();
    if (isLiveWindow(win)) {
      uncloakIfAbnormal(win);
      win.showInactive();
      keepOutOfTaskbar(win);
    }
    const hitWin = getHitWindow();
    if (isLiveWindow(hitWin)) {
      uncloakIfAbnormal(hitWin);
      hitWin.showInactive();
      keepOutOfTaskbar(hitWin);
    }
  }

  function hidePetWindows() {
    const win = getRenderWindow();
    if (isLiveWindow(win)) win.hide();
    const hitWin = getHitWindow();
    if (isLiveWindow(hitWin)) hitWin.hide();
  }

  // Idempotent visibility setter. Returns { applied, deferred, changed }:
  //  - no render window  -> { applied:false, deferred:false, changed:false }
  //  - mini transitioning -> { applied:false, deferred:true,  changed:false } (petHidden untouched)
  //  - already in target  -> { applied:true,  deferred:false, changed:false }
  //  - state flipped      -> { applied:true,  deferred:false, changed:true  }
  function setPetHidden(hidden) {
    const target = !!hidden;
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return { applied: false, deferred: false, changed: false };
    if (getMiniTransitioning()) return { applied: false, deferred: true, changed: false };
    if (target === petHidden) return { applied: true, deferred: false, changed: false };
    if (petHidden) {
      // becoming visible
      showPetWindows();
      showFloatingSurfacesForPet();
      reapplyMacVisibility();
      petHidden = false;
    } else {
      // becoming hidden
      hidePetWindows();
      hideFloatingSurfacesForPet();
      petHidden = true;
    }
    syncSessionHudVisibilityAndBubbles();
    syncPermissionShortcuts();
    buildTrayMenu();
    buildContextMenu();
    return { applied: true, deferred: false, changed: true };
  }

  function togglePetVisibility() {
    return setPetHidden(!petHidden);
  }

  // ── #525: self-healing for cloaked-yet-supposedly-visible windows ──
  //
  // Called from the 5s topmost watchdog, powerMonitor resume/unlock, and the
  // second-instance handler. Deliberately NOT wired into togglePetVisibility:
  // hide must always mean hide (a cloak-aware toggle polarity degenerates into
  // "can never hide" on machines whose cloak flag reads permanently non-zero —
  // the exact regression review round 2026-07-16 blocked in the external
  // patch). Recovery failures back off exponentially so a stubborn cloak never
  // turns the watchdog into a 5s hide/show strobe.
  const CLOAK_BACKOFF_BASE_MS = 5_000;
  const CLOAK_BACKOFF_MAX_MS = 300_000;
  let cloakFailStreak = 0;
  let cloakCooldownUntil = 0;

  function recoverIfCloaked() {
    if (!cloakInspector || !cloakInspector.available) return "unavailable";
    if (petHidden) return "hidden";
    if (getMiniTransitioning() || isMiniAnimating() || dragLocked) return "busy";
    if (settingsSizePreviewSyncFrozen) return "frozen";
    if (now() < cloakCooldownUntil) return "backoff";

    const targets = [getRenderWindow(), getHitWindow()].filter(isLiveWindow);
    if (!targets.length) return "no-window";

    let attempted = false;
    let touched = false;
    let stillCloaked = false;
    for (const win of targets) {
      const flag = cloakInspector.readCloakState(win);
      if (flag === 0) continue;
      const verdict = classifyCloakState(flag, cloakInspector.isOnCurrentVirtualDesktop(win));
      if (verdict !== "recover") continue;
      attempted = true;
      // Fail-open contract: if the DWM un-cloak call itself fails, do NOT go
      // on to touch the window (show/taskbar/topmost would be a behavior
      // change over the pre-#525 no-op, and a fail-open re-read of 0 could
      // then mislabel the round "recovered"). Count it as a failure and let
      // the backoff decide when to try again.
      if (!cloakInspector.uncloak(win)) {
        stillCloaked = true;
        continue;
      }
      win.showInactive();
      keepOutOfTaskbar(win);
      touched = true;
      if (cloakInspector.readCloakState(win) !== 0) stillCloaked = true;
    }
    if (!attempted) {
      // Nothing abnormal this round: the previous fault (if any) resolved on
      // its own, so the NEXT independent fault must start from a fresh 10s
      // backoff instead of inheriting an escalated cooldown.
      cloakFailStreak = 0;
      cloakCooldownUntil = 0;
      return "clean";
    }

    // Same fail-open contract as above, second exit: a round where every
    // un-cloak call failed must not re-assert topmost either — that would
    // setAlwaysOnTop both windows on a path where native calls are failing.
    if (touched) reassertWinTopmost();
    if (!stillCloaked) {
      cloakFailStreak = 0;
      cloakCooldownUntil = 0;
      scheduleHwndRecovery();
      return "recovered";
    }
    cloakFailStreak += 1;
    const backoff = Math.min(
      CLOAK_BACKOFF_BASE_MS * 2 ** cloakFailStreak,
      CLOAK_BACKOFF_MAX_MS
    );
    cloakCooldownUntil = now() + backoff;
    return "failed";
  }

  // A transparent Windows BrowserWindow can finish its first load while the
  // native HWND is nominally visible but still parked below the useful z-order
  // or waiting for a compositor refresh. The manual "bring to primary display"
  // action heals that state because it replays bounds, shows both layers, and
  // re-asserts topmost. Run the same non-relocating sequence after the renderer
  // finishes loading so startup/crash recovery does not require that menu
  // action. Intentional hiding and in-flight geometry transitions remain
  // authoritative.
  function recoverVisiblePetAfterRendererLoad() {
    if (!isWin) return "unsupported";
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return "no-window";
    if (petHidden) return "hidden";
    if (getMiniTransitioning() || isMiniAnimating() || dragLocked) return "busy";
    if (settingsSizePreviewSyncFrozen) return "frozen";

    // Replaying the exact virtual bounds is intentional: setBounds() gives a
    // transparent HWND a compositor refresh without discarding the user's
    // saved display/edge position. applyPetWindowBounds also preserves a
    // virtual negative-Y offset used by top-edge pinning. force:true is
    // required here (plan §4.3 point 3 / §12.12): the materialized physical
    // rect is normally identical to what's already live, and
    // applyPetWindowBounds() now skips the native write in that case unless
    // told not to — but the whole point of this path is the compositor
    // refresh from a real setBounds() call.
    const bounds = getPetWindowBounds();
    if (bounds) {
      applyPetWindowBounds(bounds, { force: true });
      syncHitWin();
      repositionAnchoredSurfaces();
    }
    showPetWindows();
    reapplyMacVisibility();
    reassertWinTopmost();
    scheduleHwndRecovery();
    return "recovered";
  }

  function bringPetToPrimaryDisplay() {
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return;
    if (getMiniMode() || getMiniTransitioning()) return;

    const workArea = getPrimaryWorkAreaFallback();
    const size = getEffectiveCurrentPixelSize(workArea);
    const bounds = {
      x: Math.round(workArea.x + (workArea.width - size.width) / 2),
      y: Math.round(workArea.y + (workArea.height - size.height) / 2),
      width: size.width,
      height: size.height,
    };

    applyPetWindowBounds(bounds);
    syncHitWin();
    repositionFloatingBubbles();

    if (petHidden) {
      togglePetVisibility();
    } else {
      showPetWindows();
    }

    reapplyMacVisibility();
    reassertWinTopmost();
    scheduleHwndRecovery();
    flushRuntimeStateToPrefs();
  }

  function getObjRect(bounds) {
    return petGeometryMain.getObjRect(bounds);
  }

  function getAssetPointerPayload(bounds, point) {
    return petGeometryMain.getAssetPointerPayload(bounds, point);
  }

  function getHitRectScreen(bounds) {
    return clipHitRectToMiniSeam(petGeometryMain.getHitRectScreen(bounds));
  }

  function getUpdateBubbleAnchorRect(bounds) {
    return petGeometryMain.getUpdateBubbleAnchorRect(bounds);
  }

  function getSessionHudAnchorRect(bounds) {
    return petGeometryMain.getSessionHudAnchorRect(bounds);
  }

  function getVisibleContentMargins(bounds) {
    const theme = getActiveTheme();
    if (!bounds || !theme) return { top: 0, bottom: 0 };
    const box = getThemeMarginBox(theme);
    if (!box) return { top: 0, bottom: 0 };

    const cacheKey = [
      theme._id || "",
      theme._variantId || "",
      bounds.width,
      bounds.height,
      JSON.stringify(box),
    ].join("|");
    const cached = themeMarginEnvelopeCache.get(cacheKey);
    if (cached) return cached;

    const margins = computeStableVisibleContentMargins(theme, bounds, { box });
    themeMarginEnvelopeCache.set(cacheKey, margins);
    return margins;
  }

  function looseClampPetToDisplays(x, y, w, h) {
    const margins = getVisibleContentMargins({ x, y, width: w, height: h });
    const bottomInset = getNearestDisplayBottomInset(x + w / 2, y + h / 2);
    return computeLooseClamp(
      getAllDisplays(),
      getPrimaryWorkAreaSafe(),
      x,
      y,
      w,
      h,
      getLooseDragMargins({
        width: w,
        height: h,
        visibleMargins: margins,
        allowEdgePinning: getAllowEdgePinning(),
        bottomInset,
      })
    );
  }

  function isValidWorkArea(wa) {
    return !!(
      wa
      && Number.isFinite(wa.x)
      && Number.isFinite(wa.y)
      && Number.isFinite(wa.width)
      && wa.width > 0
      && Number.isFinite(wa.height)
      && wa.height > 0
    );
  }

  function clampToScreenVisual(x, y, w, h, optionsArg = {}) {
    const margins = getVisibleContentMargins(
      { x, y, width: w, height: h },
      optionsArg
    );
    const forcedWorkArea = isValidWorkArea(optionsArg.workArea)
      ? optionsArg.workArea
      : null;
    const nearest = forcedWorkArea || getNearestWorkArea(x + w / 2, y + h / 2);
    const insetProbeX = forcedWorkArea ? nearest.x + nearest.width / 2 : x + w / 2;
    const insetProbeY = forcedWorkArea ? nearest.y + nearest.height / 2 : y + h / 2;
    const bottomInset = getNearestDisplayBottomInset(insetProbeX, insetProbeY);
    const mLeft = Math.round(w * 0.25);
    const mRight = Math.round(w * 0.25);
    const clampMargins = getRestClampMargins({
      height: h,
      visibleMargins: margins,
      allowEdgePinning: "allowEdgePinning" in optionsArg
        ? optionsArg.allowEdgePinning
        : getAllowEdgePinning(),
      bottomInset,
    });
    return {
      x: Math.max(nearest.x - mLeft, Math.min(x, nearest.x + nearest.width - w + mRight)),
      y: Math.max(
        nearest.y - clampMargins.top,
        Math.min(y, nearest.y + nearest.height - h + clampMargins.bottom)
      ),
    };
  }

  function clampToScreen(x, y, w, h) {
    return clampToScreenVisual(x, y, w, h);
  }

  function computeFinalDragBounds(bounds, size, clampPosition = clampToScreenVisual) {
    return computeFinalDragBoundsRaw(bounds, size, clampPosition);
  }

  function needsFinalClampAdjustment(bounds, size, clampPosition = clampToScreenVisual) {
    return needsFinalClampAdjustmentRaw(bounds, size, clampPosition);
  }

  // At an internal multi-monitor seam the render window is clip-pathed so its
  // seam-crossing half shows nothing — but the hit (input) window is a
  // transparent surface and would keep capturing clicks over the neighbouring
  // display. Clip the hit rect to the same seam so those clicks fall through.
  // The clamps keep the rect from inverting when the whole hit rect is past
  // the seam; the w<=0 guard in the callers then drops the degenerate result.
  function clipHitRectToMiniSeam(hit) {
    if (!hit) return hit;
    const seam = getMiniContainedSeam();
    if (!seam || !Number.isFinite(seam.boundary)) return hit;
    if (seam.edge === "right") {
      if (hit.right <= seam.boundary) return hit;
      return { ...hit, right: Math.max(hit.left, seam.boundary) };
    }
    if (hit.left >= seam.boundary) return hit;
    return { ...hit, left: Math.min(hit.right, seam.boundary) };
  }

  function syncHitWin() {
    const hitWin = getHitWindow();
    const win = getRenderWindow();
    if (!isLiveWindow(hitWin) || !isLiveWindow(win)) return;
    // Keep the captured pointer stable while dragging. Repositioning the input
    // window mid-drag can break pointer capture on Windows.
    if (dragLocked) return;
    const bounds = getPetWindowBounds();
    const hit = getHitRectScreen(bounds);
    if (!hit) return;
    const x = Math.round(hit.left);
    const y = Math.round(hit.top);
    const w = Math.round(hit.right - hit.left);
    const h = Math.round(hit.bottom - hit.top);
    if (w <= 0 || h <= 0) return;
    hitWin.setBounds({ x, y, width: w, height: h });
    // Update shape if hitbox dimensions changed (e.g. after resize).
    if (w !== hitShapeWidth || h !== hitShapeHeight) {
      hitShapeWidth = w;
      hitShapeHeight = h;
      hitWin.setShape([{ x: 0, y: 0, width: w, height: h }]);
    }
    repositionSessionHud();
    // #640: the hit rect just (re)resolved — state switches and theme reloads
    // change hitboxes without moving the window, so the overlap answer can
    // flip right here. Cheap + edge-triggered inside.
    syncImeEditingPetDodge();
  }

  function getInitialHitWindowBounds(renderBounds = getPetWindowBounds()) {
    const hit = getHitRectScreen(renderBounds);
    if (!hit) return null;
    return {
      x: Math.round(hit.left),
      y: Math.round(hit.top),
      width: Math.round(hit.right - hit.left),
      height: Math.round(hit.bottom - hit.top),
    };
  }

  function createRenderWindow(optionsArg = {}) {
    const BrowserWindow = optionsArg.BrowserWindow;
    if (typeof BrowserWindow !== "function") {
      throw new Error("createRenderWindow requires BrowserWindow");
    }
    const isQuitting = typeof optionsArg.isQuitting === "function" ? optionsArg.isQuitting : () => false;
    const size = optionsArg.size;
    const initialWindowBounds = optionsArg.initialWindowBounds;
    const renderWin = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: initialWindowBounds.x,
      y: initialWindowBounds.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: linuxWindowType } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      webPreferences: {
        preload: optionsArg.preloadPath,
        backgroundThrottling: false,
        additionalArguments: [
          "--theme-config=" + JSON.stringify(optionsArg.themeConfig),
        ],
      },
    });

    if (typeof optionsArg.setRenderWindow === "function") {
      optionsArg.setRenderWindow(renderWin);
    }
    renderWin.setFocusable(false);

    if (isLinux) {
      renderWin.on("close", (event) => {
        if (!isQuitting()) {
          event.preventDefault();
          if (!renderWin.isVisible()) {
            renderWin.showInactive();
            keepOutOfTaskbar(renderWin);
          }
        }
      });
      renderWin.on("unresponsive", () => {
        if (isQuitting()) return;
        console.warn("Clawd: renderer unresponsive — reloading");
        reloadWindowWebContents(renderWin);
      });
    }

    if (isWin) renderWin.setAlwaysOnTop(true, topmostLevel);
    if (isWin) {
      let sessionEndFlushed = false;
      const flushForSessionEnd = () => {
        if (sessionEndFlushed) return;
        sessionEndFlushed = true;
        try {
          flushRuntimeStateToPrefs();
        } catch (err) {
          console.warn("Clawd: failed to persist prefs during Windows session end:", err && err.message);
        }
      };
      renderWin.on("query-session-end", flushForSessionEnd);
      renderWin.on("session-end", flushForSessionEnd);
    }
    renderWin.loadFile(optionsArg.loadFilePath);
    // file:// zoom propagates partition-wide and persists across restarts;
    // builds that briefly used setZoomFactor for textScale may have left a
    // non-1 factor behind. Reset it from the first window to load so the pet
    // (and, via propagation, every file:// page) renders 1:1 — textScale uses
    // per-document CSS zoom instead and never touches this map.
    if (renderWin.webContents && typeof renderWin.webContents.once === "function") {
      renderWin.webContents.once("did-finish-load", () => {
        try { renderWin.webContents.setZoomFactor(1); } catch {}
      });
    }
    // force:true: the BrowserWindow constructor above already received
    // initialWindowBounds (the pre-materialized, safe physical rect), so
    // re-materializing initialVirtualBounds here will usually match live
    // bounds exactly and would otherwise be skipped by the "same rect"
    // optimization. Force a definitive write anyway so offset truth
    // (lastLogicalBounds/viewportOffsetX/Y) is established the same way
    // regardless of whether the constructor's bounds happened to match.
    applyPetWindowBounds(optionsArg.initialVirtualBounds, { force: true });
    renderWin.showInactive();
    keepOutOfTaskbar(renderWin);
    reapplyMacVisibility();

    if (isMac && typeof optionsArg.applyDockVisibility === "function") {
      setTimeout(() => {
        if (!isLiveWindow(renderWin)) return;
        optionsArg.applyDockVisibility();
      }, 0);
    }

    return renderWin;
  }

  function createHitWindow(optionsArg = {}) {
    const BrowserWindow = optionsArg.BrowserWindow;
    if (typeof BrowserWindow !== "function") {
      throw new Error("createHitWindow requires BrowserWindow");
    }
    const initialHitWindowBounds = getInitialHitWindowBounds();
    const hitWin = new BrowserWindow({
      width: initialHitWindowBounds.width,
      height: initialHitWindowBounds.height,
      x: initialHitWindowBounds.x,
      y: initialHitWindowBounds.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: linuxWindowType } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      // KEY EXPERIMENT: allow activation to avoid WS_EX_NOACTIVATE input
      // routing bugs. Linux keeps the old non-focusable behavior.
      focusable: !isLinux,
      webPreferences: {
        preload: optionsArg.preloadPath,
        backgroundThrottling: false,
        additionalArguments: [
          "--hit-theme-config=" + JSON.stringify(optionsArg.hitThemeConfig),
          "--hit-platform=" + process.platform,
        ],
      },
    });
    // setShape: native hit region, no per-pixel alpha dependency.
    // hitWin has no visual content, so clipping is irrelevant.
    hitWin.setShape([{ x: 0, y: 0, width: initialHitWindowBounds.width, height: initialHitWindowBounds.height }]);
    // Baseline: interactive. Only two writers may toggle this — the Windows
    // settings-size-preview protection (below) and the macOS editing-overlap
    // dodge (#640, topmost-runtime.js). They are platform-disjoint.
    hitWin.setIgnoreMouseEvents(false);
    if (isMac) hitWin.setFocusable(false);
    hitWin.showInactive();
    keepOutOfTaskbar(hitWin);
    if (isWin) hitWin.setAlwaysOnTop(true, topmostLevel);
    reapplyMacVisibility();
    hitWin.loadFile(optionsArg.loadFilePath);
    if (isWin && typeof optionsArg.guardAlwaysOnTop === "function") {
      optionsArg.guardAlwaysOnTop(hitWin);
    }
    if (typeof optionsArg.onDidFinishLoad === "function") {
      hitWin.webContents.on("did-finish-load", () => optionsArg.onDidFinishLoad(hitWin));
    }
    hitWin.webContents.on("render-process-gone", (_event, details) => {
      if (typeof optionsArg.onRenderProcessGone === "function") {
        optionsArg.onRenderProcessGone(details, hitWin);
        return;
      }
      reloadRuntimeWindowWebContents(hitWin, { crashKey: "hitWin", details });
    });
    return hitWin;
  }

  function setDragLocked(value) {
    dragLocked = !!value;
  }

  function isDragLocked() {
    return dragLocked;
  }

  function beginDragSnapshot() {
    const win = getRenderWindow();
    if (!isLiveWindow(win)) {
      dragSnapshot = null;
      return;
    }
    const bounds = getPetWindowBounds();
    if (!bounds) {
      dragSnapshot = null;
      return;
    }
    // #408: use the effective size (frozen, when keepSizeAcrossDisplays is on)
    // so the drag snapshot follows the frozen invariant instead of re-reading
    // live bounds — keeps every size path on one source of truth.
    const size = getEffectiveCurrentPixelSize();
    dragSnapshot = createDragSnapshot(
      getCursorScreenPoint(),
      bounds,
      size
    );
  }

  function clearDragSnapshot() {
    dragSnapshot = null;
  }

  function moveWindowForDrag() {
    if (!dragLocked) return;
    if (getMiniMode() || getMiniTransitioning()) return;
    if (!isLiveWindow(getRenderWindow())) return;
    if (!dragSnapshot) return;

    const bounds = computeAnchoredDragBounds(
      dragSnapshot,
      getCursorScreenPoint(),
      looseClampPetToDisplays
    );
    if (!bounds) return;

    applyPetWindowBounds(bounds);
    if (isWin && isNearWorkAreaEdge(bounds)) reassertWinTopmost();
    syncHitWin();
    repositionAnchoredSurfaces();
  }

  function hasStoredPositionThemeMismatch(prefs) {
    const theme = getActiveTheme();
    if (!prefs || !theme) return false;
    return prefs.positionThemeId !== theme._id
      || prefs.positionVariantId !== theme._variantId;
  }

  function resolveStartupPlacement(prefs, size, optionsArg = {}) {
    const restoreMiniFromPrefs = optionsArg.restoreMiniFromPrefs || (() => null);
    let startBounds;
    if (prefs.miniMode) {
      startBounds = restoreMiniFromPrefs(prefs, size);
    } else if (prefs.positionSaved) {
      startBounds = { x: prefs.x, y: prefs.y, width: size.width, height: size.height };
    } else {
      const workArea = getPrimaryWorkAreaFallback();
      startBounds = {
        x: workArea.x + workArea.width - size.width - 20,
        y: workArea.y + workArea.height - size.height - 20,
        width: size.width,
        height: size.height,
      };
    }

    const allDisplays = getAllDisplays();
    const savedDisplayStillAttached = !!findMatchingDisplay(
      prefs.positionDisplay,
      allDisplays
    );
    const savedCenterVisible = isPointInAnyWorkArea(
      startBounds.x + startBounds.width / 2,
      startBounds.y + startBounds.height / 2,
      allDisplays
    );
    const startupNeedsRegularize = prefs.positionSaved
      && !prefs.miniMode
      && (
        hasStoredPositionThemeMismatch(prefs)
        || (
          !(savedDisplayStillAttached && savedCenterVisible)
          && needsFinalClampAdjustment(startBounds, size, clampToScreenVisual)
        )
      );
    const startupRegularizedBounds = startupNeedsRegularize
      ? computeFinalDragBounds(startBounds, size, clampToScreenVisual)
      : null;
    const initialVirtualBounds = startupRegularizedBounds || startBounds;
    const initialMaterialized = materializeVirtualBounds(initialVirtualBounds);
    return {
      startBounds,
      startupNeedsRegularize,
      startupRegularizedBounds,
      initialVirtualBounds,
      initialWindowBounds: (initialMaterialized && initialMaterialized.bounds) || initialVirtualBounds,
    };
  }

  function beginSettingsSizePreviewProtection() {
    settingsSizePreviewSyncFrozen = true;
    if (!isWin) return;
    const settingsWindow = getSettingsWindow();
    if (
      isLiveWindow(settingsWindow)
      && typeof settingsWindow.setAlwaysOnTop === "function"
    ) {
      settingsWindow.setAlwaysOnTop(true, topmostLevel);
      if (typeof settingsWindow.moveTop === "function") settingsWindow.moveTop();
    }
    const hitWin = getHitWindow();
    if (
      isLiveWindow(hitWin)
      && typeof hitWin.setIgnoreMouseEvents === "function"
    ) {
      hitWin.setIgnoreMouseEvents(true);
    }
  }

  function endSettingsSizePreviewProtection() {
    settingsSizePreviewSyncFrozen = false;
    if (!isWin) return;
    const settingsWindow = getSettingsWindow();
    if (
      isLiveWindow(settingsWindow)
      && typeof settingsWindow.setAlwaysOnTop === "function"
    ) {
      settingsWindow.setAlwaysOnTop(false);
    }
    const hitWin = getHitWindow();
    if (
      isLiveWindow(hitWin)
      && typeof hitWin.setIgnoreMouseEvents === "function"
    ) {
      hitWin.setIgnoreMouseEvents(false);
      hitWin.setAlwaysOnTop(true, topmostLevel);
    }
    reassertWinTopmost();
    scheduleHwndRecovery();
  }

  function syncFloatingWindowsAfterPetBoundsChange() {
    if (settingsSizePreviewSyncFrozen) return;
    syncHitWin();
    repositionAnchoredSurfaces();
  }

  function handleDisplayMetricsChanged() {
    reapplyMacVisibility();
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return;
    if (getMiniTransitioning()) return;
    if (getMiniMode()) {
      handleMiniDisplayChange();
      return;
    }
    const current = getPetWindowBounds();
    const size = getEffectiveCurrentPixelSize();
    const clamped = clampToScreenVisual(current.x, current.y, size.width, size.height);
    const proportionalRecalc = isProportionalMode() && !getKeepSizeAcrossDisplays();
    // #408: also re-apply when the live size drifted from the effective size — a
    // Windows sleep/wake can resize the window without moving it, and keepSize
    // must snap it back to the frozen size even when no position clamp is needed.
    const sizeDrifted = current.width !== size.width || current.height !== size.height;
    if (proportionalRecalc || sizeDrifted || clamped.x !== current.x || clamped.y !== current.y) {
      applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
      syncHitWin();
      repositionAnchoredSurfaces();
    }
  }

  function handleDisplayRemoved() {
    reapplyMacVisibility();
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return;
    if (getMiniTransitioning()) return;
    if (getMiniMode()) {
      exitMiniMode();
      return;
    }
    const current = getPetWindowBounds();
    const size = getEffectiveCurrentPixelSize();
    const clamped = clampToScreenVisual(current.x, current.y, size.width, size.height);
    applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
    syncHitWin();
    repositionAnchoredSurfaces();
  }

  function handleDisplayAdded() {
    reapplyMacVisibility();
    const win = getRenderWindow();
    if (isLiveWindow(win) && !getMiniTransitioning() && getMiniMode()) {
      handleMiniDisplayChange();
    }
    repositionAnchoredSurfaces();
  }

  return {
    getObjRect,
    getAssetPointerPayload,
    getHitRectScreen,
    getUpdateBubbleAnchorRect,
    getSessionHudAnchorRect,
    getPetWindowBounds,
    applyPetWindowBounds,
    applyPetWindowPosition,
    isPetHidden,
    setPetHidden,
    togglePetVisibility,
    recoverIfCloaked,
    recoverVisiblePetAfterRendererLoad,
    bringPetToPrimaryDisplay,
    getViewportOffsetY,
    setViewportOffsetY,
    getViewportOffsetX,
    setViewportOffsetX,
    getVisibleContentMargins,
    looseClampPetToDisplays,
    clampToScreenVisual,
    clampToScreen,
    computeFinalDragBounds,
    needsFinalClampAdjustment,
    materializeVirtualBounds,
    syncHitWin,
    getInitialHitWindowBounds,
    createRenderWindow,
    createHitWindow,
    reloadWindowWebContents: reloadRuntimeWindowWebContents,
    setDragLocked,
    isDragLocked,
    beginDragSnapshot,
    clearDragSnapshot,
    moveWindowForDrag,
    resolveStartupPlacement,
    beginSettingsSizePreviewProtection,
    endSettingsSizePreviewProtection,
    syncFloatingWindowsAfterPetBoundsChange,
    handleDisplayMetricsChanged,
    handleDisplayRemoved,
    handleDisplayAdded,
  };
}

module.exports = createPetWindowRuntime;
