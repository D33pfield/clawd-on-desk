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

function loadTickWithScreen(getCursorScreenPoint) {
  const electronPath = require.resolve("electron");
  const tickPath = require.resolve("../src/tick");
  const previousElectron = Object.prototype.hasOwnProperty.call(require.cache, electronPath)
    ? require.cache[electronPath]
    : null;
  const previousTick = Object.prototype.hasOwnProperty.call(require.cache, tickPath)
    ? require.cache[tickPath]
    : null;

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      screen: { getCursorScreenPoint },
    },
  };
  delete require.cache[tickPath];

  return {
    initTick: require("../src/tick"),
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousTick) require.cache[tickPath] = previousTick;
      else delete require.cache[tickPath];
    },
  };
}

function makeCtx(theme, statesSeen) {
  return {
    theme,
    win: {
      setIgnoreMouseEvents() {},
      isDestroyed() { return false; },
      getBounds() { return { x: 0, y: 0, width: 120, height: 120 }; },
    },
    currentState: "idle",
    currentSvg: theme.states.idle[0],
    idlePaused: false,
    miniMode: false,
    miniTransitioning: false,
    dragLocked: false,
    menuOpen: false,
    isAnimating: false,
    mouseOverPet: false,
    forceEyeResend: false,
    startupRecoveryActive: false,
    sendToRenderer() {},
    sendToHitWin() {},
    getHitRectScreen() { return { left: 0, top: 0, right: 120, bottom: 120 }; },
    getObjRect() { return { x: 20, y: 20, w: 60, h: 60 }; },
    setState(state) {
      statesSeen.push(state);
      this.currentState = state;
    },
    applyState(state) {
      statesSeen.push(state);
      this.currentState = state;
    },
    miniPeekIn() {},
    miniPeekOut() {},
  };
}

describe("tick sleepSequence mode", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  it("direct mode goes straight to sleeping after mouseSleepTimeout", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "direct" };
    theme.timings.mouseIdleTimeout = 1000;
    theme.timings.mouseSleepTimeout = 60;

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (const step of [50, 50, 50, 50]) mock.timers.tick(step);
    assert.deepStrictEqual(statesSeen, ["sleeping"]);
  });

  it("full mode keeps the yawning entry path", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "full" };
    theme.timings.mouseIdleTimeout = 1000;
    theme.timings.mouseSleepTimeout = 60;

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (const step of [50, 50, 50, 50, 50, 50, 50, 50, 50]) mock.timers.tick(step);
    assert.deepStrictEqual(statesSeen, ["yawning"]);
  });
});
