"use strict";

const { BrowserWindow } = require("electron");
const path = require("path");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

const HUD_WIDTH = 240;
const HUD_HEIGHT = 28;
const HUD_PET_GAP = 4;
const BUBBLE_GAP = 6;
const EDGE_MARGIN = 8;
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;

function clampToWorkArea(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function computeSessionHudBounds({ hitRect, workArea, width = HUD_WIDTH, height = HUD_HEIGHT }) {
  if (!hitRect || !workArea) return null;
  const hitTop = Math.round(hitRect.top);
  const hitBottom = Math.round(hitRect.bottom);
  const hitCx = Math.round((hitRect.left + hitRect.right) / 2);

  const minX = Math.round(workArea.x);
  const maxX = Math.round(workArea.x + workArea.width - width);
  const x = clampToWorkArea(hitCx - Math.round(width / 2), minX, maxX);

  const belowY = hitBottom + HUD_PET_GAP;
  const belowMax = workArea.y + workArea.height - EDGE_MARGIN;
  if (belowY + height <= belowMax) {
    return {
      bounds: { x, y: belowY, width, height },
      flippedAbove: false,
    };
  }

  const minY = Math.round(workArea.y + EDGE_MARGIN);
  const maxY = Math.round(workArea.y + workArea.height - EDGE_MARGIN - height);
  const aboveY = hitTop - height - HUD_PET_GAP;
  return {
    bounds: {
      x,
      y: clampToWorkArea(aboveY, minY, maxY),
      width,
      height,
    },
    flippedAbove: true,
  };
}

function deferMacFloatingVisibility(ctx, win) {
  if (!isMac || !win || win.isDestroyed()) return;
  const deferUntil = Date.now() + MAC_FLOATING_TOPMOST_DELAY_MS;
  win.__clawdMacDeferredVisibilityUntil = deferUntil;
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    if (win.__clawdMacDeferredVisibilityUntil === deferUntil) {
      delete win.__clawdMacDeferredVisibilityUntil;
    }
    if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  }, MAC_FLOATING_TOPMOST_DELAY_MS);
}

module.exports = function initSessionHud(ctx) {
  let hudWindow = null;
  let didFinishLoad = false;
  let latestSnapshot = null;
  let hudFlippedAbove = false;
  let lastReservedOffset = 0;

  function getCurrentSnapshot() {
    return typeof ctx.getSessionSnapshot === "function"
      ? ctx.getSessionSnapshot()
      : { sessions: [], groups: [], orderedIds: [], menuOrderedIds: [] };
  }

  function hasVisibleSessions(snapshot) {
    const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
    return sessions.some((session) => session && !session.headless);
  }

  function shouldShow(snapshot = latestSnapshot) {
    if (!snapshot) return false;
    if (ctx.sessionHudEnabled === false) return false;
    if (ctx.petHidden) return false;
    if (typeof ctx.getMiniMode === "function" && ctx.getMiniMode()) return false;
    if (typeof ctx.getMiniTransitioning === "function" && ctx.getMiniTransitioning()) return false;
    return hasVisibleSessions(snapshot);
  }

  function sendSnapshot(snapshot = latestSnapshot) {
    if (!snapshot || !hudWindow || hudWindow.isDestroyed() || !didFinishLoad) return;
    if (!hudWindow.webContents || hudWindow.webContents.isDestroyed()) return;
    hudWindow.webContents.send("session-hud:session-snapshot", snapshot);
  }

  function sendI18n() {
    if (!hudWindow || hudWindow.isDestroyed() || !didFinishLoad) return;
    if (!hudWindow.webContents || hudWindow.webContents.isDestroyed()) return;
    if (typeof ctx.getI18n !== "function") return;
    hudWindow.webContents.send("session-hud:lang-change", ctx.getI18n());
  }

  function ensureSessionHud() {
    if (hudWindow && !hudWindow.isDestroyed()) return hudWindow;
    if (!ctx.win || ctx.win.isDestroyed()) return null;

    didFinishLoad = false;
    hudFlippedAbove = false;
    hudWindow = new BrowserWindow({
      parent: ctx.win,
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: !isMac,
      focusable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-session-hud.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    hudWindow.setIgnoreMouseEvents(true);
    if (isWin) hudWindow.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(hudWindow);

    hudWindow.loadFile(path.join(__dirname, "session-hud.html"));
    hudWindow.webContents.once("did-finish-load", () => {
      didFinishLoad = true;
      sendI18n();
      syncSessionHud();
    });
    hudWindow.on("closed", () => {
      hudWindow = null;
      didFinishLoad = false;
      hudFlippedAbove = false;
      notifyReservedOffsetIfChanged();
    });

    return hudWindow;
  }

  function hideSessionHud() {
    hudFlippedAbove = false;
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide();
    notifyReservedOffsetIfChanged();
  }

  function computeBounds() {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = typeof ctx.getPetWindowBounds === "function" ? ctx.getPetWindowBounds() : null;
    if (!petBounds) return null;
    const hitRect = typeof ctx.getHitRectScreen === "function"
      ? ctx.getHitRectScreen(petBounds)
      : null;
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    return computeSessionHudBounds({ hitRect, workArea });
  }

  function showSessionHud(win) {
    if (!win || win.isDestroyed() || !didFinishLoad) return;
    if (!win.isVisible()) {
      win.showInactive();
      if (isLinux) win.setSkipTaskbar(true);
      if (isMac) deferMacFloatingVisibility(ctx, win);
      else if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
    }
    notifyReservedOffsetIfChanged();
  }

  function syncSessionHud(snapshot = latestSnapshot || getCurrentSnapshot(), options = {}) {
    latestSnapshot = snapshot;
    if (!shouldShow(snapshot)) {
      hideSessionHud();
      return;
    }

    const win = ensureSessionHud();
    if (!win || win.isDestroyed()) return;

    const computed = computeBounds();
    if (!computed) {
      hideSessionHud();
      return;
    }
    hudFlippedAbove = !!computed.flippedAbove;
    win.setBounds(computed.bounds);
    if (options.sendSnapshot !== false) sendSnapshot(snapshot);
    showSessionHud(win);
  }

  function broadcastSessionSnapshot(snapshot) {
    syncSessionHud(snapshot);
  }

  function repositionSessionHud() {
    syncSessionHud(latestSnapshot || getCurrentSnapshot(), { sendSnapshot: false });
  }

  function getHudReservedOffset() {
    return readHudReservedOffset();
  }

  function readHudReservedOffset() {
    if (!hudWindow || hudWindow.isDestroyed() || !hudWindow.isVisible()) return 0;
    if (hudFlippedAbove) return 0;
    return HUD_PET_GAP + HUD_HEIGHT + BUBBLE_GAP;
  }

  function notifyReservedOffsetIfChanged() {
    const next = readHudReservedOffset();
    if (next === lastReservedOffset) return;
    lastReservedOffset = next;
    if (typeof ctx.onReservedOffsetChange === "function") ctx.onReservedOffsetChange(next);
  }

  function cleanup() {
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.destroy();
    hudWindow = null;
    didFinishLoad = false;
    hudFlippedAbove = false;
    notifyReservedOffsetIfChanged();
  }

  return {
    ensureSessionHud,
    broadcastSessionSnapshot,
    repositionSessionHud,
    syncSessionHud,
    sendI18n,
    getHudReservedOffset,
    cleanup,
    getWindow: () => hudWindow,
  };
};

module.exports.__test = {
  computeSessionHudBounds,
  constants: {
    HUD_WIDTH,
    HUD_HEIGHT,
    HUD_PET_GAP,
    BUBBLE_GAP,
    EDGE_MARGIN,
  },
};
