"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createThemeRuntime = require("../src/theme-runtime");
const themeLoader = require("../src/theme-loader");

const SRC_DIR = path.join(__dirname, "..", "src");
const REQUIRED_STATES = [
  "idle",
  "yawning",
  "dozing",
  "collapsing",
  "thinking",
  "working",
  "sleeping",
  "waking",
];

const tempDirs = [];

function validThemeJson(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "Theme",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: Object.fromEntries(REQUIRED_STATES.map((state) => [state, [`${state}.svg`]])),
    ...overrides,
  };
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-runtime-"));
  tempDirs.push(tmp);
  const appDir = path.join(tmp, "src");
  const userData = path.join(tmp, "userData");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "svg"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "sounds"), { recursive: true });
  for (const id of ["clawd", "calico"]) {
    const themeDir = path.join(tmp, "themes", id);
    fs.mkdirSync(themeDir, { recursive: true });
    fs.writeFileSync(
      path.join(themeDir, "theme.json"),
      JSON.stringify(validThemeJson({ name: id })),
      "utf8"
    );
  }
  themeLoader.init(appDir, userData);
  themeLoader.bindActiveThemeRuntime(null);
  return { tmp, appDir, userData };
}

function createSettingsController(overrides = {}) {
  const values = {
    themeVariant: {},
    themeOverrides: {},
    ...overrides,
  };
  return {
    get(key) {
      return values[key];
    },
  };
}

function createRuntime(options = {}) {
  const calls = [];
  const stateRuntime = {
    cleanup: () => calls.push("state.cleanup"),
    refreshTheme: () => calls.push("state.refreshTheme"),
  };
  const tickRuntime = {
    cleanup: () => calls.push("tick.cleanup"),
    refreshTheme: () => calls.push("tick.refreshTheme"),
  };
  const miniRuntime = {
    cleanup: () => calls.push("mini.cleanup"),
    refreshTheme: () => calls.push("mini.refreshTheme"),
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    handleDisplayChange: () => calls.push("mini.handleDisplayChange"),
    exitMiniMode: () => calls.push("mini.exitMiniMode"),
  };
  const sequencer = {
    run(callbacks) {
      calls.push("sequencer.run");
      callbacks.onReloadFinished();
    },
    cleanup: () => calls.push("sequencer.cleanup"),
  };
  const runtime = createThemeRuntime({
    themeLoader,
    settingsController: createSettingsController(options.settings || {}),
    getRenderWindow: () => ({ isDestroyed: () => false }),
    getHitWindow: () => ({ isDestroyed: () => false }),
    getStateRuntime: () => stateRuntime,
    getTickRuntime: () => tickRuntime,
    getMiniRuntime: () => miniRuntime,
    getFadeSequencer: () => sequencer,
    getPetWindowBounds: () => ({ x: 10, y: 20, width: 100, height: 100 }),
    applyPetWindowBounds: (bounds) => calls.push(["applyBounds", bounds]),
    computeFinalDragBounds: () => null,
    clampToScreenVisual: (x, y) => ({ x, y }),
    flushRuntimeStateToPrefs: () => calls.push("flushPrefs"),
    syncHitStateAfterLoad: () => calls.push("syncHitState"),
    syncRendererStateAfterLoad: () => calls.push("syncRendererState"),
    syncHitWin: () => calls.push("syncHitWin"),
    syncSessionHudVisibility: () => calls.push("syncSessionHud"),
    startMainTick: () => calls.push("startMainTick"),
    bumpAnimationOverridePreviewPosterGeneration: () => calls.push("bumpPoster"),
    rebuildAllMenus: () => calls.push("rebuildMenus"),
  });
  return { runtime, calls };
}

afterEach(() => {
  themeLoader.bindActiveThemeRuntime(null);
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("theme-runtime active ownership", () => {
  it("keeps active theme caches out of theme-loader and deferred wrappers out of main", () => {
    const loaderSource = fs.readFileSync(path.join(SRC_DIR, "theme-loader.js"), "utf8");
    const mainSource = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");

    assert.doesNotMatch(loaderSource, /\blet\s+activeTheme\b/);
    assert.doesNotMatch(loaderSource, /\blet\s+activeThemeContext\b/);
    assert.doesNotMatch(mainSource, /\blet\s+activeTheme\b/);
    assert.ok(!mainSource.includes("_deferredActivateTheme"));
    assert.ok(!mainSource.includes("_deferredGetThemeInfo"));
    assert.ok(!mainSource.includes("_deferredRemoveThemeDir"));
    assert.ok(!mainSource.includes("function activateTheme("));
  });

  it("keeps theme-loader stateless while legacy active facades delegate to the runtime", () => {
    makeFixture();
    const { runtime } = createRuntime();
    themeLoader.bindActiveThemeRuntime(runtime);

    const clawd = runtime.loadInitialTheme("clawd");
    const loadedCalico = themeLoader.loadTheme("calico", { strict: true });

    assert.strictEqual(clawd._id, "clawd");
    assert.strictEqual(loadedCalico._id, "calico");
    assert.strictEqual(runtime.getActiveTheme()._id, "clawd");
    assert.strictEqual(themeLoader.getActiveTheme()._id, "clawd");
    assert.deepStrictEqual(themeLoader.getRendererConfig(), runtime.getRendererConfig());

    runtime.loadInitialTheme("calico");
    assert.strictEqual(themeLoader.getActiveTheme()._id, "calico");
  });

  it("dedups an already-active theme without running the reload protocol", () => {
    makeFixture();
    const { runtime, calls } = createRuntime();
    runtime.loadInitialTheme("clawd");

    const result = runtime.activateTheme("clawd");

    assert.deepStrictEqual(result, { themeId: "clawd", variantId: "default" });
    assert.deepStrictEqual(calls, []);
  });

  it("switches themes through the cleanup, refresh, and sequencer protocol", () => {
    makeFixture();
    const { runtime, calls } = createRuntime();
    runtime.loadInitialTheme("clawd");

    const result = runtime.activateTheme("calico");

    assert.deepStrictEqual(result, { themeId: "calico", variantId: "default" });
    assert.strictEqual(runtime.getActiveTheme()._id, "calico");
    assert.deepStrictEqual(calls, [
      "bumpPoster",
      "state.cleanup",
      "tick.cleanup",
      "mini.cleanup",
      "mini.refreshTheme",
      "state.refreshTheme",
      "tick.refreshTheme",
      "sequencer.run",
      ["applyBounds", { x: 10, y: 20, width: 100, height: 100 }],
      "syncHitState",
      "syncRendererState",
      "syncHitWin",
      "syncSessionHud",
      "startMainTick",
      "flushPrefs",
    ]);
  });
});
