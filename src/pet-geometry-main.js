"use strict";

const defaultHitGeometry = require("./hit-geometry");
const {
  getThemeMarginBox: defaultGetThemeMarginBox,
  computeThemeAnchorRect: defaultComputeThemeAnchorRect,
} = require("./visible-margins");
const { resolveAccessoryAwareHitBox } = require("./pet-accessory-hitbox");
const {
  commitPetAccessoryPayload,
  getPetAccessoryPayloadSnapshot,
} = require("./pet-accessory-state");

function createPetGeometryMain(options = {}) {
  const hitGeometry = options.hitGeometry || defaultHitGeometry;
  const getThemeMarginBox = options.getThemeMarginBox || defaultGetThemeMarginBox;
  const computeThemeAnchorRect = options.computeThemeAnchorRect || defaultComputeThemeAnchorRect;
  const getActiveTheme = options.getActiveTheme || (() => null);
  const getCurrentState = options.getCurrentState || (() => null);
  const getCurrentSvg = options.getCurrentSvg || (() => null);
  const getCurrentHitBox = options.getCurrentHitBox || (() => null);
  const getCurrentAccessoryPayload = options.getCurrentAccessoryPayload || (() => null);
  const getMiniMode = options.getMiniMode || (() => false);
  const getMiniPeekOffset = options.getMiniPeekOffset || (() => 0);
  const getMiniEdge = typeof options.getMiniEdge === "function" ? options.getMiniEdge : null;
  const injectedScreen = options.screen || null;

  function getCurrentFile(theme) {
    return getCurrentSvg()
      || (theme && theme.states && theme.states.idle && theme.states.idle[0])
      || null;
  }

  function getFullAssetRect(bounds) {
    return { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
  }

  function getFullHitRect(bounds) {
    return {
      left: bounds.x,
      top: bounds.y,
      right: bounds.x + bounds.width,
      bottom: bounds.y + bounds.height,
    };
  }

  function outwardRound(rect) {
    if (!rect || ![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) return rect;
    return {
      left: Math.floor(rect.left),
      top: Math.floor(rect.top),
      right: Math.ceil(rect.right),
      bottom: Math.ceil(rect.bottom),
    };
  }

  function resolveScreenApi() {
    if (injectedScreen) return injectedScreen;
    try {
      const electron = require("electron");
      return electron && typeof electron === "object" ? electron.screen : null;
    } catch {
      return null;
    }
  }

  function resolveMiniEdge(bounds) {
    if (getMiniEdge) {
      const explicit = getMiniEdge(bounds);
      if (explicit === "left" || explicit === "right") return explicit;
    }
    const screen = resolveScreenApi();
    if (!screen || typeof screen.getDisplayMatching !== "function") return "right";
    try {
      const display = screen.getDisplayMatching(bounds);
      const wa = display && display.workArea;
      if (!wa || ![wa.x, wa.width].every(Number.isFinite)) return "right";
      const leftDistance = Math.abs(bounds.x - wa.x);
      const rightDistance = Math.abs((bounds.x + bounds.width) - (wa.x + wa.width));
      return leftDistance <= rightDistance ? "left" : "right";
    } catch {
      return "right";
    }
  }

  function getCanonicalAccessoryPayload(theme) {
    const current = getPetAccessoryPayloadSnapshot(theme);
    if (current) return current.payload;
    // First geometry pass after startup/theme switch seeds from the same main
    // resolver used to construct renderer config. Same-theme clock changes do
    // not reach this fallback; Settings/holiday delivery commits explicitly.
    return commitPetAccessoryPayload(getCurrentAccessoryPayload(), theme).payload;
  }

  function getObjRect(bounds) {
    if (!bounds) return null;
    const theme = getActiveTheme();
    const state = getCurrentState();
    const file = getCurrentFile(theme);
    return hitGeometry.getAssetRectScreen(theme, bounds, state, file) || getFullAssetRect(bounds);
  }

  function getAssetPointerPayload(bounds, point) {
    if (!bounds || !point) return null;
    const theme = getActiveTheme();
    if (!theme) return null;
    const state = getCurrentState();
    const file = getCurrentFile(theme);
    return hitGeometry.getAssetPointerPayload(theme, bounds, state, file, point);
  }

  function getHitRectScreen(bounds) {
    if (!bounds) return null;
    const theme = getActiveTheme();
    const state = getCurrentState();
    const file = getCurrentFile(theme);
    const miniMode = !!getMiniMode();
    const edge = miniMode ? resolveMiniEdge(bounds) : "right";
    const miniFlipAssets = !!(theme && theme.miniMode && theme.miniMode.flipAssets);
    const mirrorX = miniMode && ((edge === "left") !== miniFlipAssets);
    const resolveViewBox = typeof hitGeometry.resolveViewBox === "function"
      ? hitGeometry.resolveViewBox
      : defaultHitGeometry.resolveViewBox;
    const viewBox = resolveViewBox(theme, state, file);
    const hitBox = resolveAccessoryAwareHitBox(
      theme,
      state,
      file,
      getCurrentHitBox(),
      getCanonicalAccessoryPayload(theme),
      { viewBox, mirrorX }
    );
    const hit = hitGeometry.getHitRectScreen(
      theme,
      bounds,
      state,
      file,
      hitBox,
      {
        padX: miniMode ? getMiniPeekOffset() : 0,
        padY: miniMode ? 8 : 0,
      }
    );
    return outwardRound(hit) || getFullHitRect(bounds);
  }

  function getUpdateBubbleAnchorRect(bounds) {
    if (!bounds) return getHitRectScreen(bounds);
    const theme = getActiveTheme();
    if (!theme) return getHitRectScreen(bounds);

    const stableAnchor = computeThemeAnchorRect(theme, bounds);
    if (stableAnchor) return stableAnchor;

    const box = getThemeMarginBox(theme);
    const currentFile = getCurrentSvg();
    if (box && currentFile) {
      const currentAnchor = computeThemeAnchorRect(theme, bounds, {
        box,
        state: getCurrentState(),
        file: currentFile,
      });
      if (currentAnchor) return currentAnchor;
    }

    return getHitRectScreen(bounds);
  }

  function getSessionHudAnchorRect(bounds) {
    if (!bounds) return null;
    const theme = getActiveTheme();
    if (!theme) return null;
    const box = getThemeMarginBox(theme);
    if (!box) return null;
    return computeThemeAnchorRect(theme, bounds, { box });
  }

  return {
    getObjRect,
    getAssetPointerPayload,
    getHitRectScreen,
    getUpdateBubbleAnchorRect,
    getSessionHudAnchorRect,
  };
}

module.exports = createPetGeometryMain;
