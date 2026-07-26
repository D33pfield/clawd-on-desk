// src/mini.js — Mini mode (edge snap, crabwalk, peek, window animations)
// Extracted from main.js L315-331, L2700-2911

const { screen } = require("electron");
const { resolveHorizontalEdgeContext } = require("./display-edge");

module.exports = function initMini(ctx) {

const PEEK_OFFSET = 25;
const SNAP_TOLERANCE = 30;
const JUMP_PEAK_HEIGHT = 40;
const JUMP_DURATION = 350;
const MINI_ENTER_FALLBACK_MS = 3200;
const MINI_ENTER_PRELOAD_MS = 300;
const CRABWALK_SPEED = 0.12;  // px/ms
let MINI_OFFSET_RATIO = ctx.theme.miniMode.offsetRatio;

let miniMode = false;
let miniEdge = "right";  // "left" | "right"
let miniTransitioning = false;
let miniSleepPeeked = false;
let miniPeeked = false;
let preMiniX = 0, preMiniY = 0;
let currentMiniX = 0;
let miniSnap = null;  // { y, width, height } — canonical rect to prevent DPI drift
let lastMiniWorkArea = null;  // workArea of the display the mini pet is on
let miniTransitionTimer = null;
let peekAnimTimer = null;
let isAnimating = false;
// Issue #690 plan §4.5 point 4.5-4: set when a display/workArea topology
// change lands while mini is transitioning (pet-window-runtime.js's
// handleDisplayMetricsChanged() hands it off here instead of silently
// dropping it). Consumed exactly once, at whichever of mini's three
// transition-end points (cancelMiniTransition(), finishMiniEntry()'s settle,
// exitMiniMode()'s parabola onDone) comes next, for a final re-materialize
// against the now-current topology.
let pendingTopologyMaterialize = false;

function syncSessionHudVisibility() {
  if (typeof ctx.syncSessionHudVisibility === "function") ctx.syncSessionHudVisibility();
}

function repositionSessionHud() {
  if (typeof ctx.repositionSessionHud === "function") ctx.repositionSessionHud();
}

function refreshTheme() {
  MINI_OFFSET_RATIO = ctx.theme.miniMode.offsetRatio;
}

function themeSupportsMini() {
  return !!(ctx.theme && ctx.theme.miniMode && ctx.theme.miniMode.supported !== false);
}

function notifyTopologyChangedDuringTransition() {
  pendingTopologyMaterialize = true;
}

// §4.5 point 3: mini's per-frame Y clamp, factored out of what used to be
// two independent inline copies of the same formula (handleDisplayChange /
// handleResize) — restoreFromPrefs() turned out to carry a third, so this is
// now the single shared definition all three (plus applyMiniFrameBounds
// below) call into.
function clampY(y, wa, height) {
  return Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
}

// Resolves the shared display topology ONCE for a mini transition (entry
// animation, crabwalk, exit parabola, peek, or a one-shot display/resize
// reflow) — never per animation frame (plan §4.5 point 4.5-4 / §12.8's
// screen.getAllDisplays() ≤ 1 budget). `edge` is display-edge.js's dual-sided
// context, reusable both for seamBoundaryFromEdge() below and as
// applyMiniFrameBounds()'s materialize-time edgeContext.
function resolveMiniTopology(wa, yMid) {
  const displays = screen.getAllDisplays();
  const edge = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid });
  return { displays, edge };
}

// Pure projection from an already-resolved topology — no getAllDisplays()
// call of its own. See seamBoundary() below for the one-shot convenience
// wrapper still used by call sites that don't already have a cached
// topology at hand.
function seamBoundaryFromEdge(edgeContext, edge) {
  const side = edge === "right" ? edgeContext.right : edgeContext.left;
  return side.hasAdjacentDisplay ? side.physicalBoundary : null;
}

// When the mini pet at `wa`/`yMid` sits at an internal seam in `edge`
// direction, returns the seam X — the local display's *bounds* edge, which
// is the physical boundary the neighbouring monitor begins at (and the same
// place a single-display mini gets physically cut off by the screen edge).
// Returns null at an outer screen edge (single display, or no neighbour at
// the pet's vertical band). Delegates the actual topology judgment to the
// shared src/display-edge.js helper so mini's internal-seam clip and the
// Linux edge-virtualization materializer can't disagree about which edges
// are seams — see docs/plans/plan-issue-690-gnome-mini-edge-snap.md §4.1.
// One-shot convenience wrapper (its own single getAllDisplays() call) for
// callers that don't already have a cached topology — every remaining call
// site here (handleDisplayChange/handleResize/restoreFromPrefs) runs once
// per event, never per animation frame.
function seamBoundary(wa, yMid, edge) {
  const { edge: edgeContext } = resolveMiniTopology(wa, yMid);
  return seamBoundaryFromEdge(edgeContext, edge);
}

// ── Window animation ──
// Per §4.5, every mini animation frame writes through applyMiniFrameBounds()
// (X-only, assertNoYOffset) instead of a raw native bounds/position write.
// Y offset stays pinned at 0 for mini's whole lifecycle (enterMiniMode()/
// enterMiniViaMenu() call ctx.setViewportOffsetY(0) once on the way in); X
// offset is NOT reset — see §4.5 point 2 — so logical and physical X can
// legitimately diverge throughout mini's lifetime, with the renderer's
// composite-only translate (§4.4) making up the visual difference.
//
// [historical] 4ba1cd0 found that wiring mini's per-frame writes into
// applyPetWindowBounds() the naive way (re-resolving workArea/edge context on
// every frame) caused a materialize → IPC → renderer per-asset restyle storm
// that stalled the main thread during mini entry — it was never a shipped
// "fixed" state, just a dead end during development. The fix isn't avoiding
// applyPetWindowBounds — it's resolving the animation's workArea/edge
// topology exactly ONCE (resolveMiniTopology/animCtx, threaded through every
// frame below) and using assertNoYOffset so the write only ever touches the
// composite-only X path (§4.4), never reopening Y layout.
function applyMiniFrameBounds(logicalX, snap, animCtx) {
  // The parabola's up-to-40px arc peak must be clamped back into the
  // workArea before it ever reaches applyPetWindowBounds() — this makes
  // assertNoYOffset's own guard a pure backstop that should never actually
  // fire in normal operation (see pet-window-runtime.js's
  // applyPetWindowBounds() for what happens if it somehow does: log once,
  // refuse to forward a Y IPC, never reopen the Y layout hot path).
  const y = clampY(snap.y, animCtx.workArea, snap.height);
  return ctx.applyPetWindowBounds(
    { x: logicalX, y, width: snap.width, height: snap.height },
    { workArea: animCtx.workArea, edgeContext: animCtx.edge, assertNoYOffset: true }
  );
}

// Fallback topology resolution for animation call sites that don't already
// have one in hand (miniPeekIn/miniPeekOut — short, standalone animations
// run while already parked in mini mode). Prefers the workArea mini is
// already anchored to over re-deriving it.
function resolveMiniAnimCtx(bounds) {
  const wa = lastMiniWorkArea || ctx.getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const topology = resolveMiniTopology(wa, bounds.y + bounds.height / 2);
  return { workArea: wa, edge: topology.edge };
}

function animateWindowX(targetX, durationMs, onDone, animCtx) {
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  const start = ctx.getPetWindowBounds();
  const startX = start.x;
  if (startX === targetX) {
    isAnimating = false;
    if (onDone) onDone();
    return;
  }
  isAnimating = true;
  const resolvedAnimCtx = animCtx || resolveMiniAnimCtx(start);
  const startTime = Date.now();
  const snapY = miniSnap ? miniSnap.y : start.y;
  const snapW = miniSnap ? miniSnap.width : start.width;
  const snapH = miniSnap ? miniSnap.height : start.height;
  let frameCount = 0;
  const step = () => {
    if (!ctx.win || ctx.win.isDestroyed()) {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    if (!Number.isFinite(x) || !Number.isFinite(snapY)) {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    try {
      applyMiniFrameBounds(x, { y: snapY, width: snapW, height: snapH }, resolvedAnimCtx);
    } catch {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    ctx.syncHitWin();
    repositionSessionHud();
    syncContainedClip();
    // Throttle bubble reposition to every 3rd frame (~20fps) — visually identical, less overhead
    if (ctx.bubbleFollowPet && ctx.pendingPermissions.length && (++frameCount % 3 === 0 || t >= 1)) ctx.repositionBubbles();
    if (t < 1) {
      peekAnimTimer = setTimeout(step, 16);
    } else {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
    }
  };
  step();
}

function animateWindowParabola(targetX, targetY, durationMs, onDone, animCtx) {
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  const start = ctx.getPetWindowBounds();
  const startX = start.x, startY = start.y;
  if (startX === targetX && startY === targetY) {
    isAnimating = false;
    if (onDone) onDone();
    return;
  }
  isAnimating = true;
  const resolvedAnimCtx = animCtx || resolveMiniAnimCtx(start);
  const snapW = start.width, snapH = start.height;
  const startTime = Date.now();
  let frameCount = 0;
  const step = () => {
    if (!ctx.win || ctx.win.isDestroyed()) {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    const arc = -4 * JUMP_PEAK_HEIGHT * t * (t - 1);
    const y = Math.round(startY + (targetY - startY) * eased - arc);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    try {
      applyMiniFrameBounds(x, { y, width: snapW, height: snapH }, resolvedAnimCtx);
    } catch {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
      return;
    }
    ctx.syncHitWin();
    repositionSessionHud();
    syncContainedClip();
    // Throttle bubble reposition to every 3rd frame (~20fps) — visually identical, less overhead
    if (ctx.bubbleFollowPet && ctx.pendingPermissions.length && (++frameCount % 3 === 0 || t >= 1)) ctx.repositionBubbles();
    if (t < 1) {
      peekAnimTimer = setTimeout(step, 16);
    } else {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
    }
  };
  step();
}

// Multi-monitor seam state: when the mini pet sits at an internal seam, the
// half that pokes past `containedBoundary` (the display 1 edge in screen X)
// gets clip-pathed away in the renderer so it doesn't show on the neighbour.
// `null` outside contained mini.
let containedBoundary = null;

function syncContainedClip() {
  // Startup recovery computes the seam state before the render window
  // exists; theme/renderer reload can also tear the window down briefly.
  // Bail out rather than dereference a missing window — the clip is
  // (re)sent from syncRendererStateAfterLoad() once the renderer is up.
  if (!ctx.win || ctx.win.isDestroyed()) return;
  if (!miniMode || containedBoundary == null) {
    ctx.sendToRenderer("mini-clip", null);
    return;
  }
  // §4.5 point 5: one of the few places mini.js still reads the *physical*
  // window rect on purpose — the clip fraction is a real BrowserWindow's
  // pixel intersection with the neighbouring monitor's physical edge, not a
  // logical-bounds quantity. Reading ctx.getPetWindowBounds() here would clip
  // against where the pet logically wants to be rather than where the
  // renderer's onscreen pixels actually straddle the seam.
  const bounds = ctx.win.getBounds();
  if (!bounds.width) return;
  const fraction = (containedBoundary - bounds.x) / bounds.width;
  ctx.sendToRenderer("mini-clip", {
    fraction: Math.max(0, Math.min(1, fraction)),
    edge: miniEdge,
  });
}

// Shared X-position formula for mini mode (eliminates duplication across 4+ call sites)
function calcMiniX(wa, size) {
  if (miniEdge === "left") return wa.x - Math.round(size.width * MINI_OFFSET_RATIO);
  return wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
}

function miniPeekIn() {
  const offset = miniEdge === "left" ? PEEK_OFFSET : -PEEK_OFFSET;
  animateWindowX(currentMiniX + offset, 200);
}

function miniPeekOut() {
  animateWindowX(currentMiniX, 200);
}

function getMiniStateFile(state) {
  const miniStates = ctx.theme && ctx.theme.miniMode && ctx.theme.miniMode.states;
  if (!miniStates) return null;
  const files = miniStates[state];
  return Array.isArray(files) && files[0] ? files[0] : null;
}

function getMiniEnterDurationMs(state) {
  const file = getMiniStateFile(state);
  const cycleMs = typeof ctx.getAnimationAssetCycleMs === "function"
    ? ctx.getAnimationAssetCycleMs(file)
    : null;
  return Number.isFinite(cycleMs) && cycleMs > 0 ? cycleMs : MINI_ENTER_FALLBACK_MS;
}

function getMiniRestState() {
  return ctx.doNotDisturb ? "mini-sleep" : "mini-idle";
}

// §4.5 point 4.5-4: one of mini's three transition-end points. If a topology
// change landed mid-transition (pendingTopologyMaterialize), consume it here
// with exactly one fresh re-anchor — mini mode is still active at this
// point, so handleDisplayChange()'s own workArea/currentMiniX/clampedY
// re-resolution is the correct target, not a bespoke duplicate of it.
function consumePendingTopologyMaterializeInMini() {
  if (!pendingTopologyMaterialize) return;
  pendingTopologyMaterialize = false;
  if (miniMode) handleDisplayChange();
}

function finishMiniEntry(delayMs) {
  if (miniTransitionTimer) { clearTimeout(miniTransitionTimer); miniTransitionTimer = null; }
  const settleMs = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : MINI_ENTER_FALLBACK_MS;
  miniTransitionTimer = setTimeout(() => {
    miniTransitionTimer = null;
    miniTransitioning = false;
    // Issue #690 plan §4.3.10's mini transition+animation reconcile
    // protection release point.
    if (typeof ctx.releaseReconcileProtection === "function") ctx.releaseReconcileProtection();
    consumePendingTopologyMaterializeInMini();
    ctx.applyState(getMiniRestState());
  }, settleMs);
}

function cancelMiniTransition() {
  miniTransitioning = false;
  if (miniTransitionTimer) { clearTimeout(miniTransitionTimer); miniTransitionTimer = null; }
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  isAnimating = false;
  if (typeof ctx.releaseReconcileProtection === "function") ctx.releaseReconcileProtection();
  consumePendingTopologyMaterializeInMini();
}

function _getSize() {
  if (typeof ctx.getEffectiveCurrentPixelSize === "function") {
    return ctx.getEffectiveCurrentPixelSize();
  }
  return ctx.getCurrentPixelSize ? ctx.getCurrentPixelSize() : ctx.SIZES[ctx.currentSize];
}

function checkMiniModeSnap() {
  if (!themeSupportsMini()) return;
  if (miniMode) return;
  const bounds = ctx.getPetWindowBounds();
  const size = _getSize();
  const mEdge = Math.round(size.width * 0.25);
  const centerX = bounds.x + size.width / 2;
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const wa = d.workArea;
    const centerY = bounds.y + size.height / 2;
    if (centerX < wa.x || centerX > wa.x + wa.width) continue;
    if (centerY < wa.y || centerY > wa.y + wa.height) continue;
    // Right edge snap
    const rightLimit = wa.x + wa.width - size.width + mEdge;
    if (bounds.x >= rightLimit - SNAP_TOLERANCE) {
      enterMiniMode(wa, false, "right");
      return;
    }
    // Left edge snap
    const leftLimit = wa.x - mEdge;
    if (bounds.x <= leftLimit + SNAP_TOLERANCE) {
      enterMiniMode(wa, false, "left");
      return;
    }
  }
}

function enterMiniMode(wa, viaMenu, edge) {
  if (!themeSupportsMini()) return;
  if (miniMode && !viaMenu) return;
  // §4.5 point 2: read ctx.getPetWindowBounds() exactly ONCE as `start` — the
  // single logical-bounds source of truth for everything below (preMini,
  // miniSnap.y, the seam/topology yMid, and both animation targets). X offset
  // is already folded into start.x; it must not be re-read via a raw
  // ctx.win.getBounds() anywhere in this function.
  const start = ctx.getPetWindowBounds();
  // preMini 存 virtual — 退出 mini 时能复原贴顶位置
  if (!viaMenu) {
    preMiniX = start.x;
    preMiniY = start.y;
  }
  // 清零 viewport offset(Y)— mini 全程 Y offset 恒为 0;X offset 不清零
  // (§4.5 point 2),全程只走 §4.4 的 composite-only 路径,见 applyMiniFrameBounds
  if (typeof ctx.setViewportOffsetY === "function") ctx.setViewportOffsetY(0);
  miniMode = true;
  miniSleepPeeked = false;
  miniPeeked = false;
  if (edge) miniEdge = edge;
  const size = _getSize();
  currentMiniX = calcMiniX(wa, size);
  lastMiniWorkArea = wa;
  miniSnap = { y: start.y, width: size.width, height: size.height };

  // Single topology resolution for this whole transition (§4.5 point 4.5-4 /
  // §12.8): reused below for the seam clip, the entry animation's every
  // frame via animCtx, and (via topology.displays) the viaMenu jump-target
  // scan further down — never re-resolved per frame.
  const topology = resolveMiniTopology(wa, start.y + size.height / 2);
  containedBoundary = seamBoundaryFromEdge(topology.edge, miniEdge);
  const animCtx = { workArea: wa, edge: topology.edge };

  // Multi-monitor seam detection — when active, the renderer clips the half
  // of the window that crosses the seam so the neighbouring display stays
  // clean while the local display still shows the natural half-body peek.
  syncContainedClip();

  ctx.stopWakePoll();

  ctx.sendToRenderer("mini-mode-change", true, miniEdge);
  ctx.sendToHitWin("hit-state-sync", { miniMode: true });
  miniTransitioning = true;
  ctx.buildContextMenu();
  ctx.buildTrayMenu();
  syncSessionHudVisibility();

  const enterSvgState = ctx.doNotDisturb ? "mini-enter-sleep" : "mini-enter";

  if (viaMenu) {
    const adjacent = containedBoundary != null;
    let jumpTarget;
    if (adjacent) {
      // Internal seam: skip fly-off-screen; arc lands at the contained mini X
      // so the parabola never crosses onto the neighbouring display.
      jumpTarget = currentMiniX;
    } else {
      let maxRight = 0;
      let minLeft = Infinity;
      for (const d of topology.displays) {
        maxRight = Math.max(maxRight, d.bounds.x + d.bounds.width);
        minLeft = Math.min(minLeft, d.bounds.x);
      }
      jumpTarget = miniEdge === "right" ? maxRight : minLeft - size.width;
    }
    animateWindowParabola(jumpTarget, start.y, JUMP_DURATION, () => {
      const enterDurationMs = getMiniEnterDurationMs(enterSvgState);
      ctx.applyState(enterSvgState);
      if (MINI_ENTER_PRELOAD_MS <= 0) {
        miniSnap = { y: start.y, width: size.width, height: size.height };
        applyMiniFrameBounds(currentMiniX, miniSnap, animCtx);
        ctx.syncHitWin();
        syncSessionHudVisibility();
        syncContainedClip();
        finishMiniEntry(enterDurationMs);
        return;
      }
      miniTransitionTimer = setTimeout(() => {
        miniSnap = { y: start.y, width: size.width, height: size.height };
        applyMiniFrameBounds(currentMiniX, miniSnap, animCtx);
        miniTransitionTimer = null;
        ctx.syncHitWin();
        syncSessionHudVisibility();
        syncContainedClip();
        finishMiniEntry(enterDurationMs);
      }, MINI_ENTER_PRELOAD_MS);
    }, animCtx);
  } else {
    // Drag path: slide the window into place first, then play mini-enter.
    // Running the 100ms window slide concurrently with the ~960ms in-SVG
    // body-slide used to cancel them out visually (opposite directions, 10×
    // speed difference) — the body-slide became invisible and the pet
    // looked frozen for ~1s before the arm wave. Sequencing them matches
    // the via-menu path: window settles, then the full entry animation
    // plays in place and reads clearly.
    animateWindowX(currentMiniX, 100, () => {
      ctx.applyState(enterSvgState);
      finishMiniEntry(getMiniEnterDurationMs(enterSvgState));
    }, animCtx);
  }
}

// Shared by exitMiniMode()'s initial animation target AND its
// pendingTopologyMaterialize re-materialize (§4.5 point 4.5-4) — both need
// "where should the pet rest once back in normal mode", the second time
// against whatever topology is current at that later moment.
function resolveExitRestingBounds() {
  const size = _getSize();
  const visualState = ctx.doNotDisturb ? "idle" : ctx.resolveDisplayState();
  const visualFile = visualState ? ctx.getSvgOverride(visualState) : null;
  const restoreWorkArea = getAttachedMiniWorkArea();
  const clamped = ctx.clampToScreenVisual(preMiniX, preMiniY, size.width, size.height, {
    state: visualState,
    file: visualFile,
    workArea: restoreWorkArea,
  });
  const wa = restoreWorkArea || ctx.getNearestWorkArea(clamped.x + size.width / 2, clamped.y + size.height / 2);
  const mEdge = Math.round(size.width * 0.25);
  // Prevent right-edge re-snap
  if (clamped.x >= wa.x + wa.width - size.width + mEdge - SNAP_TOLERANCE) {
    clamped.x = wa.x + wa.width - size.width + mEdge - 100;
  }
  // Prevent left-edge re-snap
  if (clamped.x <= wa.x - mEdge + SNAP_TOLERANCE) {
    clamped.x = wa.x - mEdge + SNAP_TOLERANCE + 100;
  }
  return { clamped, wa, size };
}

function exitMiniMode() {
  if (!miniMode) return;
  cancelMiniTransition();
  // Keep miniMode = true and miniTransitioning = true during exit parabola.
  // This blocks ALL paths that check miniMode (always-on-top-changed,
  // display-metrics-changed, move-window-by, checkMiniModeSnap, etc.)
  // from interfering with the animation. Both flags clear in onDone.
  miniTransitioning = true;
  miniSnap = null;
  miniSleepPeeked = false;
  miniPeeked = false;

  const { clamped, wa, size } = resolveExitRestingBounds();
  const topology = resolveMiniTopology(wa, clamped.y + size.height / 2);
  const animCtx = { workArea: wa, edge: topology.edge };

  animateWindowParabola(clamped.x, clamped.y, JUMP_DURATION, () => {
    miniMode = false;
    miniTransitioning = false;
    containedBoundary = null;
    // Issue #690 plan §4.3.10's mini transition+animation reconcile
    // protection release point.
    if (typeof ctx.releaseReconcileProtection === "function") ctx.releaseReconcileProtection();
    if (pendingTopologyMaterialize) {
      pendingTopologyMaterialize = false;
      // Topology changed again mid-exit-animation: `clamped` above may now be
      // stale (it was resolved before/at animation start). Mini mode has
      // already ended by this point, so re-resolve the normal (non-mini)
      // resting position fresh — not handleDisplayChange(), which is mini-
      // mode-specific — and materialize once more against current topology.
      const fresh = resolveExitRestingBounds();
      ctx.applyPetWindowBounds(
        { x: fresh.clamped.x, y: fresh.clamped.y, width: fresh.size.width, height: fresh.size.height },
        { workArea: fresh.wa }
      );
    }
    ctx.sendToRenderer("mini-clip", null);
    ctx.sendToRenderer("mini-mode-change", false);
    ctx.sendToHitWin("hit-state-sync", { miniMode: false });
    ctx.buildContextMenu();
    ctx.buildTrayMenu();
    syncSessionHudVisibility();
    if (ctx.doNotDisturb) {
      ctx.doNotDisturb = false;
      ctx.sendToRenderer("dnd-change", false);
      ctx.sendToHitWin("hit-state-sync", { dndEnabled: false });
      ctx.buildContextMenu();
      ctx.buildTrayMenu();
      ctx.applyState("waking");
    } else {
      const resolved = ctx.resolveDisplayState();
      ctx.applyState(resolved, ctx.getSvgOverride(resolved));
    }
    // #329: a deferred update bubble may be waiting on mini exit.
    if (typeof ctx.notifyUpdaterSilentExit === "function") {
      try { ctx.notifyUpdaterSilentExit(); } catch {}
    }
  }, animCtx);
}

function enterMiniViaMenu() {
  if (!themeSupportsMini()) return;
  // §4.5 point 2: same single logical-bounds read as enterMiniMode() — see
  // its comment above for why a second ctx.win.getBounds() must not appear.
  const start = ctx.getPetWindowBounds();
  // preMini 存 virtual — 退出 mini 时能复原贴顶位置
  preMiniX = start.x;
  preMiniY = start.y;
  // 清零 viewport offset(Y)— 和 enterMiniMode 对称;X offset 不清零,理由同上
  if (typeof ctx.setViewportOffsetY === "function") ctx.setViewportOffsetY(0);
  const size = _getSize();
  const wa = ctx.getNearestWorkArea(start.x + size.width / 2, start.y + size.height / 2);

  // Auto-detect nearest edge
  const centerX = start.x + size.width / 2;
  const waMid = wa.x + wa.width / 2;
  const edge = centerX <= waMid ? "left" : "right";
  miniEdge = edge;

  miniTransitioning = true;
  syncSessionHudVisibility();

  // Pre-entry crabwalk still uses the normal-size render/layout path. Send the
  // edge for left-side flipping, but don't let the renderer enter mini layout
  // until enterMiniMode() starts the real mini handoff.
  ctx.sendToRenderer("mini-mode-change", true, edge, { preEntry: true });
  ctx.sendToHitWin("hit-state-sync", { miniMode: true });

  ctx.applyState("mini-crabwalk");

  // Single topology resolution for the crabwalk phase (§4.5 point 4.5-4) —
  // enterMiniMode(), scheduled below, resolves its own separately when it
  // actually starts the mini handoff moments later.
  const topology = resolveMiniTopology(wa, start.y + size.height / 2);
  const adjacent = seamBoundaryFromEdge(topology.edge, edge) != null;
  const animCtx = { workArea: wa, edge: topology.edge };
  let edgeX;
  if (edge === "right") {
    edgeX = adjacent
      ? wa.x + wa.width - size.width
      : wa.x + wa.width - size.width + Math.round(size.width * 0.25);
  } else {
    edgeX = adjacent ? wa.x : wa.x - Math.round(size.width * 0.25);
  }
  const walkDist = Math.abs(start.x - edgeX);
  const walkDuration = walkDist / CRABWALK_SPEED;
  animateWindowX(edgeX, walkDuration, null, animCtx);

  miniTransitionTimer = setTimeout(() => {
    enterMiniMode(wa, true, edge);
  }, walkDuration + 50);
}

function refreshContainedBoundary(wa, yMid) {
  containedBoundary = seamBoundary(wa, yMid, miniEdge);
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

function sameWorkArea(a, b) {
  return !!(
    isValidWorkArea(a)
    && isValidWorkArea(b)
    && a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height
  );
}

function getAttachedMiniWorkArea() {
  if (!isValidWorkArea(lastMiniWorkArea)) return null;
  const displays = screen.getAllDisplays();
  if (!Array.isArray(displays) || displays.length === 0) return null;
  return displays.some((d) => d && sameWorkArea(d.workArea, lastMiniWorkArea))
    ? lastMiniWorkArea
    : null;
}

// Internal-seam state for the hit (input) window. When non-null the hit
// rect must be clipped to the same seam so the transparent input surface
// does not keep capturing clicks over the neighbouring display.
function getContainedSeam() {
  if (containedBoundary == null) return null;
  return { boundary: containedBoundary, edge: miniEdge };
}

function handleDisplayChange() {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  if (!miniMode) return;
  const size = _getSize();
  // Y offset 恒为 0,X offset 允许非零且只走 composite 路径 — 读逻辑 bounds
  // (已含 X offset),不读物理 ctx.win.getBounds()
  const start = ctx.getPetWindowBounds();
  const snapY = miniSnap ? miniSnap.y : start.y;
  const wa = ctx.getNearestWorkArea(currentMiniX + size.width / 2, snapY + size.height / 2);
  lastMiniWorkArea = wa;
  currentMiniX = calcMiniX(wa, size);
  // mini 的 y 必须在工作区内(逻辑坐标),加回两端 clamp
  const clampedY = clampY(snapY, wa, size.height);
  miniSnap = { y: clampedY, width: size.width, height: size.height };
  ctx.applyPetWindowBounds({ x: currentMiniX, y: clampedY, width: size.width, height: size.height }, { workArea: wa });
  // §4.5 point 5 / §12.9: this write can be an offset-only change (physical
  // rect unchanged, only the logical/offset split shifted), which produces
  // no native move event — sync hit explicitly rather than relying on an
  // async reconcile that may never fire (I6: "offset change is also a
  // window move").
  ctx.syncHitWin();
  refreshContainedBoundary(wa, clampedY + size.height / 2);
  syncContainedClip();
  syncSessionHudVisibility();
}

function handleResize(sizeKey) {
  if (!miniMode) return false;
  const { y: curY } = ctx.getPetWindowBounds();
  const wa = lastMiniWorkArea || ctx.getNearestWorkArea(currentMiniX, curY);
  const size = (typeof ctx.getPixelSizeFor === "function")
    ? ctx.getPixelSizeFor(sizeKey, wa)
    : ctx.SIZES[sizeKey];
  currentMiniX = calcMiniX(wa, size);
  const clampedY = clampY(curY, wa, size.height);
  miniSnap = { y: clampedY, width: size.width, height: size.height };
  ctx.applyPetWindowBounds({ x: currentMiniX, y: clampedY, width: size.width, height: size.height }, { workArea: wa });
  // See handleDisplayChange() above — same offset-only-write hit sync gap.
  ctx.syncHitWin();
  refreshContainedBoundary(wa, clampedY + size.height / 2);
  syncContainedClip();
  syncSessionHudVisibility();
  return true;
}

function restoreFromPrefs(prefs, size) {
  preMiniX = prefs.preMiniX || 0;
  preMiniY = prefs.preMiniY || 0;
  miniEdge = prefs.miniEdge || "right";
  const wa = ctx.getNearestWorkArea(prefs.x + size.width / 2, prefs.y + size.height / 2);
  lastMiniWorkArea = wa;
  currentMiniX = calcMiniX(wa, size);
  // 启动恢复 mini 时 y 必须在工作区内(保证 Y offset = 0,符合 mini 语义;
  // X offset 允许非零,由调用方后续首次 applyPetWindowBounds 决定)
  const startY = clampY(prefs.y, wa, size.height);
  miniSnap = { y: startY, width: size.width, height: size.height };
  miniMode = true;
  miniTransitioning = false;
  miniSleepPeeked = false;
  miniPeeked = false;
  // Compute the seam state only — the render window does not exist yet at
  // startup restore. The renderer clip is (re)sent by
  // syncRendererStateAfterLoad() once the renderer has finished loading.
  refreshContainedBoundary(wa, startY + size.height / 2);
  return { x: currentMiniX, y: startY, width: size.width, height: size.height };
}

function getMiniMode() { return miniMode; }
function getMiniEdge() { return miniEdge; }
function getMiniTransitioning() { return miniTransitioning; }
function getMiniSleepPeeked() { return miniSleepPeeked; }
function setMiniSleepPeeked(v) { miniSleepPeeked = v; }
function getMiniPeeked() { return miniPeeked; }
function setMiniPeeked(v) { miniPeeked = v; }
function getIsAnimating() { return isAnimating; }
function getPreMiniX() { return preMiniX; }
function getPreMiniY() { return preMiniY; }
function getCurrentMiniX() { return currentMiniX; }
function getMiniSnap() { return miniSnap; }

function cleanup() {
  if (miniTransitionTimer) { clearTimeout(miniTransitionTimer); miniTransitionTimer = null; }
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
}

return {
  enterMiniMode, exitMiniMode, enterMiniViaMenu,
  miniPeekIn, miniPeekOut, checkMiniModeSnap, cancelMiniTransition,
  animateWindowX, animateWindowParabola,
  refreshTheme,
  syncContainedClip, getContainedSeam,
  handleDisplayChange, handleResize, restoreFromPrefs,
  notifyTopologyChangedDuringTransition,
  getMiniMode, getMiniEdge, getMiniTransitioning, getMiniSleepPeeked, setMiniSleepPeeked, getMiniPeeked, setMiniPeeked,
  getIsAnimating, getPreMiniX, getPreMiniY, getCurrentMiniX, getMiniSnap,
  get MINI_OFFSET_RATIO() { return MINI_OFFSET_RATIO; },
  PEEK_OFFSET,
  cleanup,
};

};
