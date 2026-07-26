"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const createPetWindowRuntime = require("../src/pet-window-runtime");

const SRC_DIR = path.join(__dirname, "..", "src");

function makeWindow(bounds = { x: 10, y: 20, width: 100, height: 100 }) {
  const calls = [];
  const listeners = new Map();
  const win = {
    calls,
    bounds: { ...bounds },
    destroyed: false,
    visible: true,
    webContents: {
      destroyed: false,
      on: (event, cb) => listeners.set(event, cb),
      reload: () => calls.push(["reload"]),
      isDestroyed() { return this.destroyed; },
    },
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    getBounds: () => ({ ...win.bounds }),
    setBounds: (next) => {
      calls.push(["setBounds", next]);
      win.bounds = { ...next };
    },
    setShape: (shape) => calls.push(["setShape", shape]),
    setIgnoreMouseEvents: (value) => calls.push(["setIgnoreMouseEvents", value]),
    setAlwaysOnTop: (...args) => calls.push(["setAlwaysOnTop", ...args]),
    setFocusable: (value) => calls.push(["setFocusable", value]),
    showInactive: () => calls.push(["showInactive"]),
    hide: () => calls.push(["hide"]),
    loadFile: (file) => calls.push(["loadFile", file]),
    on: (event, cb) => listeners.set(event, cb),
    emit: (event, ...args) => listeners.get(event)?.(...args),
  };
  return win;
}

function makeBrowserWindow(instances) {
  return function FakeBrowserWindow(options) {
    const win = makeWindow({
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height,
    });
    win.options = options;
    instances.push(win);
    return win;
  };
}

// Issue #690's reconcile machinery (§4.3.9-13) schedules real setTimeout-based
// debounce/sweep timers using PRODUCTION constants (RECONCILE_QUIET_MS=100 /
// SETTLE_MS=400 / HIT_QUIET_MS=250) — shrinking the thresholds to make tests
// fast would only prove the shrunk thresholds work, not production timing.
// This fake clock instead supplies now()/setTimeout()/clearTimeout() together
// so `advance(ms)` deterministically fires whatever timers become due, in due
// -time order, without any real sleep. Firing a timer can itself schedule new
// timers within the same advance window (e.g. a settle sweep re-arming
// itself) — the loop keeps consuming newly-due timers until none remain
// before the target time, then lands the clock exactly on target.
function createFakeClock(startAt = 0) {
  let current = startAt;
  let seq = 0;
  const timers = [];
  return {
    now: () => current,
    setTimeout: (fn, delay) => {
      const id = ++seq;
      const due = current + (Number.isFinite(delay) ? delay : 0);
      timers.push({ id, due, fn, cancelled: false, fired: false });
      return id;
    },
    clearTimeout: (id) => {
      const t = timers.find((entry) => entry.id === id);
      if (t) t.cancelled = true;
    },
    advance(ms) {
      const target = current + (Number.isFinite(ms) ? ms : 0);
      for (;;) {
        const due = timers
          .filter((t) => !t.cancelled && !t.fired && t.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id);
        if (due.length === 0) break;
        const next = due[0];
        next.fired = true;
        current = next.due;
        next.fn();
      }
      current = target;
    },
    pendingCount() {
      return timers.filter((t) => !t.cancelled && !t.fired).length;
    },
  };
}

function createRuntime(overrides = {}) {
  const calls = [];
  let renderWin = overrides.renderWin || makeWindow();
  let hitWin = overrides.hitWin || makeWindow();
  const displays = overrides.displays || [{
    id: 1,
    bounds: { x: 0, y: 0, width: 1000, height: 800 },
    workArea: { x: 0, y: 0, width: 1000, height: 760 },
  }];
  const runtime = createPetWindowRuntime({
    screen: {
      getAllDisplays: () => displays,
      getCursorScreenPoint: () => (
        typeof overrides.cursor === "function"
          ? overrides.cursor()
          : (overrides.cursor || { x: 100, y: 100 })
      ),
      getDisplayNearestPoint: () => displays[0],
      getPrimaryDisplay: () => displays[0],
    },
    isWin: overrides.isWin ?? true,
    isMac: overrides.isMac ?? false,
    isLinux: overrides.isLinux ?? false,
    linuxWindowType: "toolbar",
    topmostLevel: "pop-up-menu",
    getRenderWindow: () => renderWin,
    getHitWindow: () => hitWin,
    getSettingsWindow: () => overrides.settingsWindow || null,
    getActiveTheme: () => overrides.theme || null,
    getCurrentState: () => "idle",
    getCurrentSvg: () => "idle.svg",
    getCurrentHitBox: () => overrides.hitBox || null,
    getMiniMode: () => overrides.miniMode || false,
    getMiniTransitioning: () => overrides.miniTransitioning || false,
    getMiniContainedSeam: () => overrides.miniContainedSeam || null,
    getMiniPeekOffset: () => 0,
    getCurrentPixelSize: () => overrides.currentPixelSize || { width: 100, height: 100 },
    getEffectiveCurrentPixelSize: () => overrides.effectivePixelSize || { width: 100, height: 100 },
    getKeepSizeAcrossDisplays: () => overrides.keepSizeAcrossDisplays || false,
    getAllowEdgePinning: () => overrides.allowEdgePinning || false,
    isProportionalMode: () => overrides.proportional || false,
    getPrimaryWorkAreaSafe: () => displays[0].workArea,
    getNearestWorkArea: () => displays[0].workArea,
    sendToRenderer: (...args) => calls.push(["sendToRenderer", ...args]),
    keepOutOfTaskbar: (win) => calls.push(["keepOutOfTaskbar", win]),
    repositionSessionHud: () => calls.push(["repositionSessionHud"]),
    repositionAnchoredSurfaces: () => calls.push(["repositionAnchoredSurfaces"]),
    repositionFloatingBubbles: () => calls.push(["repositionFloatingBubbles"]),
    showFloatingSurfacesForPet: () => calls.push(["showFloatingSurfacesForPet"]),
    hideFloatingSurfacesForPet: () => calls.push(["hideFloatingSurfacesForPet"]),
    syncSessionHudVisibilityAndBubbles: () => calls.push(["syncSessionHudVisibilityAndBubbles"]),
    syncPermissionShortcuts: () => calls.push(["syncPermissionShortcuts"]),
    buildTrayMenu: () => calls.push(["buildTrayMenu"]),
    buildContextMenu: () => calls.push(["buildContextMenu"]),
    reapplyMacVisibility: () => calls.push(["reapplyMacVisibility"]),
    ...(overrides.syncImeEditingPetDodge
      ? { syncImeEditingPetDodge: overrides.syncImeEditingPetDodge }
      : {}),
    reassertWinTopmost: () => calls.push(["reassertWinTopmost"]),
    scheduleHwndRecovery: () => calls.push(["scheduleHwndRecovery"]),
    ...(overrides.cloakInspector ? { cloakInspector: overrides.cloakInspector } : {}),
    ...(overrides.isMiniAnimating ? { isMiniAnimating: overrides.isMiniAnimating } : {}),
    ...(overrides.isRoamAnimating ? { isRoamAnimating: overrides.isRoamAnimating } : {}),
    ...(overrides.isEdgeVirtualizationDisabled
      ? { isEdgeVirtualizationDisabled: overrides.isEdgeVirtualizationDisabled }
      : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.edgeLog ? { edgeLog: overrides.edgeLog } : {}),
    isNearWorkAreaEdge: () => overrides.nearEdge || false,
    flushRuntimeStateToPrefs: () => calls.push(["flushRuntimeStateToPrefs"]),
    handleMiniDisplayChange: () => calls.push(["handleMiniDisplayChange"]),
    exitMiniMode: () => calls.push(["exitMiniMode"]),
    crashReloadLimit: overrides.crashReloadLimit,
    crashReloadWindowMs: overrides.crashReloadWindowMs,
    crashReloadLog: overrides.crashReloadLog,
    // A fake clock (createFakeClock() below) supplies now/setTimeout/
    // clearTimeout TOGETHER so reconcile's timers advance deterministically
    // with simulated time instead of a real sleep — placed last so it wins
    // over the plain overrides.now spread above for tests that need it.
    ...(overrides.clock
      ? { now: overrides.clock.now, setTimeout: overrides.clock.setTimeout, clearTimeout: overrides.clock.clearTimeout }
      : { now: overrides.now }),
  });
  return {
    runtime,
    calls,
    get renderWin() { return renderWin; },
    get hitWin() { return hitWin; },
    setRenderWin: (win) => { renderWin = win; },
    setHitWin: (win) => { hitWin = win; },
  };
}

// ── #690 Phase 0 fixture — Fedora 44 / GNOME Shell 50.3 / Mutter reproduction ──
// docs/plans/plan-issue-690-gnome-mini-edge-snap.md §1.2 and §5 Phase 0.
// 1920x1080 single display, 203x209 pet window — the reporter's exact
// geometry (xdotool getwindowgeometry: X=1717, WIDTH=203; render 8388612
// also reports HEIGHT=209). Mutter's require_fully_onscreen constraint means
// any application-driven setBounds() asking for X > 1717
// (workArea.width - window.width = 1920 - 203) gets clamped straight back to
// 1717. Modeled synchronously here (setBounds "lands" already clamped)
// because this fixture only proves the pre-fix logical/physical pollution —
// the deferred-reconcile timing (settle sweep, adopt-clamp) is out of scope
// for this batch and modeled by a later one.
const ISSUE_690_WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };
const ISSUE_690_WINDOW_SIZE = { width: 203, height: 209 };
const ISSUE_690_MUTTER_MAX_X = 1717; // workArea.width - window.width

function makeMutterClampedWindow(bounds) {
  const win = makeWindow(bounds);
  win.setBounds = (next) => {
    // Record exactly what the application asked for...
    win.calls.push(["setBounds", next]);
    // ...but Mutter only ever lets the physical window land fully on-screen.
    const clampedX = next.x > ISSUE_690_MUTTER_MAX_X ? ISSUE_690_MUTTER_MAX_X : next.x;
    win.bounds = { ...next, x: clampedX };
  };
  return win;
}

function create690Fixture(overrides = {}) {
  const renderWin = overrides.renderWin || makeMutterClampedWindow({
    x: 0,
    y: 721,
    width: ISSUE_690_WINDOW_SIZE.width,
    height: ISSUE_690_WINDOW_SIZE.height,
  });
  return createRuntime({
    isWin: false,
    isLinux: true,
    displays: [{
      id: 1,
      bounds: ISSUE_690_WORK_AREA,
      workArea: ISSUE_690_WORK_AREA,
    }],
    ...overrides,
    renderWin,
  });
}

// Mirrors main.js's actual wiring (src/main.js's win.on("move"/"resize", ...)
// / hitWin.on("move"/"resize", ...)) so unit tests can drive the reconcile
// machinery the same way a real native window event would, without
// constructing all of main.js.
function wireNativeGeometryListeners(harness) {
  harness.renderWin.on("move", () => harness.runtime.onNativeGeometryEvent());
  harness.renderWin.on("resize", () => harness.runtime.onNativeGeometryEvent());
  harness.hitWin.on("move", () => harness.runtime.onHitNativeGeometryEvent());
  harness.hitWin.on("resize", () => harness.runtime.onHitNativeGeometryEvent());
}

describe("pet-window-runtime edge virtualization (#690 Phase 2 batch 2 red fixtures)", () => {
  it("rebases logical bounds after a WM externally moves the render window while offset is non-zero", () => {
    const clock = createFakeClock();
    const harness = create690Fixture({ clock });
    wireNativeGeometryListeners(harness);

    // Establish a non-zero X offset: logical 1768 clamps to physical 1717
    // (the Phase 0 fixture's exact numbers), offsetX=+51.
    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    assert.equal(harness.runtime.getViewportOffsetX(), 51);

    // Let this write's own settle window (400ms) fully expire — and its
    // harmless no-op sweep fire (actual already matches expected) — before
    // simulating an UNRELATED, later external move. A mismatch discovered
    // WITHIN the original write's settle period is deliberately adopt-
    // clamped instead of rebased (§4.3.10's generous acceptance window), so
    // this ordering is what makes the difference observable.
    clock.advance(500);

    // Simulate an external WM move (e.g. GNOME Super+drag of the render
    // window) — mutating .bounds directly, NOT via applyPetWindowBounds(),
    // represents a physical write our own code never issued.
    harness.renderWin.bounds = {
      x: 800, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    };
    harness.renderWin.emit("move");
    clock.advance(200); // past RECONCILE_QUIET_MS

    // I2's rebase formula: logical = actualPhysicalX + oldViewportOffsetX =
    // 800 + 51 = 851. This is the ONLY assertion needed to prove the bug/fix:
    // pre-fix, getPetWindowBounds() has no path back to a WM-moved physical
    // window at all (no listener, no reconcile exist), so it stays frozen at
    // the stale 1768 forever — a permanent visual/hit misalignment, not a
    // temporary lag.
    assert.equal(
      harness.runtime.getPetWindowBounds().x,
      851,
      "logical X must rebase onto the externally-moved physical position, preserving the visual offset"
    );
  });

  it("distinguishes a mid-drag pause from a confirmed grab end on the hit window (two-level judgment)", () => {
    // §4.3.11 public premise 2: Mutter grab-ignores position writes rather
    // than clamping them — the hit window's actual stays wherever the user
    // is dragging it, completely independent of what we last requested.
    // Public premise 4's deadlock: a single-level "no hit move event for
    // HIT_QUIET_MS => grab ended" judgment can't tell a genuine release
    // apart from the user merely pausing mid-drag (a trackpad re-grip alone
    // can exceed 250ms) — misjudging the pause as "grab ended" and acting on
    // it (rebase/bounce-back in a later batch) would fight the still-active
    // drag. This fixture proves the two-level judgment (confirm across TWO
    // consecutive HIT_QUIET_MS periods) correctly waits through the pause
    // instead of firing on the first one.
    const clock = createFakeClock();
    const edgeLogs = [];
    const hitWin = makeWindow({ x: 100, y: 100, width: 100, height: 100 });
    // Grab-ignore mock: setBounds() is silently swallowed (Mutter mid-grab
    // never applies our writes), exactly public premise 2's "static/free"
    // retries -- getBounds() keeps returning whatever the user's drag last
    // put there, set directly by the test below.
    hitWin.setBounds = () => {};
    const harness = createRuntime({ hitWin, clock, edgeLog: (message) => edgeLogs.push(message) });
    wireNativeGeometryListeners(harness);
    // Seed a "requested" target so runHitReconcile() has something to
    // compare actual against (normally established by syncHitWin()).
    harness.runtime.applyPetWindowBounds({ x: 100, y: 100, width: 100, height: 100 });
    harness.runtime.syncHitWin();

    // User grabs the hit window (Super+drag) and moves it to P1, then pauses
    // for exactly one HIT_QUIET_MS period.
    hitWin.bounds = { x: 500, y: 500, width: 100, height: 100 };
    hitWin.emit("move");
    clock.advance(250);

    assert.ok(
      !edgeLogs.some((line) => line.includes("edge-hit-external-move-candidate")),
      "a single stable observation must NOT be treated as a confirmed grab end"
    );

    // User resumes dragging to a different point, P2 -- proving the pause
    // didn't get latched into anything: this is still "the user is
    // dragging", not a rejected retry or a stuck state.
    hitWin.bounds = { x: 650, y: 500, width: 100, height: 100 };
    hitWin.emit("move");
    clock.advance(250);

    assert.ok(
      !edgeLogs.some((line) => line.includes("edge-hit-external-move-candidate")),
      "resuming the drag must reset the stability streak, not carry over toward confirmation"
    );

    // Now the user genuinely releases at P2 and nothing moves again — two
    // consecutive HIT_QUIET_MS periods stable at the SAME value confirms the
    // grab ended.
    clock.advance(250);

    assert.ok(
      edgeLogs.some((line) => line.includes("edge-hit-external-move-candidate") && line.includes("650,500")),
      "two consecutive stable periods at the post-release position must confirm the grab ended"
    );
  });
});

describe("pet-window-runtime edge virtualization (#690 Phase 0 fixture)", () => {
  it("keeps the logical X at the requested value when the physical window is clamped back into the work area", () => {
    const harness = create690Fixture();

    // This is the existing 25%-margin rest-clamp target clampToScreenVisual()
    // already computes for a 203px-wide window: Math.round(203 * 0.25) = 51;
    // 1920 - 203 + 51 = 1768. The application legitimately wants to place the
    // pet here — this is its logical intent, fed straight into
    // applyPetWindowBounds() exactly like every other caller in this file.
    const requested = {
      x: 1768,
      y: 721,
      width: ISSUE_690_WINDOW_SIZE.width,
      height: ISSUE_690_WINDOW_SIZE.height,
    };
    harness.runtime.applyPetWindowBounds(requested);

    // Whether the runtime blindly asks the OS for 1768 and gets clamped back
    // (pre-fix — the mock's require_fully_onscreen model fires), or the
    // runtime's own Linux edge-awareness predicts the identical safe boundary
    // and asks for it directly (post-fix — see docs/plans/
    // plan-issue-690-gnome-mini-edge-snap.md §4.2's worked example,
    // logicalX=1768/physicalX=1717), the physical window must never be left
    // requesting past the work area: 1920 - 203 = 1717, the issue's exact
    // reported geometry. This assertion holds on both sides of the fix; it is
    // not the one that proves the bug (see below).
    assert.equal(
      harness.renderWin.getBounds().x,
      1717,
      "the physical window must stay fully inside the 1920-wide work area"
    );

    // The bug: getPetWindowBounds() must keep reporting the logical intent
    // (1768), not whatever the physical window ended up at. Pre-fix, this
    // re-derives position from the live (clamped) physical bounds, so it
    // reports 1717 instead — this assertion is red before the Phase 2 runtime
    // fix and green after it.
    assert.equal(
      harness.runtime.getPetWindowBounds().x,
      1768,
      "logical X must survive an OS-side clamp, not be polluted by the physical readback"
    );
  });
});

describe("pet-window-runtime edge virtualization (#690 Phase 2 runtime)", () => {
  it("computes zero X offset and preserves full physical overflow on non-Linux platforms (I3)", () => {
    const renderWin = makeWindow({
      x: 0,
      y: 721,
      width: ISSUE_690_WINDOW_SIZE.width,
      height: ISSUE_690_WINDOW_SIZE.height,
    });
    const harness = createRuntime({
      isWin: true,
      isLinux: false,
      renderWin,
      displays: [{ id: 1, bounds: ISSUE_690_WORK_AREA, workArea: ISSUE_690_WORK_AREA }],
    });
    const requested = {
      x: 1768,
      y: 721,
      width: ISSUE_690_WINDOW_SIZE.width,
      height: ISSUE_690_WINDOW_SIZE.height,
    };

    const result = harness.runtime.applyPetWindowBounds(requested);

    assert.equal(result.x, 1768, "Windows/macOS keep the existing physical-overflow path unchanged");
    assert.deepStrictEqual(renderWin.calls.find((call) => call[0] === "setBounds"), ["setBounds", requested]);
    assert.equal(harness.runtime.getViewportOffsetX(), 0);
  });

  it("does not materialize X across an internal multi-monitor seam (I3)", () => {
    // Two 1920x1080 displays side by side — the left display's right edge at
    // x=1920 is an internal seam (a neighbour continues from there), not an
    // outer workArea edge, so X must be left completely alone: this is the
    // existing "physical cross-monitor overflow" behavior, unchanged.
    const renderWin = makeWindow({ x: 1800, y: 100, width: 203, height: 209 });
    const harness = createRuntime({
      isWin: false,
      isLinux: true,
      renderWin,
      displays: [
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
        { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
      ],
    });
    const requested = { x: 1900, y: 100, width: 203, height: 209 }; // crosses the seam at x=1920

    const result = harness.runtime.applyPetWindowBounds(requested);

    assert.equal(result.x, 1900, "an internal seam must never be materialized into an X offset");
    assert.equal(harness.runtime.getViewportOffsetX(), 0);
  });

  it("sends viewport-offset-x once per change and dedupes repeated values", () => {
    const harness = createRuntime();

    harness.runtime.setViewportOffsetX(50);
    harness.runtime.setViewportOffsetX(50);
    harness.runtime.setViewportOffsetX(-10);

    assert.deepStrictEqual(
      harness.calls.filter((call) => call[0] === "sendToRenderer" && call[1] === "viewport-offset-x"),
      [
        ["sendToRenderer", "viewport-offset-x", 50],
        ["sendToRenderer", "viewport-offset-x", -10],
      ]
    );
    assert.equal(harness.runtime.getViewportOffsetX(), -10);
  });

  it("skips the native setBounds call when the materialized physical rect already matches live bounds, unless force:true", () => {
    const renderWin = makeWindow({ x: 500, y: 300, width: 100, height: 100 });
    const harness = createRuntime({ renderWin });

    const result = harness.runtime.applyPetWindowBounds({ x: 500, y: 300, width: 100, height: 100 });

    assert.deepStrictEqual(renderWin.calls.filter((call) => call[0] === "setBounds"), []);
    assert.deepStrictEqual(result, { x: 500, y: 300, width: 100, height: 100 });

    harness.runtime.applyPetWindowBounds({ x: 500, y: 300, width: 100, height: 100 }, { force: true });

    assert.deepStrictEqual(renderWin.calls.filter((call) => call[0] === "setBounds"), [
      ["setBounds", { x: 500, y: 300, width: 100, height: 100 }],
    ]);
  });

  it("updates lastLogicalBounds before the native write, so a read triggered synchronously from inside setBounds sees the new logical position", () => {
    const renderWin = makeWindow({ x: 10, y: 20, width: 100, height: 100 });
    const harness = createRuntime({ renderWin });
    let observedDuringWrite = null;
    const realSetBounds = renderWin.setBounds;
    renderWin.setBounds = (next) => {
      // Simulate a WM/event callback re-entering our code mid-write (e.g. a
      // synchronous "move" notification) before the native call itself
      // returns.
      observedDuringWrite = harness.runtime.getPetWindowBounds();
      realSetBounds(next);
    };

    harness.runtime.applyPetWindowBounds({ x: 250, y: 60, width: 100, height: 100 });

    assert.deepStrictEqual(observedDuringWrite, { x: 250, y: 60, width: 100, height: 100 });
  });

  it("assertNoYOffset refuses to forward a non-zero Y offset and logs once without spamming repeated frames", () => {
    const edgeLogs = [];
    // A Y offset only becomes non-zero when the logical Y sits above the work
    // area top (existing top-edge-pinning semantics) — construct that
    // directly to exercise the assertNoYOffset branch without needing
    // mini.js's animation loop.
    const renderWin = makeWindow({ x: 100, y: 0, width: 100, height: 100 });
    const harness = createRuntime({ renderWin, edgeLog: (message) => edgeLogs.push(message) });

    harness.runtime.applyPetWindowBounds(
      { x: 100, y: -10, width: 100, height: 100 },
      { assertNoYOffset: true }
    );
    harness.runtime.applyPetWindowBounds(
      { x: 100, y: -10, width: 100, height: 100 },
      { assertNoYOffset: true }
    );

    assert.equal(
      harness.runtime.getViewportOffsetY(),
      0,
      "assertNoYOffset must never let a non-zero Y offset reach the renderer"
    );
    assert.equal(
      edgeLogs.filter((line) => line.includes("edge-assert-no-y-offset")).length,
      1,
      "a sustained non-zero-Y streak logs once, not once per frame"
    );

    // A clean (Y already 0) frame resets the dedup, so a later streak logs again.
    harness.runtime.applyPetWindowBounds({ x: 100, y: 0, width: 100, height: 100 }, { assertNoYOffset: true });
    harness.runtime.applyPetWindowBounds(
      { x: 100, y: -10, width: 100, height: 100 },
      { assertNoYOffset: true }
    );

    assert.equal(
      edgeLogs.filter((line) => line.includes("edge-assert-no-y-offset")).length,
      2,
      "a later non-zero-Y streak after a clean frame must log again"
    );
  });

  it("I2 backstop: an out-of-range materialized X offset hard-resyncs logical bounds to actual and zeroes both offsets", () => {
    const edgeLogs = [];
    const renderWin = makeWindow({ x: 500, y: 0, width: 203, height: 209 });
    const harness = createRuntime({
      renderWin,
      isLinux: true,
      // A pathologically narrow work area makes the outer-edge rightBound
      // land far to the left of the requested logical X, producing an
      // |offsetX| that reaches the window width — exactly the "materialize
      // predicted something absurd" case I2 exists to catch, independent of
      // the (not-yet-implemented) observedClampInset learning.
      displays: [{
        id: 1,
        bounds: { x: 0, y: 0, width: 10, height: 1000 },
        workArea: { x: 0, y: 0, width: 10, height: 1000 },
      }],
      edgeLog: (message) => edgeLogs.push(message),
    });

    const result = harness.runtime.applyPetWindowBounds({ x: 500, y: 0, width: 203, height: 209 });

    assert.ok(
      edgeLogs.some((line) => line.includes("edge-offset-out-of-range")),
      "the backstop must log the rejected offset"
    );
    assert.equal(harness.runtime.getViewportOffsetX(), 0, "a rejected offset must not reach the renderer");
    assert.equal(harness.runtime.getViewportOffsetY(), 0);
    assert.deepStrictEqual(
      harness.runtime.getPetWindowBounds(),
      { x: result.x, y: result.y, width: 203, height: 209 },
      "lastLogicalBounds must hard-resync to the actual physical rect, not the rejected logical target"
    );
  });

  it("resolveStartupPlacement() computes a Linux outer-edge-aware initialWindowBounds using the same materializer applyPetWindowBounds uses", () => {
    const harness = create690Fixture();
    const prefs = { positionSaved: true, x: 1768, y: 721 };
    const size = { width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height };

    const placement = harness.runtime.resolveStartupPlacement(prefs, size);

    assert.equal(
      placement.initialVirtualBounds.x,
      1768,
      "the logical/virtual bounds preserve the saved edge position"
    );
    assert.equal(
      placement.initialWindowBounds.x,
      1717,
      "the physical bounds used to construct the BrowserWindow must already be Mutter-safe, not off-screen"
    );
  });
});

// A second Mutter-clamp mock, distinct from makeMutterClampedWindow above:
// this one's real usable boundary is `rightInset` px further in than the
// raw 1920-wide workArea, letting tests exercise a Mutter/Electron
// workArea-vs-usable-region discrepancy (§4.3.14) instead of the fixed
// 1717px boundary the Phase 0 fixture hard-codes.
function makeInsetMutterClampedWindow(bounds, { rightInset = 0 } = {}) {
  const win = makeWindow(bounds);
  win.setBounds = (next) => {
    win.calls.push(["setBounds", next]);
    const maxX = ISSUE_690_WORK_AREA.width - rightInset - next.width;
    const clampedX = next.x > maxX ? maxX : next.x;
    win.bounds = { ...next, x: clampedX };
  };
  return win;
}

describe("pet-window-runtime edge virtualization (#690 Phase 2 batch 2 reconcile matrix)", () => {
  it("inset self-bootstrap: needs a SECOND consistent observation to actually learn (PR #751 rework batch A-3), not the first alone", () => {
    // Coordinator ruling (R5-7): this test's title/assertion used to be "the
    // very first clamp teaches the inset" — PR #751 Codex review #3 found
    // that a single clamp-explainable observation is not enough evidence on
    // its own (it could be a one-off external move that merely happens to
    // land on a workArea edge), so updateObservedClampInset() is now gated
    // behind a pending-candidate confirmation: only a SECOND consecutive
    // observation with the identical (displayId, edge, inset) actually
    // commits the learn. deriveClampObservation() itself is unchanged — it
    // still derives the candidate from actual by subtraction on the very
    // first clamp (never comparing against an already-known inset, which
    // would self-deadlock at inset=0) — only maybeLearnInset()'s gate in
    // front of it is new.
    const clock = createFakeClock();
    const renderWin = makeInsetMutterClampedWindow(
      { x: 0, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { rightInset: 40 }
    );
    const harness = create690Fixture({ renderWin, clock });
    wireNativeGeometryListeners(harness);

    assert.equal(harness.runtime.getObservedClampInset(1, "right"), 0, "starts unlearned");

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    // Our own prediction (inset=0 so far) asks for physical X=1717; Mutter's
    // real usable edge is 40px further in, clamping the actual result to 1677.
    assert.equal(renderWin.bounds.x, 1677);
    harness.renderWin.emit("move");
    clock.advance(150); // past RECONCILE_QUIET_MS

    assert.equal(
      harness.runtime.getObservedClampInset(1, "right"),
      0,
      "A-3: the first observation is only a pending candidate, not yet committed"
    );

    // A second write reproduces the IDENTICAL candidate (the mock's
    // rightInset:40 behavior hasn't changed) -- this is the confirming
    // observation that actually commits the learn.
    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    }, { force: true });
    harness.renderWin.emit("move");
    clock.advance(150);

    assert.equal(
      harness.runtime.getObservedClampInset(1, "right"),
      40,
      "deriveClampObservation must derive the inset from actual by subtraction, not require a pre-existing non-zero inset to compare against — confirmed here by the SECOND consistent observation actually committing it"
    );
  });

  it("uses the learned inset to predict correctly next time, without a second predicted-then-measured jump", () => {
    const clock = createFakeClock();
    const renderWin = makeInsetMutterClampedWindow(
      { x: 0, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { rightInset: 40 }
    );
    const harness = create690Fixture({ renderWin, clock });
    wireNativeGeometryListeners(harness);

    // A-3: two consistent observations to actually commit the learned inset
    // (see the self-bootstrap test above).
    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    harness.renderWin.emit("move");
    clock.advance(150);
    assert.equal(harness.runtime.getObservedClampInset(1, "right"), 0, "still pending after one observation");

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    }, { force: true });
    harness.renderWin.emit("move");
    clock.advance(150);
    assert.equal(harness.runtime.getObservedClampInset(1, "right"), 40);

    const offsetXSendsBefore = harness.calls.filter(
      (c) => c[0] === "sendToRenderer" && c[1] === "viewport-offset-x"
    ).length;

    // Re-apply the SAME logical target (force:true just to make the native
    // request observable even though the physical rect won't change this
    // time): the prediction must already use the learned inset.
    harness.runtime.applyPetWindowBounds(
      { x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );
    const lastSetBounds = renderWin.calls.filter((c) => c[0] === "setBounds").pop();
    assert.equal(
      lastSetBounds[1].x, 1677,
      "the request itself must already be the clamp-aware prediction, not the naive pre-learning 1717"
    );
    assert.equal(harness.runtime.getViewportOffsetX(), 91, "offset must already be correct (1768-1677), no predict-then-jump");

    harness.renderWin.emit("move");
    clock.advance(150);

    const offsetXSendsAfter = harness.calls.filter(
      (c) => c[0] === "sendToRenderer" && c[1] === "viewport-offset-x"
    ).length;
    assert.equal(
      offsetXSendsAfter, offsetXSendsBefore,
      "no additional viewport-offset-x IPC once the prediction already matches actual"
    );
  });

  it("does not pollute the learned inset from size changes, two-axis moves, or non-edge single-axis moves", () => {
    // PR #751 rework batch A-5: each sub-case below used to advance the fake
    // clock by only 10ms — well under RECONCILE_QUIET_MS(100) — so
    // runReconcile() was NEVER actually invoked and the "must not be
    // learned" assertions passed vacuously (nothing ran that could have
    // learned anything). Advancing past RECONCILE_QUIET_MS makes each
    // sub-case genuinely exercise deriveClampObservation()'s rejection of
    // that shape. Post rework batch A-1, a non-clamp-explainable mismatch
    // discovered here is DEFERRED (not adopted) since it's still inside the
    // write's own settle window — either way (deferred or, if settle had
    // expired, rebased) maybeLearnInset() is never reached for a null
    // clampObs, so the assertion stays meaningful regardless of which of the
    // two non-adopt paths handles it.
    const clock = createFakeClock();
    const harness = create690Fixture({ clock });
    wireNativeGeometryListeners(harness);

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });

    // (a) size change
    harness.renderWin.bounds = { x: 1717, y: 721, width: 150, height: 209 };
    harness.renderWin.emit("move");
    clock.advance(150); // past RECONCILE_QUIET_MS -- runReconcile() actually runs
    assert.equal(harness.runtime.getObservedClampInset(1, "right"), 0, "size change must not be learned as an inset");

    // Re-establish a clean write for the next sub-case.
    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    }, { force: true });

    // (b) two-axis move (both x and y differ)
    harness.renderWin.bounds = { x: 1700, y: 700, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height };
    harness.renderWin.emit("move");
    clock.advance(150);
    assert.equal(harness.runtime.getObservedClampInset(1, "right"), 0, "a two-axis move must not be learned as an inset");

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    }, { force: true });

    // (c) single-axis but nowhere near an edge. Note this write's own
    // `expected` (1717) already sits exactly ON the workArea's raw right
    // boundary (1920) — deriveClampObservation()'s "expected genuinely
    // reached the boundary" check is therefore satisfied for ANY x-only
    // mismatch here, however large; a merely-small nudge (e.g. 1710, 7px in)
    // would actually still classify as clamp-explainable with an inferred
    // inset of 7 (a real, if surprising, consequence of the single-axis-at-
    // edge heuristic, not a bug this test is about). What genuinely gets
    // rejected is an inset that would exceed the window's own width
    // (deriveClampObservation's inset > expected.width check) — 1400 is far
    // enough in that the implied inset (317) blows past that ceiling.
    harness.renderWin.bounds = { x: 1400, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height };
    harness.renderWin.emit("move");
    clock.advance(150);
    assert.equal(
      harness.runtime.getObservedClampInset(1, "right"), 0,
      "single-axis but not touching the clamp boundary must not be learned as an inset"
    );
  });

  it("relearns the inset when the WM's real clamp boundary drifts, and logs inset-drift", () => {
    const clock = createFakeClock();
    const insetState = { value: 40 };
    const renderWin = makeWindow({
      x: 0, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    renderWin.setBounds = (next) => {
      renderWin.calls.push(["setBounds", next]);
      const maxX = ISSUE_690_WORK_AREA.width - insetState.value - next.width;
      renderWin.bounds = { ...next, x: next.x > maxX ? maxX : next.x };
    };
    const edgeLogs = [];
    const harness = create690Fixture({ renderWin, clock, edgeLog: (m) => edgeLogs.push(m) });
    wireNativeGeometryListeners(harness);

    // A-3: two consistent observations to commit the initial learn.
    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    harness.renderWin.emit("move");
    clock.advance(150);
    assert.equal(harness.runtime.getObservedClampInset(1, "right"), 0, "still pending after one observation");

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    }, { force: true });
    harness.renderWin.emit("move");
    clock.advance(150);
    assert.equal(harness.runtime.getObservedClampInset(1, "right"), 40);

    insetState.value = 60; // the WM's real usable edge moves further in
    // A-3: the drift is a NEW candidate (60 != the just-committed 40), so it
    // ALSO needs two consistent observations before it overwrites the
    // learned table — the first only overwrites the (now-cleared) pending
    // slot with 60, still reading back the stale 40.
    harness.runtime.applyPetWindowBounds(
      { x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );
    harness.renderWin.emit("move");
    clock.advance(150);
    assert.equal(harness.runtime.getObservedClampInset(1, "right"), 40, "still the old learned value after only one drift observation");

    harness.runtime.applyPetWindowBounds(
      { x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );
    harness.renderWin.emit("move");
    clock.advance(150);

    assert.equal(harness.runtime.getObservedClampInset(1, "right"), 60);
    assert.ok(
      edgeLogs.some((line) => line.includes("inset-drift") && line.includes("old=40") && line.includes("new=60")),
      "a changed inset must log inset-drift with both the old and new values"
    );
  });

  it("classifies a clamp that lands after SETTLE_MS as adopt-clamp, not rebase (no ratcheting)", () => {
    const clock = createFakeClock();
    const renderWin = makeInsetMutterClampedWindow(
      { x: 0, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { rightInset: 40 }
    );
    const harness = create690Fixture({ renderWin, clock });
    wireNativeGeometryListeners(harness);

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    // No native event at all during the settle window -- advance PAST
    // SETTLE_MS + a margin before the WM's clamp geometry is observed. The
    // settle-sweep fires first (at t=400) and finds actual != expected with
    // no event either -- itself an adopt-clamp ("reason=no-event"). Then a
    // LATE move event arrives even later; it must still classify as
    // adopt-clamp (deriveClampObservation is time-independent), not rebase.
    clock.advance(300); // t=300, still < SETTLE_MS -- nothing fires yet
    harness.renderWin.emit("move"); // the mock already clamped bounds synchronously at write time
    clock.advance(300); // t=600, past both RECONCILE_QUIET_MS and SETTLE_MS

    assert.equal(
      harness.runtime.getPetWindowBounds().x,
      1768,
      "a late but clamp-explainable mismatch must stay adopt-clamp: lastLogicalBounds must NOT ratchet inward"
    );
  });

  it("does not let a late sweep from an earlier write consume a newer write's settle window", () => {
    const clock = createFakeClock();
    const harness = create690Fixture({ clock });
    wireNativeGeometryListeners(harness);

    // gen1 write at t=0 (settle until t=400, sweep due t=400).
    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    clock.advance(50);
    // gen2 write at t=50 (settle until t=450, sweep due t=450) -- this
    // reschedules the sweep timer, so gen1's sweep callback never actually
    // fires as a SEPARATE timer; the generation guard is what's under test
    // (gen1's stamped generation must not match writeGen by the time
    // anything checks it).
    harness.runtime.applyPetWindowBounds({
      x: 1700, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    }, { force: true });

    // Advance to just past gen1's ORIGINAL sweep due-time (t=400) but before
    // gen2's settle expires (t=450) -- if gen1's generation were wrongly
    // still "live", a stray consumption here would prematurely end gen2's
    // settle. Since scheduleSettleSweep() clears the previous timer on every
    // write, there is no separate gen1 timer left to fire at all.
    clock.advance(360); // now at t=410
    const renderWin = harness.renderWin;
    renderWin.bounds = { x: 1600, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height };
    renderWin.emit("move"); // schedules a quiet-point check due at t=510
    // PR #751 rework batch A-5: corrected timeline comment — t=560 is PAST
    // gen2's settle (t=450), not "still within" it as this comment used to
    // claim. What actually classifies this mismatch is gen2's OWN
    // settle-sweep (armed at t=50, due at t=450) firing BEFORE the t=510
    // quiet-point check the move event just scheduled (450 < 510): no prior
    // quiet-point observation ever flagged this mismatch as "seen and
    // unexplained" (A-1's sawUnexplainedMismatch), so the sweep's own
    // "reason=no-event" fallback adopts it. The later t=510 quiet check then
    // finds actual already matching the just-adopted expected and no-ops.
    clock.advance(150); // t=560

    // The mismatch must be adopted (lastLogicalBounds preserved at gen2's
    // 1700) via the sweep's no-event fallback, never rebased — which is what
    // would happen if gen1's stale generation had wrongly been treated as
    // still live, corrupting gen2's own bookkeeping.
    assert.equal(
      harness.runtime.getPetWindowBounds().x,
      1700,
      "gen2's settle window must not have been prematurely closed by gen1's stale sweep generation"
    );
  });

  // PR #751 rework batch A-5: the test above only proves the generation
  // guard works when the timer mechanism cancels gen1's stale sweep cleanly
  // (scheduleSettleSweep() clears the previous timer on every write) — by
  // its own admission, "there is no separate gen1 timer left to fire at
  // all". This companion test instead captures gen1's ACTUAL sweep callback
  // closure directly (bypassing clock.clearTimeout()'s `cancelled` flag
  // entirely) and invokes it after gen2 has already written, proving
  // runReconcile()'s own `gen === writeGen` check rejects a stale generation
  // even in a hypothetical race where the callback fires anyway — defense in
  // depth beyond "the timer never got the chance to fire".
  it("rejects a stale sweep generation even if its captured callback is invoked directly, bypassing timer cancellation entirely", () => {
    const clock = createFakeClock();
    const capturedFns = [];
    const spyClock = {
      now: clock.now,
      setTimeout: (fn, delay) => {
        capturedFns.push(fn);
        return clock.setTimeout(fn, delay);
      },
      clearTimeout: clock.clearTimeout,
    };
    const harness = create690Fixture({ clock: spyClock });
    wireNativeGeometryListeners(harness);

    // gen1 write at t=0 -- its own applyPetWindowBounds() call schedules
    // exactly one setTimeout (scheduleSettleSweep(), no "move" event emitted
    // yet to also schedule a quiet timer), so capturedFns[0] is unambiguously
    // gen1's settle-sweep closure.
    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    const staleGen1SweepFn = capturedFns[0];
    assert.equal(typeof staleGen1SweepFn, "function", "sanity: captured gen1's sweep closure");

    clock.advance(50);
    // gen2 write -- cancels gen1's sweep via clearTimeoutFn (the fake clock
    // marks it `cancelled`), but staleGen1SweepFn is a direct reference the
    // spy already holds independent of that bookkeeping.
    harness.runtime.applyPetWindowBounds({
      x: 1700, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    }, { force: true });

    // Fire the STALE closure directly -- simulates a race where the
    // callback runs despite having been marked cancelled.
    //
    // Finding while writing this test (worth recording, not papering over):
    // scheduleSettleSweep()'s callback reads `sweepGen` — a variable shared
    // across every scheduling call, not a value frozen into each individual
    // closure — so invoking a "stale" captured closure late does not
    // actually pass a stale generation number into runReconcile(); it reads
    // whatever `sweepGen` currently is (gen2's, by now), which trivially
    // equals writeGen. What actually keeps this call harmless is
    // runReconcile()'s OWN (a) sameRect(actual, expected) check: gen2's
    // physical window already sits exactly where gen2's write left it, so
    // this "stale" invocation is a same-rect no-op regardless of which
    // generation it believes it's checking — not a generation-guard
    // rejection. A genuinely stale cross-generation value (deferredSweepGen
    // surviving a protection period across a newer write) is a materially
    // different mechanism, already covered by the roam-protection tests
    // above (batch 2's "marks reconcile dirty during roam animation and
    // compensates once released").
    staleGen1SweepFn();

    assert.equal(
      harness.runtime.getPetWindowBounds().x, 1700,
      "the stale gen1 sweep callback firing directly must not corrupt gen2's state (a harmless same-rect no-op)"
    );
  });

  it("does not orphan the quiet timer when a settle sweep fires first", () => {
    const clock = createFakeClock();
    const harness = create690Fixture({ clock });
    wireNativeGeometryListeners(harness);

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    // A native move event schedules the RECONCILE_QUIET_MS quiet timer
    // (due t=100) strictly before the SETTLE_MS sweep (due t=400).
    harness.renderWin.emit("move");
    // Advance straight to the sweep's due time; if runReconcile()'s
    // settle-sweep branch unconditionally nulled reconcileTimer (rather than
    // only doing so for reason !== "settle-sweep"), the still-pending quiet
    // timer would become an unreachable orphan with no way to verify it was
    // ever cancellable. Instead, verify no crash/double-fire occurs and the
    // pending-timer bookkeeping in the fake clock itself stays consistent
    // (nothing left pending once both have had their chance to run).
    clock.advance(400);
    assert.equal(clock.pendingCount(), 0, "both the quiet and sweep timers must have resolved without leaving an orphan");
  });

  it("marks reconcile dirty during a drag and compensates with one terminal reconcile on release", () => {
    const clock = createFakeClock();
    const harness = create690Fixture({ clock });
    wireNativeGeometryListeners(harness);

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    clock.advance(500); // let the write's own settle fully expire

    harness.runtime.setDragLocked(true);
    harness.renderWin.bounds = {
      x: 800, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    };
    harness.renderWin.emit("move");
    clock.advance(200); // past RECONCILE_QUIET_MS -- but the drag protection must defer it
    assert.equal(
      harness.runtime.getPetWindowBounds().x, 1768,
      "reconcile must only mark dirty while dragLocked, never run"
    );

    harness.runtime.setDragLocked(false); // -> releaseReconcileProtection() -> scheduleReconcile()
    clock.advance(200);

    assert.equal(
      harness.runtime.getPetWindowBounds().x,
      851, // rebase: actualPhysicalX(800) + oldViewportOffsetX(51)
      "release must trigger exactly one terminal reconcile that correctly classifies the deferred external move as a rebase"
    );
  });

  it("marks reconcile dirty during roam animation and compensates once released", () => {
    // §6.3's exact sequencing: "保护期内 sweep 到期 -> 解除保护但不发起新写入
    // -> 断言 releaseReconcileProtection() 触发了一次静默点 reconcile；随后的
    // 真实外部移动被判为 rebase 而不是 adopt-clamp". roam=false while the
    // write's own settle-sweep resolves cleanly first (mirroring the drag
    // test above) -- roam only turns on AFTER that, so the deferred-sweep
    // generation is never left "live" across an unrelated later trigger.
    let roaming = false;
    const clock = createFakeClock();
    const harness = create690Fixture({ clock, isRoamAnimating: () => roaming });
    wireNativeGeometryListeners(harness);

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    clock.advance(500); // the write's own settle-sweep resolves cleanly (roam not active yet)

    roaming = true;
    harness.renderWin.bounds = {
      x: 800, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    };
    harness.renderWin.emit("move");
    clock.advance(200);
    assert.equal(harness.runtime.getPetWindowBounds().x, 1768, "reconcile must not run while roam is animating");

    roaming = false;
    harness.runtime.releaseReconcileProtection(); // mirrors roam.js's own release-point call
    clock.advance(200);

    assert.equal(
      harness.runtime.getPetWindowBounds().x, 851,
      "release must trigger the deferred reconcile once roam's protection period ends"
    );
  });

  // Issue #690 batch 2 archival (plan §4.3.11): this pins known edge-case
  // behavior, semantics to be revisited with P1-4. It is NOT a fix — the
  // implementation is unchanged from the test directly above; only the
  // *sequencing* differs, and that sequencing difference genuinely changes
  // the outcome.
  //
  // The test above deliberately keeps roam OFF until the write's own settle
  // sweep has already resolved cleanly, so no debt survives into roam's
  // protection period. This test instead has roam ALREADY active when the
  // write's SETTLE_MS sweep comes due: runReconcile("settle-sweep", gen)
  // hits the protection-period branch and records
  // `deferredSweepGen = writeGen` instead of just returning. If ZERO further
  // writes occur before release (no new applyPetWindowBounds() call ever
  // advances writeGen), that debt survives untouched all the way to
  // releaseReconcileProtection() — batch 2's coordinator review independently
  // confirmed this exact "zero new writes in between" precondition is what
  // narrows the trigger window (a single intervening write invalidates the
  // debt via the gen === writeGen check and this scenario no longer
  // reproduces).
  //
  // When a genuinely external move then lands during that same still-
  // protected window and gets picked up once release's debounced quiet-point
  // reconcile finally runs, `fromSettleSweep` is true purely because of the
  // surviving debt — NOT because this particular mismatch is clamp-
  // explainable (deriveClampObservation() correctly returns null: an
  // 817px implied inset flunks its own `inset <= expected.width` sanity
  // check). But the acceptance check is `fromSettleSweep || ... || clampObs
  // !== null` — a bare OR — so the debt alone forces "adopt-clamp"
  // regardless of what deriveClampObservation() concluded, misclassifying a
  // real external move as though it were our own write settling.
  //
  // The visible symptom: adopt-clamp's recomputeOffsetsFrom() then computes
  // an 868px "offset" (logical 1768 vs actual 900), which the separate I2
  // legal-domain backstop rejects (|868| >= width 203) and resets to actual
  // with the offset zeroed — landing at logical X=900. Had this been
  // classified correctly as a rebase instead, the formula would have been
  // `actual.x + the OLD offset (+51)` = 951, preserving the pre-move visual
  // position. 900 vs 951 is a real ~51px discontinuity this edge case can
  // produce, which is exactly why it's flagged for a P1-4 revisit rather
  // than silently left alone — it just isn't this batch's to fix (§4.3.11's
  // A/B branch is still pending real-machine data, and unpicking the bare OR
  // above touches the same shared acceptance check every clamp classification
  // depends on).
  it("pins known edge-case behavior, semantics to be revisited with P1-4 (§4.3.11): a deferred settle-sweep debt surviving untouched into roam's release misclassifies a later external move as adopt-clamp instead of rebase", () => {
    let roaming = true; // roam protection is ALREADY active when the write lands
    const clock = createFakeClock();
    const harness = create690Fixture({ clock, isRoamAnimating: () => roaming });
    wireNativeGeometryListeners(harness);

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    assert.equal(harness.runtime.getViewportOffsetX(), 51, "sanity: the usual 1768/1717 offset before anything moves");

    // The write's own settle sweep (SETTLE_MS=400) becomes due WHILE roam is
    // still protected -- the protection-period branch records
    // deferredSweepGen = writeGen instead of returning outright.
    clock.advance(400);
    assert.equal(harness.runtime.getPetWindowBounds().x, 1768, "still protected: the sweep must not resolve yet");

    // Zero new writes happen here -- writeGen must not advance, or the
    // debt above would no longer match and this scenario would not occur.

    // A genuinely external move (something else moved the render window)
    // arrives while STILL protected -- the protection check runs first, so
    // this also just re-marks reconcileDirty and returns unclassified.
    harness.renderWin.bounds = {
      x: 900, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    };
    harness.renderWin.emit("move");
    clock.advance(50);
    assert.equal(harness.runtime.getPetWindowBounds().x, 1768, "still protected: the external move must not be classified yet");

    roaming = false;
    harness.runtime.releaseReconcileProtection();
    clock.advance(200); // past RECONCILE_QUIET_MS

    // Pinned current actual behavior (not a correctness claim): the debt's
    // fromSettleSweep short-circuits acceptance, adopt-clamp records the
    // external move as if it were our own write, and the resulting
    // out-of-range offset gets reset to actual with offset zeroed.
    assert.equal(
      harness.runtime.getPetWindowBounds().x, 900,
      "pins current behavior: external move during a surviving deferred-sweep debt lands at bare actual (900), not the rebase-preserving 951 (900 + the pre-move +51 offset)"
    );
    assert.equal(harness.runtime.getViewportOffsetX(), 0, "pins current behavior: offset is zeroed by the I2 backstop, not preserved");
  });

  it("bounds hitWin.setBounds calls to at most 2 when the hit window is constantly clamped at a genuine edge, then adopts and records hitGeometryDrift", () => {
    const clock = createFakeClock();
    const edgeLogs = [];
    const hitWin = makeWindow({ x: 1717, y: 721, width: 203, height: 209 });
    // Mutter also fully-onscreen-constrains the hit toolbar independently:
    // whatever right edge we request beyond x=1900 gets clamped back to it,
    // simulating a hit-side inset the render side hasn't learned.
    hitWin.setBounds = (next) => {
      hitWin.calls.push(["setBounds", next]);
      const maxRight = 1900;
      const clampedX = (next.x + next.width > maxRight) ? (maxRight - next.width) : next.x;
      hitWin.bounds = { ...next, x: clampedX };
    };
    const harness = create690Fixture({ hitWin, clock, edgeLog: (m) => edgeLogs.push(m) });
    wireNativeGeometryListeners(harness);

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    harness.runtime.syncHitWin();
    // Requested hit rect's right edge sits at 1920 (outward-clipped to the
    // physical render window's right edge, 1717+203); the mock's hit-only
    // 20px inset immediately clamps it to 1900 on this first write.
    assert.equal(hitWin.calls.filter((c) => c[0] === "setBounds").length, 1);

    hitWin.emit("move");
    clock.advance(300); // first hit reconcile: bounded retry (write #2, same target)

    hitWin.emit("move");
    clock.advance(300); // second hit reconcile: retried target still mismatched -> adopt, no further write

    const setBoundsCalls = hitWin.calls.filter((c) => c[0] === "setBounds").length;
    assert.ok(setBoundsCalls <= 2, `expected <=2 total hitWin.setBounds calls, got ${setBoundsCalls}`);
    assert.ok(
      edgeLogs.some((line) => line.includes("window=hit") && line.includes("action=adopt-clamp") && line.includes("hitDrift=-20,0")),
      "must record hitGeometryDrift once adopted"
    );
  });

  // PR #751 Codex review #6 (rework batch B-3): after adopting a WM-clamped
  // outcome B for a derived target A, re-syncing with the SAME derivation
  // (the pet hasn't moved) used to compare the just-adopted B against the
  // freshly re-derived A, see them differ, and re-initiate a write to A --
  // undoing the adoption and restarting the whole retry/adopt cycle every
  // single syncHitWin() call.
  it("re-syncing with the same derived target after an adopted clamp does not re-initiate a write (no flip-flop)", () => {
    const clock = createFakeClock();
    const hitWin = makeWindow({ x: 1717, y: 721, width: 203, height: 209 });
    hitWin.setBounds = (next) => {
      hitWin.calls.push(["setBounds", next]);
      const maxRight = 1900;
      const clampedX = (next.x + next.width > maxRight) ? (maxRight - next.width) : next.x;
      hitWin.bounds = { ...next, x: clampedX };
    };
    const harness = create690Fixture({ hitWin, clock });
    wireNativeGeometryListeners(harness);

    harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    harness.runtime.syncHitWin(); // write #1: derived target, clamped by the mock

    hitWin.emit("move");
    clock.advance(300); // bounded retry: write #2, same target
    hitWin.emit("move");
    clock.advance(300); // adopts the clamped outcome -- no further write

    const setBoundsCallsAfterAdopt = hitWin.calls.filter((c) => c[0] === "setBounds").length;
    assert.equal(setBoundsCallsAfterAdopt, 2, "sanity: adoption happened after exactly the bounded retry");

    // The pet hasn't moved -- syncHitWin() re-derives the exact same target
    // every time (the render window's own bounds are unchanged).
    harness.runtime.syncHitWin();
    harness.runtime.syncHitWin();
    harness.runtime.syncHitWin();

    const setBoundsCallsAfterResync = hitWin.calls.filter((c) => c[0] === "setBounds").length;
    assert.equal(
      setBoundsCallsAfterResync, setBoundsCallsAfterAdopt,
      "re-syncing with the same derived target must not re-initiate any new write"
    );
  });

  it("escape hatch keeps X offset at 0 and skips X IPC, but keeps expected-write/reconcile accounting active", () => {
    const clock = createFakeClock();
    const renderWin = makeWindow({
      x: 0, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    const harness = createRuntime({
      isLinux: true,
      renderWin,
      clock,
      displays: [{ id: 1, bounds: ISSUE_690_WORK_AREA, workArea: ISSUE_690_WORK_AREA }],
      isEdgeVirtualizationDisabled: () => true,
    });
    wireNativeGeometryListeners(harness);

    const result = harness.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });

    assert.equal(result.x, 1768, "materialize must not clamp X while the escape hatch is engaged -- back to physical overflow");
    assert.equal(harness.runtime.getViewportOffsetX(), 0);
    assert.ok(
      !harness.calls.some((c) => c[0] === "sendToRenderer" && c[1] === "viewport-offset-x"),
      "no viewport-offset-x IPC while the escape hatch is engaged"
    );

    // Reconcile itself must still be active: an external move well past the
    // write's settle window still gets rebased -- X offset simply stays 0
    // throughout, since the hatch keeps recomputeOffsetsFrom() from ever
    // producing a non-zero X. This is expected-write/reconcile accounting
    // continuing to work, not the whole mechanism being switched off.
    clock.advance(500);
    harness.renderWin.bounds = {
      x: 900, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    };
    harness.renderWin.emit("move");
    clock.advance(200);

    assert.equal(
      harness.runtime.getPetWindowBounds().x, 900,
      "reconcile must still rebase; only X virtualization itself is disabled"
    );
    assert.equal(harness.runtime.getViewportOffsetX(), 0, "X offset must stay 0 throughout, even while reconcile is actively rebasing");
  });

  it("I2's offset legal-domain backstop also fires from runReconcile()'s adopt-clamp branch (§12.18)", () => {
    // §12.18 asks whether the backstop fires at EVERY offset write point,
    // not just applyPetWindowBounds()'s own materialize result. This is a
    // second, independent write point: runReconcile()'s adopt-clamp branch
    // calls recomputeOffsetsFrom() directly from a genuinely reconciled
    // (lastLogicalBounds, actual) pair, which is not guaranteed to be legal
    // just because materialize's own guard already passed once earlier.
    //
    // PR #751 rework batch A-1 note: this scenario must be genuinely
    // clamp-explainable now, not just "any mismatch within settle" — a
    // non-explainable mismatch within settle is now DEFERRED (Codex #1), not
    // adopted, so it would never reach the adopt-clamp branch this test
    // exists to exercise. The 1000-wide default workArea's right edge is the
    // boundary: write x=950 (width=100, legal offset 50 — right edge sits
    // exactly at the workArea boundary, satisfying deriveClampObservation's
    // "genuinely reached the boundary it was clamped against" check), then a
    // late-discovered clamp lands actual at x=800 — single-axis, inset=100
    // relative to THIS write's own snapshot (1000-(800+100)=100), right at
    // deriveClampObservation's own inset<=width legality ceiling, so it's
    // still classified as clamp-explainable. Recomputing the offset from the
    // ORIGINAL logical intent (950) against this actual (800) gives 150 —
    // clearly illegal (>= width) — which is exactly the case the backstop
    // must catch from INSIDE the adopt-clamp branch, not materialize's own.
    const clock = createFakeClock();
    const edgeLogs = [];
    const harness = createRuntime({ isLinux: true, clock, edgeLog: (m) => edgeLogs.push(m) });
    wireNativeGeometryListeners(harness);

    harness.runtime.applyPetWindowBounds({ x: 950, y: 20, width: 100, height: 100 });
    assert.equal(harness.runtime.getViewportOffsetX(), 50, "sanity: the original write itself must still be legal");

    harness.renderWin.bounds = { x: 800, y: 20, width: 100, height: 100 };
    harness.renderWin.emit("move");
    clock.advance(150);

    assert.ok(
      edgeLogs.some((line) => line.includes("edge-offset-out-of-range")),
      "the backstop must fire from the adopt-clamp branch too, not just materialize's own result"
    );
    assert.equal(harness.runtime.getViewportOffsetX(), 0);
    const bounds = harness.runtime.getPetWindowBounds();
    assert.equal(bounds.x, 800, "lastLogicalBounds must hard-resync to actual, not stay at the polluted original logical value");
    assert.equal(bounds.y, 20);
  });

  // PR #751 Codex deep review — rework batch A. Each test below reproduces
  // the reviewer's own exact counter-example timeline; coordinator-verified
  // independently before assigning the fix.
  describe("PR #751 rework batch A: reconcile classification, write-time snapshots, inset confirmation, eligibility gating", () => {
    it("Codex #1: an unexplainable mismatch inside settle DEFERS instead of adopting, then rebases once settle expires", () => {
      // t0 write (500,20). t20 external move to (550,30) — two-axis, never
      // clamp-explainable. t120 quiet point: still well within SETTLE_MS(400)
      // of the t0 write. Pre-fix this adopted immediately (any mismatch
      // within settle was accepted) and, because adopting resets `expected`
      // to match `actual`, nothing ever rebased afterward even past t400 —
      // there was nothing left to reconcile against. Post-fix: t120 defers
      // (A-1's (b2)); the repeated 100ms re-check chain this arms eventually
      // runs past t400, at which point the independent settle-sweep (armed
      // at t0, due at t400) fires first and rebases, since an earlier quiet
      // point already flagged this exact mismatch as unexplained
      // (sawUnexplainedMismatch) — logical follows actual (550,30) plus the
      // old (zero) offset.
      const clock = createFakeClock();
      const harness = createRuntime({ isLinux: true, clock });
      wireNativeGeometryListeners(harness);

      harness.runtime.applyPetWindowBounds({ x: 500, y: 20, width: 100, height: 100 });
      assert.equal(harness.runtime.getViewportOffsetX(), 0, "sanity: 500 isn't near any clamp boundary");

      clock.advance(20);
      harness.renderWin.bounds = { x: 550, y: 30, width: 100, height: 100 };
      harness.renderWin.emit("move");
      clock.advance(100); // t=120: past RECONCILE_QUIET_MS, well within SETTLE_MS(400)

      assert.equal(
        harness.runtime.getPetWindowBounds().x, 500,
        "must defer, not adopt: logical bounds untouched while still inside settle"
      );
      assert.equal(harness.runtime.getViewportOffsetX(), 0, "offset untouched while deferred");

      clock.advance(300); // t=420: past SETTLE_MS(400) -- the deferred chain must have rebased by now

      const bounds = harness.runtime.getPetWindowBounds();
      assert.equal(bounds.x, 550, "once settle expires, the deferred mismatch rebases: logical follows actual(550) + old offset(0)");
      assert.equal(bounds.y, 30, "Y follows the same rebase");
    });

    it("Codex #2: a write-time clamp-eligibility snapshot survives clearObservedClampInsets() landing before the late actual arrives", () => {
      // Write x=1768 while inset=40 is already learned -- the prediction
      // basis (THIS write's OWN snapshot) clamps to physical X=1677
      // (1920-40-203), recorded as expectedWrite.clampBounds.rightBound=1880.
      // clearObservedClampInsets() then wipes the CURRENT table (simulating a
      // display-metrics-changed event landing in between) down to inset=0.
      // Advance PAST this write's own SETTLE_MS so the classification hinges
      // purely on clamp-explainability, not the settle-window grace period
      // (which would otherwise mask the bug either way). THEN a late actual
      // arrives reflecting the WM's TRUE inset having ALSO independently
      // drifted to 60 (1920-60-203=1657) — unrelated to our table being
      // cleared, just a coincidentally-timed second change. Pre-fix,
      // runReconcile() recomputed the comparison boundary FRESH via
      // resolveClampAwareBounds(wa) at reconcile time, which now (post-clear)
      // reads inset=0 -> effectiveRight=1920 -- and 1677+203=1880 < 1920, so
      // deriveClampObservation() wrongly returns null (not explainable),
      // misclassifying this genuinely-clamped write as an external move and
      // ratcheting logical inward via rebase: actual(1657) + the original
      // write's own offset(91) = 1748. Post-fix: the snapshot's OWN
      // clampBounds (1880, frozen at write time) is used instead, so
      // 1677+203=1880 < 1880 is false -- still classified as adopt-clamp,
      // keeping logical at 1768 (only the offset absorbs the new 111px gap).
      const clock = createFakeClock();
      const renderWin = makeInsetMutterClampedWindow(
        { x: 0, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
        { rightInset: 40 }
      );
      const harness = create690Fixture({ renderWin, clock });
      wireNativeGeometryListeners(harness);

      // Learn inset=40 first (two consistent observations, A-3).
      harness.runtime.applyPetWindowBounds({
        x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
      });
      harness.renderWin.emit("move");
      clock.advance(150);
      harness.runtime.applyPetWindowBounds({
        x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
      }, { force: true });
      harness.renderWin.emit("move");
      clock.advance(150);
      assert.equal(harness.runtime.getObservedClampInset(1, "right"), 40, "sanity: inset learned before the scenario starts");

      // The write whose OWN snapshot must survive the clear below.
      harness.runtime.applyPetWindowBounds(
        { x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
        { force: true }
      );
      assert.equal(renderWin.bounds.x, 1677, "prediction basis: clamped using the learned inset=40");
      assert.equal(harness.runtime.getViewportOffsetX(), 91, "sanity: 1768-1677");

      harness.runtime.clearObservedClampInsets();
      assert.equal(harness.runtime.getObservedClampInset(1, "right"), 0, "table cleared -- but the write above already froze its own snapshot");

      clock.advance(450); // past this write's own SETTLE_MS(400) -- no generous accept left to mask the bug

      // Late actual: the WM's TRUE usable edge independently drifted to
      // inset=60 (not the mock's original 40) -- 1920-60-203=1657.
      harness.renderWin.bounds = { x: 1657, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height };
      harness.renderWin.emit("move");
      clock.advance(150);

      assert.equal(
        harness.runtime.getPetWindowBounds().x, 1768,
        "must stay adopt-clamp via the write's OWN snapshot boundary (1880): logical stays at 1768, not ratcheted to the rebase value 1748 (actual 1657 + old offset 91)"
      );
    });

    it("Codex #3: a single external one-off mismatch never overwrites the learned inset — needs a second CONSISTENT observation, exactly like initial learning", () => {
      // Inset=40 already learned. An external move (not a self-write) shifts
      // actual from 1677 to 1657 -- single-axis, sitting exactly at the
      // boundary the write's own snapshot used, so it's still classified as
      // clamp-explainable with a candidate inset of 60. Pre-fix (no pending-
      // candidate gate), this ONE observation alone would have been written
      // straight to the learned table and never correctable back. Post-fix:
      // it only becomes a pending candidate (still != the just-committed 40,
      // so it does not confirm anything) -- the learned table stays at 40.
      const clock = createFakeClock();
      const renderWin = makeInsetMutterClampedWindow(
        { x: 0, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
        { rightInset: 40 }
      );
      const harness = create690Fixture({ renderWin, clock });
      wireNativeGeometryListeners(harness);

      harness.runtime.applyPetWindowBounds({
        x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
      });
      harness.renderWin.emit("move");
      clock.advance(150);
      harness.runtime.applyPetWindowBounds({
        x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
      }, { force: true });
      harness.renderWin.emit("move");
      clock.advance(150);
      assert.equal(harness.runtime.getObservedClampInset(1, "right"), 40, "sanity: inset learned before the scenario starts");

      // A one-off external move -- NOT a new write, no new expectedWrite
      // snapshot; the LAST write's snapshot (boundary 1880) is still current.
      harness.renderWin.bounds = { x: 1657, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height };
      harness.renderWin.emit("move");
      clock.advance(150);

      assert.equal(
        harness.runtime.getObservedClampInset(1, "right"), 40,
        "a single external one-off observation must not overwrite the already-learned inset"
      );
    });

    it("A-4 Windows context: a move/resize mismatch always rebases — adopt-clamp never applies off Linux", () => {
      const clock = createFakeClock();
      const harness = createRuntime({ isWin: true, isLinux: false, clock });
      wireNativeGeometryListeners(harness);

      harness.runtime.applyPetWindowBounds({ x: 200, y: 100, width: 100, height: 100 });
      assert.equal(harness.runtime.getViewportOffsetX(), 0, "X offset is always 0 off Linux");

      // A single-axis move that WOULD have been clamp-explainable on Linux
      // (sitting exactly at this fixture's default 1000-wide workArea's
      // right edge) must still just rebase on Windows -- adopt-clamp is not
      // a concept here at all (A-4: xEligible is always false off Linux).
      harness.renderWin.bounds = { x: 900, y: 100, width: 100, height: 100 };
      harness.renderWin.emit("move");
      clock.advance(150);

      const bounds = harness.runtime.getPetWindowBounds();
      assert.equal(bounds.x, 900, "logical must follow actual directly -- physical is truth off Linux");
      assert.equal(bounds.y, 100);
      assert.equal(harness.runtime.getViewportOffsetX(), 0, "X offset stays 0 throughout");
      assert.ok(
        harness.calls.some((c) => c[0] === "repositionAnchoredSurfaces" || c[0] === "syncHitWin"),
        "syncDerivedSurfaces must still run on the Windows rebase path"
      );
    });
  });
});

describe("pet-window-runtime", () => {
  it("keeps context menu owner creation outside the pet runtime and preserves parent ownership", () => {
    const runtimeSource = fs.readFileSync(path.join(SRC_DIR, "pet-window-runtime.js"), "utf8");
    const menuSource = fs.readFileSync(path.join(SRC_DIR, "menu.js"), "utf8");

    assert.ok(!runtimeSource.includes("contextMenuOwner"));
    assert.match(menuSource, /parent:\s*ctx\.win/);
  });

  it("lazy-binds topmost edge helpers so main can initialize the pet runtime first", () => {
    const mainSource = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");
    const start = mainSource.indexOf("const petWindowRuntime = createPetWindowRuntime({");
    const end = mainSource.indexOf("\n});", start);
    const petRuntimeOptions = mainSource.slice(start, end);

    assert.ok(start >= 0 && end > start);
    assert.match(petRuntimeOptions, /isNearWorkAreaEdge:\s*\(bounds\)\s*=>\s*isNearWorkAreaEdge\(bounds\)/);
    assert.doesNotMatch(petRuntimeOptions, /[,{]\s*isNearWorkAreaEdge\s*,/);
  });

  it("creates the hit window with the Windows drag focusability contract", () => {
    const instances = [];
    const harness = createRuntime();
    harness.runtime.createHitWindow({
      BrowserWindow: makeBrowserWindow(instances),
      preloadPath: "preload-hit.js",
      loadFilePath: "hit.html",
      hitThemeConfig: { ok: true },
      guardAlwaysOnTop: (win) => harness.calls.push(["guard", win]),
    });

    assert.equal(instances[0].options.focusable, true);
    assert.deepStrictEqual(instances[0].calls.filter((call) => call[0] === "setIgnoreMouseEvents"), [
      ["setIgnoreMouseEvents", false],
    ]);
    assert.deepStrictEqual(instances[0].calls.find((call) => call[0] === "setAlwaysOnTop"), [
      "setAlwaysOnTop",
      true,
      "pop-up-menu",
    ]);
  });

  it("reloadWindowWebContents ignores destroyed windows and webContents", () => {
    const harness = createRuntime();
    const live = makeWindow();
    const destroyedWindow = makeWindow();
    const destroyedContents = makeWindow();

    destroyedWindow.destroyed = true;
    destroyedContents.webContents.destroyed = true;

    assert.equal(harness.runtime.reloadWindowWebContents(live), true);
    assert.equal(harness.runtime.reloadWindowWebContents(destroyedWindow), false);
    assert.equal(harness.runtime.reloadWindowWebContents(destroyedContents), false);
    assert.deepStrictEqual(live.calls, [["reload"]]);
    assert.deepStrictEqual(destroyedWindow.calls, []);
    assert.deepStrictEqual(destroyedContents.calls, []);
  });

  it("does not reload renderer windows for terminal render-process-gone reasons", () => {
    const logs = [];
    const harness = createRuntime({ crashReloadLog: (message) => logs.push(message) });
    const live = makeWindow();

    assert.equal(harness.runtime.reloadWindowWebContents(live, {
      crashKey: "renderWin",
      details: { reason: "integrity-failure" },
    }), false);
    assert.deepStrictEqual(live.calls, []);
    assert.match(logs[0], /not reloading renderWin/);
  });

  it("stops reloading renderer windows after repeated crashes in the guard window", () => {
    let now = 1000;
    const logs = [];
    const harness = createRuntime({
      crashReloadLimit: 2,
      crashReloadWindowMs: 1000,
      crashReloadLog: (message) => logs.push(message),
      now: () => now,
    });
    const live = makeWindow();
    const options = { crashKey: "hitWin", details: { reason: "crashed" } };

    assert.equal(harness.runtime.reloadWindowWebContents(live, options), true);
    now += 100;
    assert.equal(harness.runtime.reloadWindowWebContents(live, options), true);
    now += 100;
    assert.equal(harness.runtime.reloadWindowWebContents(live, options), false);
    assert.deepStrictEqual(live.calls, [["reload"], ["reload"]]);
    assert.match(logs[0], /stopped reloading hitWin/);

    now += 1001;
    assert.equal(harness.runtime.reloadWindowWebContents(live, options), true);
    assert.deepStrictEqual(live.calls, [["reload"], ["reload"], ["reload"]]);
  });

  it("uses safe reload helpers for pet render-process-gone handlers", () => {
    const runtimeSource = fs.readFileSync(path.join(SRC_DIR, "pet-window-runtime.js"), "utf8");
    const mainSource = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");

    assert.ok(runtimeSource.includes('reloadRuntimeWindowWebContents(hitWin, { crashKey: "hitWin", details });'));
    assert.ok(mainSource.includes('petWindowRuntime.reloadWindowWebContents(ownedHitWin, { crashKey: "hitWin", details });'));
    assert.ok(mainSource.includes('petWindowRuntime.reloadWindowWebContents(win, { crashKey: "renderWin", details });'));
    assert.doesNotMatch(mainSource, /ownedHitWin\.webContents\.reload\(\)/);
  });

  it("wires the first-rendered-visual signal to the non-relocating visibility recovery", () => {
    const mainSource = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");
    const preloadSource = fs.readFileSync(path.join(SRC_DIR, "preload.js"), "utf8");
    const rendererSource = fs.readFileSync(path.join(SRC_DIR, "renderer.js"), "utf8");

    assert.match(preloadSource, /notifyPetVisualReady:\s*\(\)\s*=>\s*ipcRenderer\.send\("pet-visual-ready"\)/);
    assert.match(rendererSource, /notifyPetVisualReadyOnce\(\);/);
    assert.match(mainSource, /recoverVisiblePetAfterRendererLoad:\s*\(event\)\s*=>\s*\{/);
    assert.match(mainSource, /petWindowRuntime\.recoverVisiblePetAfterRendererLoad\(\);/);
  });

  it("creates the render window as non-focusable and materializes the initial virtual bounds", () => {
    const instances = [];
    const harness = createRuntime();

    harness.runtime.createRenderWindow({
      BrowserWindow: makeBrowserWindow(instances),
      size: { width: 120, height: 120 },
      initialWindowBounds: { x: 40, y: 0, width: 120, height: 120 },
      initialVirtualBounds: { x: 40, y: -25, width: 120, height: 120 },
      preloadPath: "preload.js",
      loadFilePath: "index.html",
      themeConfig: { ok: true },
      setRenderWindow: harness.setRenderWin,
      isQuitting: () => false,
    });

    assert.deepStrictEqual(instances[0].calls.filter((call) => call[0] === "setFocusable"), [
      ["setFocusable", false],
    ]);
    assert.deepStrictEqual(instances[0].calls.find((call) => call[0] === "setAlwaysOnTop"), [
      "setAlwaysOnTop",
      true,
      "pop-up-menu",
    ]);
    assert.deepStrictEqual(instances[0].calls.find((call) => call[0] === "setBounds"), [
      "setBounds",
      { x: 40, y: 0, width: 120, height: 120 },
    ]);
    assert.equal(harness.runtime.getViewportOffsetY(), 25);
  });

  it("flushes runtime prefs once during Windows session end", () => {
    const instances = [];
    const harness = createRuntime();

    harness.runtime.createRenderWindow({
      BrowserWindow: makeBrowserWindow(instances),
      size: { width: 120, height: 120 },
      initialWindowBounds: { x: 40, y: 0, width: 120, height: 120 },
      initialVirtualBounds: { x: 40, y: 0, width: 120, height: 120 },
      preloadPath: "preload.js",
      loadFilePath: "index.html",
      themeConfig: { ok: true },
      setRenderWindow: harness.setRenderWin,
      isQuitting: () => false,
    });

    instances[0].emit("query-session-end");
    instances[0].emit("session-end");

    assert.deepStrictEqual(harness.calls.filter((call) => call[0] === "flushRuntimeStateToPrefs"), [
      ["flushRuntimeStateToPrefs"],
    ]);
  });

  it("does not flush runtime prefs for session-end events on non-Windows platforms", () => {
    const instances = [];
    const harness = createRuntime({ isWin: false });

    harness.runtime.createRenderWindow({
      BrowserWindow: makeBrowserWindow(instances),
      size: { width: 120, height: 120 },
      initialWindowBounds: { x: 40, y: 0, width: 120, height: 120 },
      initialVirtualBounds: { x: 40, y: 0, width: 120, height: 120 },
      preloadPath: "preload.js",
      loadFilePath: "index.html",
      themeConfig: { ok: true },
      setRenderWindow: harness.setRenderWin,
      isQuitting: () => false,
    });

    instances[0].emit("query-session-end");
    instances[0].emit("session-end");

    assert.deepStrictEqual(harness.calls.filter((call) => call[0] === "flushRuntimeStateToPrefs"), []);
  });

  it("keeps Linux hit windows non-focusable", () => {
    const instances = [];
    const harness = createRuntime({ isWin: false, isLinux: true });

    harness.runtime.createHitWindow({
      BrowserWindow: makeBrowserWindow(instances),
      preloadPath: "preload-hit.js",
      loadFilePath: "hit.html",
      hitThemeConfig: {},
    });

    assert.equal(instances[0].options.focusable, false);
    assert.equal(instances[0].options.type, "toolbar");
  });

  it("materializes virtual bounds into viewport offset and syncs the hit shape once per size", () => {
    const harness = createRuntime();

    assert.deepStrictEqual(
      harness.runtime.applyPetWindowBounds({ x: 40, y: -25, width: 120, height: 120 }),
      { x: 40, y: 0, width: 120, height: 120 }
    );
    assert.equal(harness.runtime.getViewportOffsetY(), 25);
    harness.runtime.syncHitWin();
    harness.runtime.syncHitWin();

    assert.deepStrictEqual(harness.calls, [
      ["sendToRenderer", "viewport-offset", 25],
      ["repositionSessionHud"],
      ["repositionSessionHud"],
      ["repositionSessionHud"],
    ]);
    // I5's outward clip trims the hit rect's top to the physical window's top
    // (0) since viewportOffsetY=25 lifted the logical rect 25px above it —
    // the top 25px (logical y=-25..0) isn't actually visible. Height is
    // therefore 120-25=95, not the untrimmed 120: this fixture has no theme
    // configured, so getHitRectScreen() falls back to the full logical rect
    // (bounds.y=-25, height=120, i.e. bottom=95), and outward-clipping that
    // against physical.y=0/height=120 yields top=0, bottom=95 unchanged.
    assert.deepStrictEqual(harness.hitWin.calls.filter((call) => call[0] === "setShape"), [
      ["setShape", [{ x: 0, y: 0, width: 120, height: 95 }]],
    ]);
  });

  it("does not move the hit window while drag owns pointer capture", () => {
    const harness = createRuntime();

    harness.runtime.setDragLocked(true);
    harness.runtime.syncHitWin();

    assert.deepStrictEqual(harness.hitWin.calls, []);
  });

  it("I5: recovering from suppressed hit geometry must not re-enable input while petHidden is separately true", () => {
    // §6.3: "petHidden 时恢复几何不能擅自重新启用 hit input" -- degenerate
    // geometry (a menu mini-entry preload stage, say) can recover to a valid
    // rect while the pet is ALSO intentionally hidden for an unrelated
    // reason; applyHitInputState()'s OR-composition must keep the window
    // non-interactive either way.
    // No theme is configured, so getHitRectScreen() falls back to the full
    // window rect (getFullHitRect) -- a 5px-wide window is therefore
    // directly degenerate (< HIT_MIN_PX), no hitBox override needed.
    const renderWin = makeWindow({ x: 0, y: 0, width: 5, height: 100 });
    const harness = createRuntime({ renderWin });

    harness.runtime.setPetHidden(true);
    assert.ok(
      harness.hitWin.calls.some((c) => c[0] === "setIgnoreMouseEvents" && c[1] === true),
      "hiding the pet must ignore hit input"
    );

    // Sync while ALSO degenerate -- petHidden already forces ignore=true, so
    // this doesn't change the applied cache (no assertion needed here; it's
    // the RECOVERY step below that exercises the invariant).
    harness.runtime.syncHitWin();

    // Recover to a valid-sized window while STILL petHidden.
    renderWin.bounds = { x: 0, y: 0, width: 100, height: 100 };
    harness.hitWin.calls.length = 0;
    harness.runtime.syncHitWin();

    assert.ok(
      !harness.hitWin.calls.some((c) => c[0] === "setIgnoreMouseEvents" && c[1] === false),
      "recovering valid geometry must not flip input back on while petHidden is still true"
    );
  });

  it("re-answers the editing overlap after each hit geometry sync (#640)", () => {
    const dodgeSyncs = [];
    const harness = createRuntime({ syncImeEditingPetDodge: () => dodgeSyncs.push(true) });

    harness.runtime.syncHitWin();
    assert.strictEqual(dodgeSyncs.length, 1,
      "hitbox changes without a window move (state switch, theme reload) must re-run the dodge");

    harness.runtime.setDragLocked(true);
    harness.runtime.syncHitWin();
    assert.strictEqual(dodgeSyncs.length, 1,
      "the drag-locked early-return precedes the hook; drag unlock re-runs it via pet-interaction-ipc");
  });

  it("clips the hit window to a right-side internal monitor seam", () => {
    const renderWin = makeWindow({ x: 40, y: 0, width: 120, height: 120 });
    const harness = createRuntime({
      renderWin,
      miniMode: true,
      miniContainedSeam: { boundary: 100, edge: "right" },
    });

    harness.runtime.syncHitWin();

    // Full hit rect [40,160) clipped at the seam → keep the local half [40,100).
    assert.deepStrictEqual(
      harness.hitWin.calls.find((call) => call[0] === "setBounds"),
      ["setBounds", { x: 40, y: 0, width: 60, height: 120 }]
    );
  });

  it("clips the hit window from the left at a left-side internal seam", () => {
    const renderWin = makeWindow({ x: 40, y: 0, width: 120, height: 120 });
    const harness = createRuntime({
      renderWin,
      miniMode: true,
      miniContainedSeam: { boundary: 100, edge: "left" },
    });

    harness.runtime.syncHitWin();

    // Full hit rect [40,160) clipped at the seam → keep the local half [100,160).
    assert.deepStrictEqual(
      harness.hitWin.calls.find((call) => call[0] === "setBounds"),
      ["setBounds", { x: 100, y: 0, width: 60, height: 120 }]
    );
  });

  it("leaves the hit window unclipped when no internal seam is active", () => {
    const renderWin = makeWindow({ x: 40, y: 0, width: 120, height: 120 });
    const harness = createRuntime({ renderWin, miniMode: true });

    harness.runtime.syncHitWin();

    assert.deepStrictEqual(
      harness.hitWin.calls.find((call) => call[0] === "setBounds"),
      ["setBounds", { x: 40, y: 0, width: 120, height: 120 }]
    );
  });

  it("returns the seam-clipped hit rect to hover and bubble callers", () => {
    const harness = createRuntime({
      miniMode: true,
      miniContainedSeam: { boundary: 100, edge: "right" },
    });

    assert.deepStrictEqual(
      harness.runtime.getHitRectScreen({ x: 40, y: 0, width: 120, height: 120 }),
      { left: 40, top: 0, right: 100, bottom: 120 }
    );
  });

  // PR #751 Codex review #5 (rework batch B-2): intersectHitWithWorkArea()
  // used to clip BOTH sides unconditionally against the raw workArea width,
  // regardless of whether that side was a genuine Linux outer edge or an
  // internal seam. Codex's own dual-display counter-example: two adjacent
  // displays [0,1920) / [1920,3840), a non-mini pet at x=1850 (width 203)
  // straddling the seam at x=1920.
  it("does not clip a hit rect that legitimately spans an internal monitor seam (only the genuine outer edge, if any, gets clipped)", () => {
    const displays = [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
    ];
    const renderWin = makeWindow({ x: 1850, y: 0, width: 203, height: 120 });
    const harness = createRuntime({ isLinux: true, renderWin, displays });

    // Establish expectedWrite's snapshot (createRuntime()'s getNearestWorkArea
    // default always resolves to displays[0]'s workArea regardless of the
    // pet's actual position — display 1's right edge, at x=1920, is where the
    // adjacent display 2 begins, an internal seam, so rightBound must be null).
    harness.runtime.applyPetWindowBounds({ x: 1850, y: 0, width: 203, height: 120 });

    harness.runtime.syncHitWin();

    // Full hit rect [1850,2053) must stay unclipped on the right (seam side)
    // — it legitimately covers part of display 2. getHitRectScreen() with no
    // hitBox override returns the bounds themselves (see the sibling test
    // above), so [1850,2053) is exactly what a correct, unclipped hit rect
    // must be.
    assert.deepStrictEqual(
      harness.hitWin.calls.find((call) => call[0] === "setBounds"),
      ["setBounds", { x: 1850, y: 0, width: 203, height: 120 }]
    );
  });

  // PR #751 Codex review #4c (rework batch B-2): HIT_MIN suppression is
  // itself a consequence of the workArea intersection possibly narrowing a
  // rect down to a sliver — off Linux (or with the escape hatch engaged),
  // that intersection never runs at all, so a narrow rect should be written
  // as-is instead of suppressed, matching pre-#690 behavior exactly.
  it("does not suppress a narrow hit rect off Linux (no workArea intersection to have narrowed it in the first place)", () => {
    const renderWin = makeWindow({ x: 0, y: 0, width: 5, height: 100 });
    const harness = createRuntime({ isWin: true, isLinux: false, renderWin });

    harness.runtime.syncHitWin();

    assert.deepStrictEqual(
      harness.hitWin.calls.find((call) => call[0] === "setBounds"),
      ["setBounds", { x: 0, y: 0, width: 5, height: 100 }],
      "a narrow rect must be written as-is off Linux, not suppressed"
    );
    assert.ok(
      !harness.hitWin.calls.some((c) => c[0] === "setIgnoreMouseEvents" && c[1] === true),
      "no HIT_MIN-driven suppression should have applied"
    );
  });

  it("does not suppress a narrow hit rect when the escape hatch is engaged, even on Linux", () => {
    const renderWin = makeWindow({ x: 0, y: 0, width: 5, height: 100 });
    const harness = createRuntime({ isLinux: true, isEdgeVirtualizationDisabled: () => true, renderWin });

    harness.runtime.syncHitWin();

    assert.deepStrictEqual(
      harness.hitWin.calls.find((call) => call[0] === "setBounds"),
      ["setBounds", { x: 0, y: 0, width: 5, height: 100 }],
      "a narrow rect must be written as-is with the escape hatch engaged, not suppressed"
    );
    assert.ok(
      !harness.hitWin.calls.some((c) => c[0] === "setIgnoreMouseEvents" && c[1] === true),
      "no HIT_MIN-driven suppression should have applied"
    );
  });

  it("reasserts Windows topmost when drag movement lands near a work-area edge", () => {
    let cursor = { x: 100, y: 100 };
    const harness = createRuntime({
      cursor: () => cursor,
      nearEdge: true,
    });

    harness.runtime.setDragLocked(true);
    harness.runtime.beginDragSnapshot();
    cursor = { x: 120, y: 100 };
    harness.runtime.moveWindowForDrag();

    assert.deepStrictEqual(harness.renderWin.calls.filter((call) => call[0] === "setBounds"), [
      ["setBounds", { x: 30, y: 20, width: 100, height: 100 }],
    ]);
    assert.ok(harness.calls.some((call) => call[0] === "reassertWinTopmost"));
    assert.ok(harness.calls.some((call) => call[0] === "repositionAnchoredSurfaces"));
  });

  it("preserves mini transition guards for drag and display changes", () => {
    const harness = createRuntime({ miniTransitioning: true });

    harness.runtime.setDragLocked(true);
    harness.runtime.beginDragSnapshot();
    harness.runtime.moveWindowForDrag();
    harness.runtime.handleDisplayMetricsChanged();
    harness.runtime.handleDisplayRemoved();

    assert.deepStrictEqual(harness.renderWin.calls, []);
    assert.deepStrictEqual(harness.hitWin.calls, []);
    assert.deepStrictEqual(harness.calls, [
      ["reapplyMacVisibility"],
      ["reapplyMacVisibility"],
    ]);
  });

  it("routes mini-mode display changes to mini handlers without writing pet bounds", () => {
    const harness = createRuntime({ miniMode: true });

    harness.runtime.handleDisplayMetricsChanged();
    harness.runtime.handleDisplayRemoved();

    assert.deepStrictEqual(harness.renderWin.calls, []);
    assert.deepStrictEqual(harness.calls, [
      ["reapplyMacVisibility"],
      ["handleMiniDisplayChange"],
      ["reapplyMacVisibility"],
      ["exitMiniMode"],
    ]);
  });

  it("refreshes mini seam state when a display is added", () => {
    const harness = createRuntime({ miniMode: true });

    harness.runtime.handleDisplayAdded();

    assert.deepStrictEqual(harness.renderWin.calls, []);
    assert.deepStrictEqual(harness.calls, [
      ["reapplyMacVisibility"],
      ["handleMiniDisplayChange"],
      ["repositionAnchoredSurfaces"],
    ]);
  });

  it("snaps the pet back to the frozen size when live bounds drift on display-metrics-changed (#408)", () => {
    // Windows sleep/wake can resize the pet without moving it (DPI flux).
    // Even when the clamped position is unchanged, the runtime must re-apply
    // the frozen size — otherwise keepSize silently absorbs the drift.
    const renderWin = makeWindow({ x: 200, y: 100, width: 140, height: 140 });
    const harness = createRuntime({
      renderWin,
      effectivePixelSize: { width: 100, height: 100 },
      currentPixelSize: { width: 100, height: 100 },
      keepSizeAcrossDisplays: true,
      proportional: true,
    });

    harness.runtime.handleDisplayMetricsChanged();

    const setBoundsCalls = renderWin.calls.filter((call) => call[0] === "setBounds");
    assert.equal(setBoundsCalls.length, 1);
    assert.deepEqual(setBoundsCalls[0][1], { x: 200, y: 100, width: 100, height: 100 });
  });

  it("leaves the pet alone when live bounds already match the frozen size and no clamp is needed (#408)", () => {
    // Regression guard for the sizeDrifted branch: in steady state we must
    // not write bounds unnecessarily.
    const renderWin = makeWindow({ x: 200, y: 100, width: 100, height: 100 });
    const harness = createRuntime({
      renderWin,
      effectivePixelSize: { width: 100, height: 100 },
      currentPixelSize: { width: 100, height: 100 },
      keepSizeAcrossDisplays: true,
      proportional: true,
    });

    harness.runtime.handleDisplayMetricsChanged();

    const setBoundsCalls = renderWin.calls.filter((call) => call[0] === "setBounds");
    assert.equal(setBoundsCalls.length, 0);
  });

  it("brings the pet to primary display and flushes runtime prefs", () => {
    const harness = createRuntime({
      effectivePixelSize: { width: 200, height: 160 },
    });

    harness.runtime.bringPetToPrimaryDisplay();

    assert.deepStrictEqual(harness.renderWin.calls[0], [
      "setBounds",
      { x: 400, y: 300, width: 200, height: 160 },
    ]);
    assert.ok(harness.calls.some((call) => call[0] === "repositionFloatingBubbles"));
    assert.ok(harness.calls.some((call) => call[0] === "reassertWinTopmost"));
    assert.ok(harness.calls.some((call) => call[0] === "scheduleHwndRecovery"));
    assert.ok(harness.calls.some((call) => call[0] === "flushRuntimeStateToPrefs"));
  });

  it("recovers a nominally visible pet after renderer load without relocating it", () => {
    const renderWin = makeWindow({ x: 189, y: 403, width: 207, height: 207 });
    const harness = createRuntime({ renderWin });
    renderWin.calls.length = 0;
    harness.hitWin.calls.length = 0;
    harness.calls.length = 0;

    assert.equal(harness.runtime.recoverVisiblePetAfterRendererLoad(), "recovered");

    assert.deepStrictEqual(renderWin.calls.find((call) => call[0] === "setBounds"), [
      "setBounds",
      { x: 189, y: 403, width: 207, height: 207 },
    ]);
    assert.ok(renderWin.calls.some((call) => call[0] === "showInactive"));
    assert.ok(harness.hitWin.calls.some((call) => call[0] === "showInactive"));
    assert.ok(harness.calls.some((call) => call[0] === "reassertWinTopmost"));
    assert.ok(harness.calls.some((call) => call[0] === "scheduleHwndRecovery"));
    assert.ok(!harness.calls.some((call) => call[0] === "flushRuntimeStateToPrefs"));
  });

  it("does not resurrect a pet intentionally hidden when the renderer reloads", () => {
    const harness = createRuntime();
    harness.runtime.setPetHidden(true);
    harness.renderWin.calls.length = 0;
    harness.hitWin.calls.length = 0;
    harness.calls.length = 0;

    assert.equal(harness.runtime.recoverVisiblePetAfterRendererLoad(), "hidden");
    assert.ok(!harness.renderWin.calls.some((call) => call[0] === "showInactive"));
    assert.ok(!harness.hitWin.calls.some((call) => call[0] === "showInactive"));
    assert.ok(!harness.calls.some((call) => call[0] === "reassertWinTopmost"));
  });

  it("keeps the renderer-load recovery Windows-only", () => {
    const harness = createRuntime({ isWin: false });
    harness.renderWin.calls.length = 0;
    harness.hitWin.calls.length = 0;
    harness.calls.length = 0;

    assert.equal(harness.runtime.recoverVisiblePetAfterRendererLoad(), "unsupported");
    assert.deepStrictEqual(harness.renderWin.calls, []);
    assert.deepStrictEqual(harness.hitWin.calls, []);
    assert.deepStrictEqual(harness.calls, []);
  });
});

describe("pet-window-runtime setPetHidden contract (#416)", () => {
  it("hides the pet and reports a real change", () => {
    const h = createRuntime();
    const r = h.runtime.setPetHidden(true);
    assert.deepEqual(r, { applied: true, deferred: false, changed: true });
    assert.equal(h.runtime.isPetHidden(), true);
    assert.ok(h.renderWin.calls.some((c) => c[0] === "hide"));
  });

  it("is idempotent when already in the target state", () => {
    const h = createRuntime();
    h.runtime.setPetHidden(true);
    const before = h.renderWin.calls.length;
    const r = h.runtime.setPetHidden(true);
    assert.deepEqual(r, { applied: true, deferred: false, changed: false });
    assert.equal(h.renderWin.calls.length, before);
  });

  it("shows the pet again", () => {
    const h = createRuntime();
    h.runtime.setPetHidden(true);
    const r = h.runtime.setPetHidden(false);
    assert.deepEqual(r, { applied: true, deferred: false, changed: true });
    assert.equal(h.runtime.isPetHidden(), false);
    assert.ok(h.renderWin.calls.some((c) => c[0] === "showInactive"));
  });

  it("defers without changing state during a mini transition", () => {
    const h = createRuntime({ miniTransitioning: true });
    const r = h.runtime.setPetHidden(true);
    assert.deepEqual(r, { applied: false, deferred: true, changed: false });
    assert.equal(h.runtime.isPetHidden(), false);
  });

  it("reports not-applied when the render window is gone", () => {
    const h = createRuntime();
    h.renderWin.destroyed = true;
    const r = h.runtime.setPetHidden(true);
    assert.deepEqual(r, { applied: false, deferred: false, changed: false });
  });

  it("togglePetVisibility flips state through setPetHidden", () => {
    const h = createRuntime();
    assert.equal(h.runtime.isPetHidden(), false);
    h.runtime.togglePetVisibility();
    assert.equal(h.runtime.isPetHidden(), true);
    h.runtime.togglePetVisibility();
    assert.equal(h.runtime.isPetHidden(), false);
  });
});

// ── #525: DWM cloak self-heal ──
//
// The review of the external cef717d patch (2026-07-16, three independent
// reviewers) blocked a cloak-aware toggle polarity: on a machine whose cloak
// flag reads permanently non-zero (the #496 reporter's machine did, SHELL=2
// while visibly fine), "toggle by actual visibility" degenerates into
// setPetHidden(false) forever — tray/context-menu/shortcut all lose the
// ability to hide. These tests pin the survivors: hide always means hide;
// recovery lives on its own path with guards and backoff.
function makeCloakInspector(overrides = {}) {
  const inspector = {
    calls: [],
    available: overrides.available ?? true,
    // number, or (win) => number for per-window flags (mixed-verdict tests).
    flag: overrides.flag ?? 0,
    // "onCurrent: null" must survive as null (= COM probe down), so ?? is wrong here.
    onCurrent: "onCurrent" in overrides ? overrides.onCurrent : true,
    uncloakClears: overrides.uncloakClears ?? true,
    uncloakResult: overrides.uncloakResult ?? true,
    flagFor(win) {
      return typeof inspector.flag === "function" ? inspector.flag(win) : inspector.flag;
    },
    readCloakState(win) { inspector.calls.push("read"); return inspector.flagFor(win); },
    isOnCurrentVirtualDesktop() { inspector.calls.push("vdesk"); return inspector.onCurrent; },
    uncloak(win) {
      inspector.calls.push("uncloak");
      if (overrides.onUncloak) return overrides.onUncloak(win);
      if (inspector.uncloakClears && typeof inspector.flag !== "function") inspector.flag = 0;
      return inspector.uncloakResult;
    },
    dispose() {},
  };
  return inspector;
}

describe("pet-window-runtime cloak self-heal (#525)", () => {
  it("toggle hides on the FIRST press even when the cloak flag reads permanently non-zero", () => {
    const inspector = makeCloakInspector({ flag: 2, uncloakClears: false });
    const h = createRuntime({ cloakInspector: inspector });
    assert.equal(h.runtime.isPetHidden(), false);
    h.runtime.togglePetVisibility();
    // The blocked external patch returned false here (show-forever). Hide must win.
    assert.equal(h.runtime.isPetHidden(), true);
    h.runtime.togglePetVisibility();
    assert.equal(h.runtime.isPetHidden(), false);
  });

  it("recoverIfCloaked un-cloaks a cloaked window on the current desktop and reports recovered", () => {
    const inspector = makeCloakInspector({ flag: 1, onCurrent: true });
    const h = createRuntime({ cloakInspector: inspector });
    const res = h.runtime.recoverIfCloaked();
    assert.equal(res, "recovered");
    assert.ok(inspector.calls.includes("uncloak"));
    assert.ok(h.calls.some(([name]) => name === "reassertWinTopmost"));
    assert.ok(h.calls.some(([name]) => name === "scheduleHwndRecovery"));
  });

  it("recoverIfCloaked leaves a window parked on another virtual desktop alone", () => {
    const inspector = makeCloakInspector({ flag: 2, onCurrent: false });
    const h = createRuntime({ cloakInspector: inspector });
    const res = h.runtime.recoverIfCloaked();
    assert.equal(res, "clean");
    assert.ok(!inspector.calls.includes("uncloak"));
  });

  it("recoverIfCloaked degrades to APP-only when the virtual-desktop probe is down", () => {
    const shell = makeCloakInspector({ flag: 2, onCurrent: null });
    const hShell = createRuntime({ cloakInspector: shell });
    assert.equal(hShell.runtime.recoverIfCloaked(), "clean");
    assert.ok(!shell.calls.includes("uncloak"));

    const app = makeCloakInspector({ flag: 1, onCurrent: null });
    const hApp = createRuntime({ cloakInspector: app });
    assert.equal(hApp.runtime.recoverIfCloaked(), "recovered");
    assert.ok(app.calls.includes("uncloak"));
  });

  it("recoverIfCloaked guard matrix: hidden/mini/drag/preview each stand down before probing", () => {
    const mkH = (overrides) => {
      const inspector = makeCloakInspector({ flag: 1 });
      return { inspector, h: createRuntime({ cloakInspector: inspector, ...overrides }) };
    };

    const hidden = mkH({});
    hidden.h.runtime.setPetHidden(true);
    hidden.inspector.calls.length = 0;
    assert.equal(hidden.h.runtime.recoverIfCloaked(), "hidden");
    assert.equal(hidden.inspector.calls.length, 0);

    const mini = mkH({ miniTransitioning: true });
    assert.equal(mini.h.runtime.recoverIfCloaked(), "busy");
    assert.equal(mini.inspector.calls.length, 0);

    const anim = mkH({ isMiniAnimating: () => true });
    assert.equal(anim.h.runtime.recoverIfCloaked(), "busy");
    assert.equal(anim.inspector.calls.length, 0);

    const drag = mkH({});
    drag.h.runtime.setDragLocked(true);
    assert.equal(drag.h.runtime.recoverIfCloaked(), "busy");
    assert.equal(drag.inspector.calls.length, 0);

    const preview = mkH({});
    preview.h.runtime.beginSettingsSizePreviewProtection();
    assert.equal(preview.h.runtime.recoverIfCloaked(), "frozen");
    assert.equal(preview.inspector.calls.length, 0);
  });

  it("recoverIfCloaked backs off exponentially after a failed recovery and resets on success", () => {
    let clock = 1_000_000;
    const inspector = makeCloakInspector({ flag: 1, uncloakClears: false });
    const h = createRuntime({ cloakInspector: inspector, now: () => clock });

    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    // Cooldown = 5000 * 2^1 = 10s: immediate retry must be suppressed.
    assert.equal(h.runtime.recoverIfCloaked(), "backoff");
    clock += 9_999;
    assert.equal(h.runtime.recoverIfCloaked(), "backoff");
    clock += 2;
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    // Second failure doubles the cooldown window (20s).
    clock += 10_001;
    assert.equal(h.runtime.recoverIfCloaked(), "backoff");
    clock += 10_000;
    // Un-cloak starts working: recovery succeeds and the streak resets.
    inspector.uncloakClears = true;
    assert.equal(h.runtime.recoverIfCloaked(), "recovered");
    inspector.flag = 1;
    inspector.uncloakClears = false;
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    assert.equal(h.runtime.recoverIfCloaked(), "backoff");
  });

  it("recoverIfCloaked reports unavailable without an inspector (non-Windows / FFI down)", () => {
    const none = createRuntime();
    assert.equal(none.runtime.recoverIfCloaked(), "unavailable");
    const down = createRuntime({ cloakInspector: makeCloakInspector({ available: false }) });
    assert.equal(down.runtime.recoverIfCloaked(), "unavailable");
  });

  it("showPetWindows un-cloaks an abnormally cloaked window BEFORE showInactive (order-sensitive)", () => {
    // Shared timeline so the uncloak/showInactive relative order is provable —
    // a swapped implementation must fail this test.
    const timeline = [];
    const renderWin = makeWindow();
    const origShowInactive = renderWin.showInactive;
    renderWin.showInactive = () => { timeline.push("showInactive"); origShowInactive(); };
    const inspector = makeCloakInspector({ flag: 1, onCurrent: true, onUncloak: () => { timeline.push("uncloak"); return true; } });
    const h = createRuntime({ cloakInspector: inspector, renderWin });
    h.runtime.setPetHidden(true);
    timeline.length = 0;
    h.runtime.setPetHidden(false);
    const uncloakIdx = timeline.indexOf("uncloak");
    const showIdx = timeline.indexOf("showInactive");
    assert.ok(uncloakIdx >= 0 && showIdx >= 0);
    assert.ok(uncloakIdx < showIdx, `expected uncloak before showInactive, got ${JSON.stringify(timeline)}`);
  });

  it("recoverIfCloaked fails the round when one window recovers and the other stays cloaked", () => {
    const flags = new Map();
    const renderWin = makeWindow();
    const hitWin = makeWindow();
    flags.set(renderWin, 1); // recovers on uncloak
    flags.set(hitWin, 1);    // stays cloaked forever
    const inspector = makeCloakInspector({
      flag: (win) => flags.get(win) ?? 0,
      onUncloak: (win) => { if (win === renderWin) flags.set(renderWin, 0); return true; },
    });
    const h = createRuntime({ cloakInspector: inspector, renderWin, hitWin });
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    // Shared cooldown: the healthy window's success must not clear the streak.
    assert.equal(h.runtime.recoverIfCloaked(), "backoff");
  });

  it("recoverIfCloaked does not touch the window when the un-cloak call itself fails (fail-open)", () => {
    const inspector = makeCloakInspector({ flag: 1, uncloakResult: false, uncloakClears: false });
    const renderWin = makeWindow();
    const h = createRuntime({ cloakInspector: inspector, renderWin });
    const before = renderWin.calls.length;
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    assert.ok(inspector.calls.includes("uncloak"));
    // No showInactive/keepOutOfTaskbar on the window after a failed native call...
    assert.deepStrictEqual(renderWin.calls.slice(before), []);
    assert.ok(!h.calls.some(([name]) => name === "keepOutOfTaskbar"));
    // ...and no global topmost re-assert either — an all-failed round must be
    // a complete no-op on the windows (codex round-3 finding).
    assert.ok(!h.calls.some(([name]) => name === "reassertWinTopmost"));
  });

  it("recoverIfCloaked still re-asserts topmost in a mixed round where one window did recover", () => {
    const flags = new Map();
    const renderWin = makeWindow();
    const hitWin = makeWindow();
    flags.set(renderWin, 1);
    flags.set(hitWin, 1);
    const inspector = makeCloakInspector({
      flag: (win) => flags.get(win) ?? 0,
      onUncloak: (win) => {
        if (win === renderWin) { flags.set(renderWin, 0); return true; }
        return false; // hit window's native un-cloak fails
      },
    });
    const h = createRuntime({ cloakInspector: inspector, renderWin, hitWin });
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    // The recovered window was shown, so the topmost re-assert must run.
    assert.ok(renderWin.calls.some(([n]) => n === "showInactive"));
    assert.ok(h.calls.some(([name]) => name === "reassertWinTopmost"));
  });

  it("a clean round resets the backoff so the next independent fault starts fresh", () => {
    let clock = 1_000_000;
    const inspector = makeCloakInspector({ flag: 1, uncloakClears: false });
    const h = createRuntime({ cloakInspector: inspector, now: () => clock });

    assert.equal(h.runtime.recoverIfCloaked(), "failed");   // streak=1, cooldown 10s
    clock += 10_001;
    inspector.flag = 0;                                      // fault resolves on its own
    assert.equal(h.runtime.recoverIfCloaked(), "clean");     // must reset the streak
    inspector.flag = 1;                                      // NEW independent fault
    assert.equal(h.runtime.recoverIfCloaked(), "failed");    // streak must restart at 1
    clock += 10_001;                                         // fresh 10s window, not 20s
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
  });
});
