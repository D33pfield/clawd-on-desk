"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");

function cloneTheme(theme) {
  return JSON.parse(JSON.stringify(theme));
}

function loadMiniWithElectron(screenExports) {
  const electronPath = require.resolve("electron");
  const miniPath = require.resolve("../src/mini");
  const previousElectron = Object.prototype.hasOwnProperty.call(require.cache, electronPath)
    ? require.cache[electronPath]
    : null;
  const previousMini = Object.prototype.hasOwnProperty.call(require.cache, miniPath)
    ? require.cache[miniPath]
    : null;

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      screen: screenExports,
    },
  };
  delete require.cache[miniPath];

  return {
    initMini: require("../src/mini"),
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousMini) require.cache[miniPath] = previousMini;
      else delete require.cache[miniPath];
    },
  };
}

function makeCtx(theme, stateLog, initialX = 160) {
  const bounds = { x: initialX, y: 180, width: 120, height: 120 };
  return {
    theme,
    currentState: "idle",
    win: {
      getBounds() { return { ...bounds }; },
      setBounds(next) {
        bounds.x = next.x;
        bounds.y = next.y;
        bounds.width = next.width;
        bounds.height = next.height;
      },
      setPosition(x, y) {
        bounds.x = x;
        bounds.y = y;
      },
      isDestroyed() { return false; },
    },
    doNotDisturb: false,
    bubbleFollowPet: false,
    pendingPermissions: [],
    currentSize: "m",
    mouseOverPet: false,
    SIZES: { m: { width: 120, height: 120 } },
    getCurrentPixelSize() { return { width: 120, height: 120 }; },
    getPetWindowBounds() { return { ...bounds }; },
    getAnimationAssetCycleMs(file) {
      if (file && file.includes("mini-enter")) return 240;
      return null;
    },
    setViewportOffsetY() {},
    stopWakePoll() {},
    sendToRenderer() {},
    sendToHitWin() {},
    buildContextMenu() {},
    buildTrayMenu() {},
    syncHitWin() {},
    repositionBubbles() {},
    getNearestWorkArea() { return { x: 0, y: 0, width: 800, height: 600 }; },
    clampToScreenVisual(x, y, width, height) { return { x, y, width, height }; },
    resolveDisplayState() { return "idle"; },
    getSvgOverride() { return null; },
    applyState(state) {
      this.currentState = state;
      stateLog.push(state);
    },
  };
}

describe("mini mode entry timing", () => {
  let loader;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    if (loader) loader.restore();
    mock.timers.reset();
    loader = null;
  });

  it("edge-snap entry reaches mini-idle without a multi-second freeze", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    const rightMiniX = 800 - Math.round(120 * (1 - theme.miniMode.offsetRatio));
    const ctx = makeCtx(theme, stateLog, rightMiniX);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(260);

    assert.deepStrictEqual(stateLog.slice(0, 2), ["mini-enter", "mini-idle"]);
    assert.equal(mini.getMiniTransitioning(), false);
    assert.equal(mini.getMiniMode(), true);
  });

  it("via-menu mini handoff also settles into mini-idle quickly", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    const ctx = makeCtx(theme, stateLog, 800);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, true, "right");
    mock.timers.tick(350);
    mock.timers.tick(260);

    assert.deepStrictEqual(stateLog, ["mini-enter", "mini-idle"]);
    assert.equal(mini.getMiniTransitioning(), false);
    assert.equal(mini.getMiniMode(), true);
  });

  it("enters mini-peek immediately after enter when the cursor is already over the pet", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    const rightMiniX = 800 - Math.round(120 * (1 - theme.miniMode.offsetRatio));
    const ctx = makeCtx(theme, stateLog, rightMiniX);
    ctx.mouseOverPet = true;
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(260);

    assert.deepStrictEqual(stateLog.slice(0, 2), ["mini-enter", "mini-peek"]);
    assert.equal(mini.getMiniTransitioning(), false);
    assert.equal(mini.getMiniMode(), true);
  });

  it("hover can interrupt mini-enter before the full enter cycle completes", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    const rightMiniX = 800 - Math.round(120 * (1 - theme.miniMode.offsetRatio));
    const ctx = makeCtx(theme, stateLog, rightMiniX);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);

    assert.equal(mini.interruptMiniEnterForHover(), true);
    assert.deepStrictEqual(stateLog.slice(0, 2), ["mini-enter", "mini-peek"]);
    assert.equal(mini.getMiniTransitioning(), false);
  });
});
