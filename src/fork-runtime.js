"use strict";

// Builds and wires the fork's four features (mood, music headphones, chatter with
// its speech bubble, and desktop awareness) so main.js only needs one call and a
// handful of handles. Everything the features need from the app comes in through
// `deps` as small functions, so this file never reaches into main.js's variables
// (the pet window and the state change over time, hence getters, not values).
//
// deps: { ipcMain, electron, settings, log, sendToRenderer, iconPath,
//         getWin, getPetWindowBounds, getHitRectScreen, getUpdateBubbleAnchorRect,
//         getNearestWorkArea, guardAlwaysOnTop, keepOutOfTaskbar,
//         isPetHidden, isMiniMode, getState, hasPendingPermissions, getUpdateBubbleWindow,
//         overrides? }   (overrides are test seams: fetch, timers, now, random,
//         BrowserWindow, musicReader, platform, moodFilePath, capturer)

const { createMoodTracker, createMoodEventHandler } = require("./mood");
const { createMoodStore, loadMoodState } = require("./mood-store");
const { createMoodWindow } = require("./mood-window");
const { createMusicDetector } = require("./music");
const { createAwarenessRuntime } = require("./desktop-awareness-runtime");
const { createChatter } = require("./chatter");
const { createChatterBubble, resolveChatterAnchor } = require("./chatter-bubble");

const ANCHOR_WATCH_MS = 1500;

function createForkRuntime(deps) {
  const { settings, sendToRenderer } = deps;
  const o = deps.overrides || {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const get = (key) => settings.get(key);

  // ── Mood: leaky channels fed by hook events, persisted under ~/.clawd. The idle
  // roll in tick.js asks chooseMood() whether to play a moment (see FORK.md).
  const moodTracker = createMoodTracker({
    initialState: loadMoodState(o.moodFilePath),
    log,
    onChange: () => moodStore.scheduleSave(),
  });
  const moodStore = createMoodStore({
    getState: () => moodTracker.serialize(),
    filePath: o.moodFilePath,
    log,
  });
  const handleMoodEvent = createMoodEventHandler({
    tracker: moodTracker,
    getEnabled: () => get("moodEnabled") === true,
  });
  const moodWindow = createMoodWindow({
    electron: deps.electron,
    getValues: () => moodTracker.read(),
    iconPath: deps.iconPath,
  });

  // ── Music: the pet wears headphones while Spotify plays (Windows only; see
  // src/music.js). The renderer remembers the state across theme reloads; a full
  // renderer reload gets it resent from did-finish-load.
  const now = o.now || Date.now;
  const appStartedAt = now();
  const musicDetector = createMusicDetector({
    log,
    reader: o.musicReader,
    platform: o.platform,
    timers: o.timers,
    onChange: (playing) => {
      sendToRenderer("music-state", playing);
      // Music already playing when the app starts is not "just started".
      if (playing && now() - appStartedAt > 60 * 1000) chatter.notify("music-started");
    },
  });

  // ── Chatter: a local Ollama model writes an occasional speech-bubble line (see
  // src/chatter.js). The code picks the moment and the facts; the bubble is a
  // small click-through window above the pet. Its own pref gates it, and the
  // model only ever sees a coarse activity category, never hook payloads.
  function canChatterSpeak() {
    if (deps.isPetHidden() || deps.isMiniMode()) return false;
    if (["dozing", "collapsing", "sleeping"].includes(deps.getState())) return false;
    if (deps.hasPendingPermissions()) return false;
    const updateWin = deps.getUpdateBubbleWindow();
    return !(updateWin && !updateWin.isDestroyed() && updateWin.isVisible());
  }

  // Where the top of the pet's current artwork is, as pixels below the pet window's
  // top edge (null when unknown). The renderer measures it, so the bubble clears
  // whatever the current animation draws above the head (thought bubbles, a laptop
  // screen) without a per-animation table.
  let contentTopOffset = null;
  async function refreshContentTop() {
    try {
      const win = deps.getWin();
      if (!win || win.isDestroyed()) return;
      const top = await win.webContents.executeJavaScript(
        'typeof getDisplayedContentTop === "function" ? getDisplayedContentTop() : null'
      );
      contentTopOffset = Number.isFinite(top) ? top : null;
    } catch {
      contentTopOffset = null;
    }
  }

  // The tight hit box (accessory-aware) or the top of the artwork actually drawn,
  // whichever is higher; the update bubble's "stable" anchor leaves headroom for
  // tall poses and put the bubble far above the pet.
  function getAnchorRect(bounds) {
    return resolveChatterAnchor({
      hit: deps.getHitRectScreen(bounds),
      stable: deps.getUpdateBubbleAnchorRect(bounds),
      contentTopY: contentTopOffset == null ? null : bounds.y + contentTopOffset,
    });
  }

  const chatterBubble = createChatterBubble({
    BrowserWindow: o.BrowserWindow,
    timers: o.timers,
    ipcMain: deps.ipcMain,
    getPetBounds: () => deps.getPetWindowBounds(),
    getAnchorRect,
    getClearance: () => (musicDetector.isPlaying() ? 24 : 6),
    getWorkArea: (bounds) => deps.getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
    guardAlwaysOnTop: deps.guardAlwaysOnTop,
    keepOutOfTaskbar: deps.keepOutOfTaskbar,
    log,
  });

  function repositionChatterBubble() {
    if (!chatterBubble.isVisible()) return;
    // A permission or update bubble appearing while a line is up would overlap it.
    if (!canChatterSpeak()) chatterBubble.hide();
    else chatterBubble.reposition();
  }

  // The animation can change while a line is up (thinking starts), so look again
  // now and then and move the bubble.
  let watchTimer = null;
  function watchAnchor() {
    if (watchTimer) return;
    watchTimer = setInterval(() => {
      if (!chatterBubble.isVisible()) {
        clearInterval(watchTimer);
        watchTimer = null;
        return;
      }
      void refreshContentTop().then(() => repositionChatterBubble());
    }, ANCHOR_WATCH_MS);
    if (typeof watchTimer.unref === "function") watchTimer.unref();
  }

  // Read on every use, so a change in Settings or the menu applies to the next line.
  function getChatterSettings() {
    return {
      enabled: get("chatterEnabled") === true,
      model: get("chatterModel") || "",
      personality: get("chatterPersonality"),
      customPersonality: get("chatterCustomPersonality"),
      checkinMinutes: get("chatterCheckinMinutes"),
      shareSong: get("chatterShareSong") !== false,
      // Desktop awareness widens the context for every request (see chatter.js numCtxAwareness).
      awareness: get("desktopAwareness") === true,
      logScreenLines: get("desktopAwarenessLogLines") === true,
      triggers: {
        checkin: get("chatterTriggerCheckin") !== false,
        tests: get("chatterTriggerTests") !== false,
        error: get("chatterTriggerError") !== false,
        return: get("chatterTriggerReturn") !== false,
        music: get("chatterTriggerMusic") !== false,
      },
    };
  }

  // ── Desktop awareness: opt-in screen captures described to chatter (src/desktop-awareness.js).
  const awarenessRuntime = createAwarenessRuntime({
    settings,
    electron: deps.electron,
    getChatter: () => chatter,
    getChatterSettings,
    canSpeak: canChatterSpeak,
    fetch: o.fetch,
    now: o.now,
    capturer: o.capturer,
    getPetCenter: () => {
      const b = deps.getPetWindowBounds();
      return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
    },
    log,
  });

  const chatter = createChatter({
    log,
    fetch: o.fetch,
    timers: o.timers,
    now: o.now,
    random: o.random,
    getSettings: getChatterSettings,
    getScreen: awarenessRuntime.getScreen,
    getSnapshot: () => ({
      mood: get("moodEnabled") === true ? moodTracker.read() : null,
      musicPlaying: musicDetector.isPlaying(),
      song: musicDetector.getSong(),
    }),
    canSpeak: canChatterSpeak,
    onLine: async ({ text, parts }) => {
      // With bubbles off the line was still written and logged, just not shown.
      if (get("chatterShowBubbles") === false) return;
      try {
        await refreshContentTop();
        log(`chatter anchor content-top=${contentTopOffset == null ? "unmeasured" : Math.round(contentTopOffset)}px state=${deps.getState()}`);
        chatterBubble.show(parts && parts.length > 0 ? parts : text, {
          // No usable setting: the bubble applies its own default.
          durationMs: get("chatterBubbleSeconds") > 0 ? get("chatterBubbleSeconds") * 1000 : undefined,
          font: get("chatterBubbleFont"),
        });
        watchAnchor();
      } catch (err) {
        log(`chatter bubble failed error=${err && err.message}`);
      }
    },
  });

  // Pref changes take effect at once: turning chatter on loads the model, turning
  // it off hides the bubble, a new model is loaded ahead of its first line, and a
  // new interval replaces the pending timer.
  settings.subscribeKey("chatterEnabled", (enabled) => {
    if (enabled === true) {
      void chatter.warm();
    } else {
      // Off means off: hide the bubble and free the model's memory.
      chatterBubble.hide();
      void chatter.unload();
    }
  });
  settings.subscribeKey("chatterModel", () => { void chatter.warm(); });
  settings.subscribeKey("chatterCheckinMinutes", () => chatter.reschedule());

  return {
    moodTracker,
    moodStore,
    handleMoodEvent,
    moodWindow,
    musicDetector,
    chatter,
    chatterBubble,
    awarenessRuntime,
    repositionChatterBubble,
    handleChatterEvent: (input) => chatter.observe(input),
    // After the pet window reloads its page, give it back the state it would have missed.
    resendRendererState() {
      if (musicDetector.isPlaying()) sendToRenderer("music-state", true);
    },
    // The two hotkey actions (main.js maps its shortcut ids onto these).
    shortcuts: {
      // A line on demand; a no-op while chatter is switched off.
      chatterNow: () => {
        if (get("chatterEnabled") === true) void chatter.sayNow();
      },
      // One capture on request; ignored unless Desktop awareness is switched on.
      shareScreen: () => {
        if (get("chatterEnabled") === true && get("desktopAwareness") === true) void chatter.shareScreen();
      },
    },
    // Called at quit, in this order: music, chatter, the anchor watcher, the bubble.
    dispose() {
      musicDetector.stop();
      chatter.stop();
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      chatterBubble.dispose();
    },
  };
}

module.exports = { createForkRuntime, ANCHOR_WATCH_MS };
