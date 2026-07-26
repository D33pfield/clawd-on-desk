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
