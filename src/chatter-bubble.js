"use strict";

// The pet's speech bubble: a small, click-through, non-focusable window that
// shows one line of chatter above (or, if there is no room, below) the pet and
// fades out on its own. Created per line and destroyed after it hides, so it
// holds no renderer process between lines. The text comes from a language
// model and is rendered with textContent only (see chatter-bubble.html).
// The window ignores the mouse (forwarding moves) until the pointer is over the
// bubble itself; a click there dismisses the line.

const path = require("path");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";

const WIDTH = 300;
const HEIGHT = 120;
const GAP = 4;
const EDGE_MARGIN = 8;
// How long a line stays up when the caller does not say (the setting overrides it).
const DEFAULT_SHOW_MS = 12 * 1000;
const FADE_MS = 300;

function isFiniteRect(rect) {
  return !!rect && ["left", "top", "right", "bottom"].every((key) => Number.isFinite(rect[key]));
}

// Centered over the pet, flipped below when there is no room above, clamped to
// the work area. `tailX` is where the tail points, relative to the window, so
// it still aims at the pet when the window had to slide sideways.
function computeChatterBubbleBounds({ anchorRect, workArea, width = WIDTH, height = HEIGHT, gap = GAP, edgeMargin = EDGE_MARGIN }) {
  if (!isFiniteRect(anchorRect) || !workArea) return null;
  const cx = Math.round((anchorRect.left + anchorRect.right) / 2);
  const minX = workArea.x + edgeMargin;
  const maxX = workArea.x + workArea.width - edgeMargin - width;
  const x = Math.round(maxX < minX ? minX : Math.max(minX, Math.min(cx - width / 2, maxX)));
  const minY = workArea.y + edgeMargin;
  const maxY = workArea.y + workArea.height - edgeMargin - height;
  const aboveY = Math.round(anchorRect.top - gap - height);
  const below = aboveY < minY;
  const rawY = below ? Math.round(anchorRect.bottom + gap) : aboveY;
  const y = maxY < minY ? minY : Math.max(minY, Math.min(rawY, maxY));
  const tailX = Math.max(24, Math.min(cx - x, width - 24));
  return { x, y, width, height, below, tailX };
}

// Which rect the bubble stands on: the pet's hit box (or the theme's stable box),
// raised to the top of the artwork the renderer measured when that is higher
// (thought bubbles, a laptop screen), but never above the theme's own headroom.
function resolveChatterAnchor({ hit, stable, contentTopY }) {
  const base = isFiniteRect(hit) ? hit : (isFiniteRect(stable) ? stable : null);
  if (!base) return null;
  if (!Number.isFinite(contentTopY)) return base;
  let top = Math.min(base.top, contentTopY);
  if (isFiniteRect(stable)) top = Math.max(stable.top, top);
  return { ...base, top };
}

function createChatterBubble(ctx = {}) {
  const BrowserWindow = ctx.BrowserWindow || require("electron").BrowserWindow;
  const timers = ctx.timers || { setTimeout, clearTimeout };
  const ipcMain = ctx.ipcMain || null;
  const disposers = [];
  const log = typeof ctx.log === "function" ? ctx.log : () => {};
  let win = null;
  let loaded = false;
  let pending = null;
  let showTimer = null;
  let fadeTimer = null;
  let current = null;

  function live() {
    return !!(win && !win.isDestroyed());
  }

  function placement() {
    const petBounds = ctx.getPetBounds();
    if (!petBounds) return null;
    // Extra room for things drawn above the pet that the anchor does not know
    // about (the headphones and their notes while music plays).
    const clearance = typeof ctx.getClearance === "function" ? Math.max(0, Number(ctx.getClearance()) || 0) : 0;
    return computeChatterBubbleBounds({
      anchorRect: ctx.getAnchorRect(petBounds),
      workArea: ctx.getWorkArea(petBounds),
      gap: GAP + clearance,
    });
  }

  function clearTimers() {
    if (showTimer) timers.clearTimeout(showTimer);
    if (fadeTimer) timers.clearTimeout(fadeTimer);
    showTimer = fadeTimer = null;
  }

  function destroy() {
    clearTimers();
    const old = win;
    win = null;
    loaded = false;
    pending = null;
    current = null;
    if (old && !old.isDestroyed()) old.destroy();
  }

  function create() {
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: !isMac,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-chatter-bubble.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    // Clicks pass through to whatever is underneath; moves are forwarded so the
    // page can tell when the pointer is over the bubble (see setInteractive).
    win.setIgnoreMouseEvents(true, { forward: true });
    if (isWin) win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    win.webContents.once("did-finish-load", () => {
      loaded = true;
      if (pending) {
        win.webContents.send("chatter-bubble-show", pending);
        pending = null;
      }
    });
    win.on("closed", () => {
      win = null;
      loaded = false;
    });
    win.loadFile(path.join(__dirname, "chatter-bubble.html"));
    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(win);
    return win;
  }

  // Only the bubble's own window may drive these, and only while it is the live one.
  function fromBubble(event) {
    return live() && event && event.sender === win.webContents;
  }

  if (ipcMain) {
    const on = (channel, listener) => {
      ipcMain.on(channel, listener);
      disposers.push(() => ipcMain.removeListener(channel, listener));
    };
    on("chatter-bubble-interactive", (event, interactive) => {
      if (!fromBubble(event)) return;
      if (interactive === true) win.setIgnoreMouseEvents(false);
      else win.setIgnoreMouseEvents(true, { forward: true });
    });
    on("chatter-bubble-dismiss", (event) => {
      if (fromBubble(event)) destroy();
    });
  }

  function place(box) {
    win.setBounds({ x: box.x, y: box.y, width: box.width, height: box.height });
  }

  function payloadFor(text, box) {
    return { text, below: box.below, tailX: box.tailX };
  }

  return {
    // Show one line. Returns false when there is nowhere sensible to put it.
    show(text, options = {}) {
      const line = typeof text === "string" ? text.trim() : "";
      if (!line) return false;
      const box = placement();
      if (!box) return false;
      clearTimers();
      if (!live()) create();
      place(box);
      current = { text: line };
      const payload = payloadFor(line, box);
      if (loaded) win.webContents.send("chatter-bubble-show", payload);
      else pending = payload;
      win.showInactive();
      if (typeof ctx.keepOutOfTaskbar === "function") ctx.keepOutOfTaskbar(win);
      const ms = Number.isFinite(options.durationMs) && options.durationMs > 0 ? options.durationMs : DEFAULT_SHOW_MS;
      showTimer = timers.setTimeout(() => {
        showTimer = null;
        if (live() && loaded) win.webContents.send("chatter-bubble-hide");
        fadeTimer = timers.setTimeout(destroy, FADE_MS);
      }, ms);
      log(`chatter bubble shown ms=${ms} below=${box.below}`);
      return true;
    },
    hide() {
      if (live()) destroy();
    },
    // Follow the pet while a line is up.
    reposition() {
      if (!live() || !current) return;
      const box = placement();
      if (!box) return;
      place(box);
      if (loaded) win.webContents.send("chatter-bubble-show", { ...payloadFor(current.text, box), quiet: true });
    },
    isVisible: () => live() && current !== null,
    cleanup: destroy,
    dispose() {
      while (disposers.length) disposers.pop()();
      destroy();
    },
  };
}

module.exports = {
  WIDTH,
  HEIGHT,
  DEFAULT_SHOW_MS,
  computeChatterBubbleBounds,
  resolveChatterAnchor,
  createChatterBubble,
};
