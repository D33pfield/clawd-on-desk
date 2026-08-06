"use strict";

const assert = require("node:assert");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { describe, it } = require("node:test");

const DASHBOARD_MODULE_PATH = require.resolve("../src/dashboard");

function loadDashboardWithElectron(fakeElectron) {
  delete require.cache[DASHBOARD_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/dashboard");
  } finally {
    Module._load = originalLoad;
  }
}

describe("dashboard window", () => {
  function createWindowHarness(options = {}) {
    let createdWindow = null;
    const nativeTheme = new EventEmitter();
    nativeTheme.shouldUseDarkColors = false;
    const timers = [];

    class FakeBrowserWindow {
      constructor(opts) {
        // Models native frame quantization: the WM may hand back a slightly
        // different rectangle than the one requested.
        const offset = options.constructorBoundsOffset || {};
        this.opts = opts;
        this.bounds = {
          x: opts.x + (offset.x || 0),
          y: opts.y + (offset.y || 0),
          width: opts.width + (offset.width || 0),
          height: opts.height + (offset.height || 0),
        };
        this.destroyed = false;
        this.backgroundColors = [opts.backgroundColor];
        this.parentWindows = [];
        this.setBoundsCalls = [];
        this.onceCallbacks = new Map();
        this.onCallbacks = new Map();
        this.normalBounds = null;
        this.webContents = {
          isDestroyed: () => false,
          once: () => {},
          send: () => {},
        };
        createdWindow = this;
      }
      isDestroyed() { return this.destroyed; }
      isMinimized() { return false; }
      restore() {}
      show() {}
      focus() {}
      setMenuBarVisibility() {}
      loadFile() {}
      once(eventName, callback) { this.onceCallbacks.set(eventName, callback); }
      on(eventName, callback) {
        const list = this.onCallbacks.get(eventName) || [];
        list.push(callback);
        this.onCallbacks.set(eventName, list);
      }
      emit(eventName) {
        for (const callback of this.onCallbacks.get(eventName) || []) callback();
      }
      getBounds() { return { ...this.bounds }; }
      getNormalBounds() { return { ...(this.normalBounds || this.bounds) }; }
      setBackgroundColor(color) { this.backgroundColors.push(color); }
      setBounds(bounds) {
        const offset = options.setBoundsOffset || {};
        this.bounds = {
          x: bounds.x + (offset.x || 0),
          y: bounds.y + (offset.y || 0),
          width: bounds.width + (offset.width || 0),
          height: bounds.height + (offset.height || 0),
        };
        this.setBoundsCalls.push({ ...bounds });
      }
      setParentWindow(parentWindow) {
        this.parentWindows.push(parentWindow);
      }
      emitReadyToShow() {
        const callback = this.onceCallbacks.get("ready-to-show");
        if (callback) callback();
      }
    }

    const initDashboard = loadDashboardWithElectron({
      BrowserWindow: FakeBrowserWindow,
      nativeTheme,
    });
    const dashboard = initDashboard({
      getPetWindowBounds: options.getPetWindowBounds
        || (() => ({ x: 100, y: 100, width: 120, height: 120 })),
      getNearestWorkArea: options.getNearestWorkArea || (() => ({ x: 0, y: 0, width: 1280, height: 800 })),
      getSettingsWindow: options.getSettingsWindow,
      getSavedBounds: options.getSavedBounds,
      onSaveBounds: options.onSaveBounds,
      getTextScale: options.getTextScale,
      setTimeout: options.setTimeout || ((callback, delay) => {
        timers.push({ callback, delay, cleared: false });
        return timers.length;
      }),
      clearTimeout: options.clearTimeout || ((id) => {
        const timer = timers[id - 1];
        if (timer) timer.cleared = true;
      }),
      getSessionSnapshot: () => ({ sessions: [], groups: [] }),
      getI18n: () => ({ lang: "en", translations: {} }),
    });

    return {
      dashboard,
      nativeTheme,
      timers,
      getCreatedWindow: () => createdWindow,
    };
  }

  it("updates its background color when native theme changes", () => {
    const { dashboard, nativeTheme, getCreatedWindow } = createWindowHarness();

    dashboard.showDashboard();
    const createdWindow = getCreatedWindow();
    assert.strictEqual(createdWindow.opts.backgroundColor, "#f5f5f7");

    nativeTheme.shouldUseDarkColors = true;
    nativeTheme.emit("updated");

    assert.deepStrictEqual(createdWindow.backgroundColors, ["#f5f5f7", "#1c1c1f"]);
  });

  it("centers the dashboard on the pet work area by default", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness();

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 400,
      y: 100,
      width: 480,
      height: 600,
    });
    assert.strictEqual(getCreatedWindow().opts.parent, undefined);
    assert.strictEqual(getCreatedWindow().opts.modal, undefined);
  });

  it("anchors dashboard windows opened from settings to the settings window bounds", () => {
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
    });

    dashboard.showDashboard({ source: "settings" });

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 260,
      y: 50,
      width: 480,
      height: 560,
    });
    assert.strictEqual(getCreatedWindow().opts.parent, undefined);
    assert.strictEqual(getCreatedWindow().opts.modal, undefined);
    assert.deepStrictEqual(getCreatedWindow().parentWindows, []);
  });

  it("clamps settings-anchored dashboard bounds to the work area", () => {
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 900, y: 500, width: 500, height: 700 }),
    };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1000, height: 600 }),
    });

    dashboard.showDashboard({ source: "settings" });

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 520,
      y: 0,
      width: 480,
      height: 600,
    });
  });

  it("falls back to pet work area centering when the settings window is unavailable", () => {
    const settingsWindow = {
      isDestroyed: () => true,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
    });

    dashboard.showDashboard({ source: "settings" });

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 400,
      y: 100,
      width: 480,
      height: 600,
    });
    assert.strictEqual(getCreatedWindow().opts.parent, undefined);
  });

  it("repositions an existing dashboard when reopened from settings", () => {
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
    });

    dashboard.showDashboard();
    dashboard.showDashboard({ source: "settings" });

    assert.deepStrictEqual(getCreatedWindow().setBoundsCalls, [{
      x: 260,
      y: 50,
      width: 480,
      height: 560,
    }]);
    assert.deepStrictEqual(getCreatedWindow().parentWindows, []);
  });

  it("re-syncs settings anchored bounds before and after showing the dashboard", () => {
    let settingsBounds = { x: 100, y: 50, width: 800, height: 560 };
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => settingsBounds,
    };
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
    });

    dashboard.showDashboard({ source: "settings" });
    settingsBounds = { x: 100, y: 50, width: 800, height: 540 };
    getCreatedWindow().emitReadyToShow();
    settingsBounds = { x: 100, y: 50, width: 800, height: 520 };
    for (const timer of timers) timer.callback();

    assert.deepStrictEqual(getCreatedWindow().setBoundsCalls, [
      { x: 260, y: 50, width: 480, height: 540 },
      { x: 260, y: 50, width: 480, height: 520 },
      { x: 260, y: 50, width: 480, height: 520 },
    ]);
    assert.deepStrictEqual(timers.map((timer) => timer.delay), [0, 80]);
  });

  it("restores saved dashboard bounds instead of pet centering", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: 40, y: 60, width: 500, height: 520 }),
    });

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 40,
      y: 60,
      width: 500,
      height: 520,
    });
  });

  it("clamps restored bounds to the work area and scaled minimum", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: 2000, y: 700, width: 200, height: 300 }),
    });

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 960,
      y: 400,
      width: 320,
      height: 400,
    });
  });

  it("applies the saved display's scaled minimum when restoring bounds", () => {
    const scaleBounds = [];
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: 2100, y: 80, width: 480, height: 600 }),
      getNearestWorkArea: () => ({ x: 2000, y: 0, width: 1280, height: 800 }),
      // The saved rect lives on a 1.6-scale display; the pet (no bounds
      // argument) does not.
      getTextScale: (bounds) => {
        scaleBounds.push(bounds);
        return bounds && bounds.x >= 2000 ? 1.6 : 1;
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();

    assert.deepStrictEqual(scaleBounds[0], { x: 2100, y: 80, width: 480, height: 600 });
    assert.deepStrictEqual(win.bounds, {
      x: 2100,
      y: 80,
      width: 512,
      height: 640,
    });
    assert.strictEqual(win.opts.minWidth, 512);
    assert.strictEqual(win.opts.minHeight, 640);
  });

  it("a tiny work area caps both restored bounds and window minimums", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: 1000, y: 800, width: 900, height: 700 }),
      getNearestWorkArea: () => ({ x: 50, y: 60, width: 500, height: 400 }),
      getTextScale: () => 1.6,
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();

    assert.deepStrictEqual(win.bounds, { x: 50, y: 60, width: 500, height: 400 });
    assert.strictEqual(win.opts.minWidth, 500);
    assert.strictEqual(win.opts.minHeight, 400);
  });

  it("falls back to a sane work area when the display reports a degenerate one", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: 40, y: 60, width: 500, height: 520 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    });

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 40,
      y: 60,
      width: 500,
      height: 520,
    });
  });

  it("tolerates a throwing pet-bounds lookup", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getPetWindowBounds: () => { throw new Error("display teardown"); },
    });

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 400,
      y: 100,
      width: 480,
      height: 600,
    });
  });

  it("clears the pending move text-scale timer on closed", () => {
    const { dashboard, getCreatedWindow, timers } = createWindowHarness();

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.emit("move");
    const scaleTimer = timers.filter((t) => t.delay === 350).at(-1);
    assert.strictEqual(scaleTimer.cleared, false);

    win.emit("close");
    win.emit("closed");
    assert.strictEqual(scaleTimer.cleared, true);
  });

  it("uses persisted bounds when the dashboard window is recreated", () => {
    let persisted = null;
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => persisted,
      onSaveBounds: (bounds) => {
        persisted = bounds;
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const first = getCreatedWindow();
    first.normalBounds = { x: 420, y: 230, width: 640, height: 500 };
    first.emit("close");
    first.emit("closed");

    dashboard.showDashboard();
    const reopened = getCreatedWindow();
    assert.notStrictEqual(reopened, first);
    assert.deepStrictEqual(reopened.bounds, { x: 420, y: 230, width: 640, height: 500 });
  });

  it("ignores invalid saved bounds and falls back to pet centering", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: NaN, y: 0, width: 480, height: 600 }),
    });

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 400,
      y: 100,
      width: 480,
      height: 600,
    });
  });

  it("keeps settings-anchored placement even when saved bounds exist", () => {
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
      getSavedBounds: () => ({ x: 10, y: 20, width: 500, height: 500 }),
    });

    dashboard.showDashboard({ source: "settings" });

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 260,
      y: 50,
      width: 480,
      height: 560,
    });
  });

  it("persists moved and resized normal bounds with a shared debounce", () => {
    const saved = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 300, y: 200, width: 640, height: 700 };
    win.emit("move");
    win.emit("resize");

    const saveTimers = timers.filter((timer) => timer.delay === 500);
    assert.strictEqual(saveTimers.length, 2);
    assert.strictEqual(saveTimers[0].cleared, true);
    assert.strictEqual(saveTimers[1].cleared, false);
    assert.deepStrictEqual(saved, []);

    saveTimers[1].callback();
    assert.deepStrictEqual(saved, [
      { x: 300, y: 200, width: 640, height: 700 },
    ]);

    // A duplicate native event after the same geometry must not rewrite prefs.
    win.emit("resize");
    timers.filter((timer) => timer.delay === 500).at(-1).callback();
    assert.strictEqual(saved.length, 1);
  });

  it("flushes pending geometry on close and skips untouched windows", () => {
    const saved = [];
    const { dashboard, getCreatedWindow } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.emit("close");
    assert.deepStrictEqual(saved, []);

    win.bounds = { x: 5, y: 6, width: 700, height: 500 };
    win.emit("move");
    win.emit("close");
    assert.deepStrictEqual(saved, [
      { x: 5, y: 6, width: 700, height: 500 },
    ]);
  });

  it("saves normal bounds, not the maximized rectangle", () => {
    const saved = [];
    const { dashboard, getCreatedWindow } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.normalBounds = { x: 15, y: 25, width: 600, height: 500 };
    win.bounds = { x: 0, y: 0, width: 1280, height: 800 };
    win.emit("close");

    assert.deepStrictEqual(saved, [
      { x: 15, y: 25, width: 600, height: 500 },
    ]);
  });

  it("does not persist the programmatic settings re-anchor", () => {
    const saved = [];
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard({ source: "settings" });
    const win = getCreatedWindow();
    win.emitReadyToShow();
    // Electron reports programmatic setBounds through the same move event.
    win.emit("move");
    for (const timer of timers.filter((t) => !t.cleared && t.delay === 500)) {
      timer.callback();
    }
    assert.deepStrictEqual(saved, []);

    // A real user drag afterwards still persists.
    win.bounds = { x: 900, y: 300, width: 520, height: 560 };
    win.emit("move");
    timers.filter((t) => !t.cleared && t.delay === 500).at(-1).callback();
    assert.deepStrictEqual(saved, [
      { x: 900, y: 300, width: 520, height: 560 },
    ]);
  });

  it("saves a still-debounced user move before the settings re-anchor drops it", () => {
    let persisted = { x: 40, y: 60, width: 520, height: 520 };
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
      getSavedBounds: () => persisted,
      onSaveBounds: (bounds) => {
        persisted = bounds;
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    const moved = { x: 700, y: 180, width: 520, height: 560 };
    win.bounds = { ...moved };
    win.emit("move");

    // Re-opening from Settings before the 500ms debounce fires.
    dashboard.showDashboard({ source: "settings" });
    assert.deepStrictEqual(persisted, moved);

    // The anchor itself still must not be persisted.
    assert.deepStrictEqual(win.bounds, { x: 260, y: 50, width: 480, height: 560 });
    win.emit("move");
    for (const timer of timers.filter((t) => !t.cleared && t.delay === 500)) {
      timer.callback();
    }
    assert.deepStrictEqual(persisted, moved);

    win.emit("close");
    win.emit("closed");
    dashboard.showDashboard();
    assert.deepStrictEqual(getCreatedWindow().bounds, moved);
  });

  it("does not persist anchor growth to the scaled minimum on a short display", () => {
    const saved = [];
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
      // Work area height (600) sits below the scaled minimum height (640 at
      // 1.6), so the anchored placement is clamped short and the text-scale
      // pass grows the window right after placement.
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1280, height: 600 }),
      getTextScale: () => 1.6,
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard({ source: "settings" });
    const win = getCreatedWindow();
    win.emitReadyToShow();
    assert.strictEqual(win.bounds.height, 640);
    win.emit("resize");
    for (const timer of timers.filter((t) => !t.cleared && t.delay === 500)) {
      timer.callback();
    }
    assert.deepStrictEqual(saved, []);

    // A real user drag afterwards still persists.
    win.bounds = { x: 200, y: 20, width: 900, height: 640 };
    win.emit("move");
    timers.filter((t) => !t.cleared && t.delay === 500).at(-1).callback();
    assert.deepStrictEqual(saved, [
      { x: 200, y: 20, width: 900, height: 640 },
    ]);
  });

  it("keeps a failed synchronous persistence retryable", () => {
    const attempts = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        attempts.push(bounds);
        return attempts.length === 1
          ? { status: "error", message: "read only" }
          : { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 310, y: 220, width: 880, height: 620 };
    win.emit("resize");
    timers.filter((t) => t.delay === 500).at(-1).callback();
    win.emit("resize");
    timers.filter((t) => t.delay === 500).at(-1).callback();

    assert.strictEqual(attempts.length, 2);
  });

  it("keeps a failed asynchronous persistence retryable", async () => {
    const attempts = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        attempts.push(bounds);
        return Promise.resolve(attempts.length === 1
          ? { status: "error", message: "disk full" }
          : { status: "ok" });
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 310, y: 220, width: 880, height: 620 };
    win.emit("resize");
    timers.filter((t) => t.delay === 500).at(-1).callback();
    await Promise.resolve();
    await Promise.resolve();
    win.emit("resize");
    timers.filter((t) => t.delay === 500).at(-1).callback();

    assert.strictEqual(attempts.length, 2);
  });

  it("destroyed windows and closed cleanup cannot fire a pending bounds save", () => {
    const saved = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 310, y: 220, width: 880, height: 620 };
    win.emit("resize");
    const pendingSave = timers.filter((t) => t.delay === 500).at(-1);
    win.destroyed = true;
    win.emit("closed");

    assert.strictEqual(pendingSave.cleared, true);
    pendingSave.callback();
    assert.deepStrictEqual(saved, []);
  });

  it("normal-bounds lookup falls back to current bounds when unavailable", () => {
    const saved = [];
    const { dashboard, getCreatedWindow } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 330, y: 240, width: 860, height: 610 };
    win.getNormalBounds = () => { throw new Error("unsupported"); };
    win.emit("close");

    assert.deepStrictEqual(saved, [
      { x: 330, y: 240, width: 860, height: 610 },
    ]);
  });

  it("saved bounds override native constructor frame drift", () => {
    const savedBounds = { x: 40, y: 60, width: 500, height: 520 };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      constructorBoundsOffset: { width: 2 },
      getSavedBounds: () => savedBounds,
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();

    assert.deepStrictEqual(win.bounds, savedBounds);
    assert.deepStrictEqual(win.setBoundsCalls, [savedBounds]);
  });

  it("an untouched window does not persist native frame quantization on close", () => {
    const saved = [];
    const savedBounds = { x: 40, y: 60, width: 500, height: 520 };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      constructorBoundsOffset: { width: 2 },
      // Simulate a WM that cannot adopt the requested outer width exactly
      // even when the runtime follows up with setBounds().
      setBoundsOffset: { width: 1 },
      getSavedBounds: () => savedBounds,
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    assert.deepStrictEqual(win.getBounds(), { ...savedBounds, width: 501 });

    win.emit("close");
    assert.deepStrictEqual(saved, []);
  });

  it("exposes a Clawd-only hide action instead of a terminal close action", () => {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
    const preloadSource = fs.readFileSync(path.join(__dirname, "..", "src", "preload-dashboard.js"), "utf8");

    assert.match(rendererSource, /dashboardHideSessionTitle/);
    assert.match(rendererSource, /hideSession\(session\.id\)/);
    assert.match(rendererSource, /session\.canFocus !== true/);
    assert.match(rendererSource, /dashboardOpenCodexSession/);
    assert.doesNotMatch(rendererSource, /session\.platform === "webui"/);
    assert.match(preloadSource, /dashboard:hide-session/);
  });

  it("wires account quota (including Dashboard-only Spark) into the dashboard header", () => {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
    const htmlSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");

    assert.match(htmlSource, /id="quotaSummary" class="quota-summary" hidden/);
    // Quota renders from the session-independent per-source store
    // (snapshot.accountQuota), grouped local + one row per remote host —
    // never from per-session fields.
    assert.match(rendererSource, /renderQuotaSummary\(snapshot\)/);
    assert.match(rendererSource, /snapshot\.accountQuota/);
    assert.doesNotMatch(rendererSource, /resolveQuotaForDisplay/);
    assert.match(rendererSource, /buildQuotaSourceHeader/);
    // Wall-clock expiry: a bucket whose resetAt passed must not keep showing
    // the pre-reset high between snapshots.
    assert.match(rendererSource, /isExpiredBucket/);
    // Quiet sources are labeled instead of presenting old numbers as live.
    assert.match(rendererSource, /QUOTA_STALE_AFTER_MS/);
    // Codex can change which rate-limit windows it exposes. The Dashboard
    // must use reporter metadata rather than the legacy slot label.
    assert.match(rendererSource, /formatQuotaWindowLabel/);
    assert.match(rendererSource, /bucket && bucket\.windowMinutes/);
    assert.match(rendererSource, /source\.codexSparkQuota/);
    for (const key of [
      "dashboardQuotaSectionAntigravity",
      "dashboardQuotaGroupGemini",
      "dashboardQuotaGroupThirdParty",
      "dashboardQuotaSectionClaudeCode",
      "dashboardQuotaSectionCodex",
      "dashboardQuotaSectionCodexSpark",
      "dashboardQuotaSourceLocal",
      "dashboardQuotaAsOf",
      "dashboardQuotaFiveHour",
      "dashboardQuotaWeekly",
      "dashboardQuotaResetIn",
      "dashboardQuotaResetOn",
      "dashboardQuotaResetHoursMinutes",
      "dashboardQuotaResetMinutes",
    ]) {
      assert.match(rendererSource, new RegExp(key));
    }
  });

  it("memoizes the quota summary rebuild instead of rebuilding on every 1s render tick", () => {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");

    assert.match(rendererSource, /computeQuotaSummarySignature\(accountQuota\)/);
    assert.match(rendererSource, /if \(signature === lastQuotaSummarySignature\) return;/);
    assert.match(rendererSource, /resetDateFormatterLang !== lang/);
  });

  it("does not replace an open session automation select on the one-second render tick", () => {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");

    assert.match(rendererSource, /function hasFocusedSessionAutomationSelect\(\)/);
    assert.match(rendererSource, /active\.tagName === "SELECT"/);
    assert.match(rendererSource, /active\.classList\.contains\("session-automation-select"\)/);
    assert.match(
      rendererSource,
      /\(activeEdit \|\| hasFocusedSessionAutomationSelect\(\)\) && !options\.force/
    );
  });
});
