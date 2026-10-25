"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  WIDTH,
  HEIGHT,
  DEFAULT_SHOW_MS,
  computeChatterBubbleBounds,
  resolveChatterAnchor,
  createChatterBubble,
} = require("../src/chatter-bubble");

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const read = (file) => fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");

describe("computeChatterBubbleBounds", () => {
  it("centers above the pet with the tail on the pet", () => {
    const box = computeChatterBubbleBounds({ anchorRect: { left: 900, top: 600, right: 1020, bottom: 760 }, workArea });
    assert.strictEqual(box.below, false);
    assert.strictEqual(box.x, 960 - WIDTH / 2);
    assert.strictEqual(box.y, 600 - 4 - HEIGHT);
    assert.strictEqual(box.tailX, WIDTH / 2);
  });

  it("flips below when there is no room above", () => {
    const box = computeChatterBubbleBounds({ anchorRect: { left: 900, top: 40, right: 1020, bottom: 200 }, workArea });
    assert.strictEqual(box.below, true);
    assert.strictEqual(box.y, 204);
  });

  it("slides sideways at the screen edge and keeps the tail aimed at the pet", () => {
    const box = computeChatterBubbleBounds({ anchorRect: { left: 1800, top: 600, right: 1920, bottom: 760 }, workArea });
    assert.strictEqual(box.x, 1920 - 8 - WIDTH);
    assert.ok(box.x + box.width <= workArea.width);
    assert.ok(box.tailX > WIDTH / 2 && box.tailX <= WIDTH - 24);
  });

  it("stays inside a small work area and refuses bad input", () => {
    const small = { x: 0, y: 0, width: 200, height: 100 };
    const box = computeChatterBubbleBounds({ anchorRect: { left: 50, top: 50, right: 90, bottom: 90 }, workArea: small });
    assert.ok(box.x >= 8 && box.y >= 8);
    assert.strictEqual(computeChatterBubbleBounds({ anchorRect: null, workArea }), null);
    assert.strictEqual(computeChatterBubbleBounds({ anchorRect: { left: NaN, top: 0, right: 1, bottom: 1 }, workArea }), null);
  });
});

describe("resolveChatterAnchor", () => {
  const hit = { left: 900, top: 700, right: 1020, bottom: 860 };
  const stable = { left: 880, top: 500, right: 1040, bottom: 880 };

  it("uses the hit box when nothing was measured", () => {
    assert.deepStrictEqual(resolveChatterAnchor({ hit, stable, contentTopY: null }), hit);
    assert.deepStrictEqual(resolveChatterAnchor({ hit, stable }), hit);
  });

  it("rises to the measured top of the artwork when that is higher (thought bubbles, laptop screen)", () => {
    const anchor = resolveChatterAnchor({ hit, stable, contentTopY: 610 });
    assert.strictEqual(anchor.top, 610);
    assert.strictEqual(anchor.left, hit.left);
    assert.strictEqual(anchor.bottom, hit.bottom);
  });

  it("stays on the hit box when the artwork top is lower, and never rises above the theme headroom", () => {
    assert.strictEqual(resolveChatterAnchor({ hit, stable, contentTopY: 760 }).top, 700);
    assert.strictEqual(resolveChatterAnchor({ hit, stable, contentTopY: 100 }).top, 500, "clamped to the stable box");
  });

  it("falls back to the stable box without a hit box, and to null with neither", () => {
    assert.deepStrictEqual(resolveChatterAnchor({ hit: null, stable, contentTopY: null }), stable);
    assert.strictEqual(resolveChatterAnchor({ hit: null, stable: null, contentTopY: 5 }), null);
    assert.strictEqual(resolveChatterAnchor({ hit: { left: NaN, top: 0, right: 1, bottom: 1 }, stable: null }), null);
  });
});

describe("createChatterBubble", () => {
  function setup(overrides = {}) {
    const windows = [];
    class FakeWindow {
      constructor(options) {
        this.options = options;
        this.sent = [];
        this.bounds = null;
        this.shown = 0;
        this.destroyed = false;
        this.ignoreMouse = null;
        this.loadedCallbacks = [];
        this.webContents = {
          id: windows.length + 1,
          once: (event, cb) => { if (event === "did-finish-load") this.loadedCallbacks.push(cb); },
          send: (channel, payload) => this.sent.push({ channel, payload }),
        };
        windows.push(this);
      }
      isDestroyed() { return this.destroyed; }
      setIgnoreMouseEvents(value, options) { this.ignoreMouse = { value, forward: !!(options && options.forward) }; }
      setAlwaysOnTop() {}
      setBounds(bounds) { this.bounds = bounds; }
      showInactive() { this.shown += 1; }
      loadFile() {}
      on() {}
      destroy() { this.destroyed = true; }
      finishLoad() { for (const cb of this.loadedCallbacks) cb(); }
    }
    const handles = [];
    const timers = {
      setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; handles.push(h); return h; },
      clearTimeout: (h) => { if (h) h.cleared = true; },
      fire: () => { const h = handles.find((x) => !x.cleared && !x.fired); if (h) { h.fired = true; h.fn(); } },
    };
    const ipcHandlers = new Map();
    const ipcMain = {
      on: (channel, fn) => ipcHandlers.set(channel, fn),
      removeListener: (channel, fn) => { if (ipcHandlers.get(channel) === fn) ipcHandlers.delete(channel); },
    };
    const bubble = createChatterBubble({
      BrowserWindow: FakeWindow,
      ipcMain,
      timers,
      getPetBounds: () => ({ x: 900, y: 700, width: 200, height: 200 }),
      getAnchorRect: () => ({ left: 930, top: 720, right: 1070, bottom: 890 }),
      getWorkArea: () => workArea,
      ...overrides,
    });
    return { bubble, windows, timers, handles, ipcHandlers };
  }

  it("never takes focus or clicks, and queues the line until the page has loaded", () => {
    const { bubble, windows } = setup();
    assert.strictEqual(bubble.show("Hello there, friend."), true);
    const win = windows[0];
    assert.strictEqual(win.options.focusable, false);
    assert.strictEqual(win.options.transparent, true);
    assert.strictEqual(win.options.skipTaskbar, true);
    assert.strictEqual(win.options.webPreferences.contextIsolation, true);
    assert.strictEqual(win.options.webPreferences.nodeIntegration, false);
    assert.deepStrictEqual(win.ignoreMouse, { value: true, forward: true });
    assert.strictEqual(win.shown, 1, "showInactive, not show");
    assert.strictEqual(win.sent.length, 0);
    win.finishLoad();
    assert.strictEqual(win.sent[0].channel, "chatter-bubble-show");
    assert.strictEqual(win.sent[0].payload.text, "Hello there, friend.");
    assert.strictEqual(win.sent[0].payload.below, false);
    assert.ok(bubble.isVisible());
  });

  it("fades out after its reading time, then destroys the window", () => {
    const { bubble, windows, timers, handles } = setup();
    bubble.show("Hello there, friend.");
    const win = windows[0];
    win.finishLoad();
    assert.strictEqual(handles[0].ms, DEFAULT_SHOW_MS);
    timers.fire();
    assert.strictEqual(win.sent.at(-1).channel, "chatter-bubble-hide");
    assert.strictEqual(win.destroyed, false);
    timers.fire();
    assert.strictEqual(win.destroyed, true);
    assert.strictEqual(bubble.isVisible(), false);
  });

  it("shows a line for the requested time, and ignores nonsense durations", () => {
    const custom = setup();
    custom.bubble.show("Hello there, friend.", { durationMs: 20000 });
    assert.strictEqual(custom.handles[0].ms, 20000);
    const bad = setup();
    bad.bubble.show("Hello there, friend.", { durationMs: -5 });
    assert.strictEqual(bad.handles[0].ms, DEFAULT_SHOW_MS);
    assert.ok(DEFAULT_SHOW_MS >= 10000, "long enough to actually read");
  });

  it("takes clicks only while the pointer is over the bubble, and a click dismisses it", () => {
    const { bubble, windows, ipcHandlers } = setup();
    bubble.show("Hello there, friend.");
    const win = windows[0];
    win.finishLoad();
    const own = { sender: win.webContents };
    ipcHandlers.get("chatter-bubble-interactive")(own, true);
    assert.deepStrictEqual(win.ignoreMouse, { value: false, forward: false });
    ipcHandlers.get("chatter-bubble-interactive")(own, false);
    assert.deepStrictEqual(win.ignoreMouse, { value: true, forward: true });
    ipcHandlers.get("chatter-bubble-dismiss")(own);
    assert.strictEqual(win.destroyed, true);
    assert.strictEqual(bubble.isVisible(), false);
  });

  it("ignores interactive and dismiss messages from any other sender", () => {
    const { bubble, windows, ipcHandlers } = setup();
    bubble.show("Hello there, friend.");
    const win = windows[0];
    win.finishLoad();
    const stranger = { sender: { id: 999 } };
    ipcHandlers.get("chatter-bubble-interactive")(stranger, true);
    assert.deepStrictEqual(win.ignoreMouse, { value: true, forward: true });
    ipcHandlers.get("chatter-bubble-dismiss")(stranger);
    ipcHandlers.get("chatter-bubble-dismiss")({});
    assert.strictEqual(win.destroyed, false);
    assert.ok(bubble.isVisible());
  });

  it("dispose() removes the listeners and the window", () => {
    const { bubble, windows, ipcHandlers } = setup();
    bubble.show("Hello there, friend.");
    assert.strictEqual(ipcHandlers.size, 2);
    bubble.dispose();
    assert.strictEqual(ipcHandlers.size, 0);
    assert.strictEqual(windows[0].destroyed, true);
  });

  it("a new line replaces the old one without leaking timers or windows", () => {
    const { bubble, windows, handles } = setup();
    bubble.show("First line here.");
    windows[0].finishLoad();
    bubble.show("Second line here.");
    assert.strictEqual(windows.length, 1, "the live window is reused");
    assert.ok(handles[0].cleared, "the first hide timer is cancelled");
    assert.strictEqual(windows[0].sent.at(-1).payload.text, "Second line here.");
  });

  it("follows the pet quietly while shown, and hide() destroys it", () => {
    let petX = 900;
    const { bubble, windows } = setup({
      getPetBounds: () => ({ x: petX, y: 700, width: 200, height: 200 }),
      getAnchorRect: (b) => ({ left: b.x + 30, top: 720, right: b.x + 170, bottom: 890 }),
    });
    bubble.show("Hello there, friend.");
    windows[0].finishLoad();
    const before = windows[0].bounds.x;
    petX = 1200;
    bubble.reposition();
    assert.ok(windows[0].bounds.x > before);
    assert.strictEqual(windows[0].sent.at(-1).payload.quiet, true);
    bubble.hide();
    assert.strictEqual(windows[0].destroyed, true);
    bubble.reposition(); // nothing shown: must not throw
  });

  it("shows nothing for an empty line or when the pet cannot be placed", () => {
    const { bubble, windows } = setup();
    assert.strictEqual(bubble.show("   "), false);
    assert.strictEqual(windows.length, 0);
    const lost = setup({ getAnchorRect: () => null });
    assert.strictEqual(lost.bubble.show("Hello there."), false);
    assert.strictEqual(lost.windows.length, 0);
  });
});

describe("chatter bubble page and wiring", () => {
  it("renders model text with textContent only, under a strict CSP", () => {
    const html = read("chatter-bubble.html");
    assert.ok(html.includes("textEl.textContent = data.text"));
    assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  });

  it("preload exposes two listeners and two fixed-channel senders, nothing else", () => {
    const preload = read("preload-chatter-bubble.js");
    assert.match(preload, /onShow:/);
    assert.match(preload, /onHide:/);
    assert.deepStrictEqual(
      [...preload.matchAll(/ipcRenderer\.send\("([a-z-]+)"/g)].map((m) => m[1]),
      ["chatter-bubble-interactive", "chatter-bubble-dismiss"]
    );
    assert.strictEqual((preload.match(/ipcRenderer\.invoke/g) || []).length, 0);
  });

  it("the page makes only the bubble clickable", () => {
    const html = read("chatter-bubble.html");
    assert.match(html, /html, body \{[^}]*pointer-events: none/s);
    assert.match(html, /#bubble \{[^}]*pointer-events: auto/s);
    assert.match(html, /setInteractive\(true\)/);
    assert.match(html, /dismiss\(\)/);
  });

  it("main wires chatter with its own settings, tap, music hook and cleanup", () => {
    const main = read("main.js");
    assert.match(main, /getSettings: getChatterSettings/);
    for (const key of [
      "chatterEnabled", "chatterModel", "chatterPersonality", "chatterCustomPersonality", "chatterCheckinMinutes",
      "chatterTriggerCheckin", "chatterTriggerTests", "chatterTriggerError", "chatterTriggerReturn", "chatterTriggerMusic",
    ]) {
      assert.ok(main.includes(`get("${key}")`), `${key} is read through getChatterSettings`);
    }
    assert.match(main, /durationMs: \(_settingsController\.get\("chatterBubbleSeconds"\) \|\| 12\) \* 1000/);
    assert.match(main, /handleChatterEvent: \(input\) => handleChatterEvent\(input\)/);
    assert.match(main, /chatter\.notify\("music-started"\)/);
    assert.match(main, /if \(_settingsController\.get\("chatterEnabled"\) === true\) void chatter\.warm\(\)/);
    assert.match(main, /_chatterBubble\.dispose\(\)/);
    assert.match(main, /repositionChatterBubble: \(\) => repositionChatterBubble\(\)/);
    assert.match(main, /createChatterBubble\(\{\s*ipcMain,/);
  });

  it("pref changes take effect at runtime", () => {
    const main = read("main.js");
    // Off means off: hide the bubble and free the model's memory.
    assert.match(main, /subscribeKey\("chatterEnabled", \(enabled\) => \{\s*if \(enabled === true\) \{\s*void chatter\.warm\(\);\s*\} else \{[^}]*_chatterBubble\.hide\(\);\s*void chatter\.unload\(\);/);
    assert.match(main, /subscribeKey\("chatterModel", \(\) => \{ void chatter\.warm\(\); \}\)/);
    assert.match(main, /subscribeKey\("chatterCheckinMinutes", \(\) => chatter\.reschedule\(\)\)/);
    // The tray and context menus rebuild when the checkbox changes.
    assert.match(read("settings-effect-router.js"), /"chatterEnabled",/);
    assert.match(main, /set chatterEnabled\(v\) \{ _settingsController\.applyUpdate\("chatterEnabled", !!v\); \}/);
  });

  it("the bubble option, the hotkey and the placement are wired", () => {
    const main = read("main.js");
    // Bubbles off: the line is still written and logged, just not shown.
    assert.match(main, /if \(_settingsController\.get\("chatterShowBubbles"\) === false\) return;\s*try \{\s*await refreshChatterContentTop\(\);[^\n]*\n\s*sessionLog\(`chatter anchor[^\n]*\n\s*_chatterBubble\.show\(/);
    assert.match(main, /chatterNow: \(\) => \{\s*if \(_settingsController\.get\("chatterEnabled"\) === true\) void chatter\.sayNow\(\);/);
    // Anchored on the tight hit box, with extra room while the headphones are on.
    assert.match(main, /getAnchorRect: \(bounds\) => getChatterAnchorRect\(bounds\)/);
    assert.match(main, /executeJavaScript\(\s*'typeof getDisplayedContentTop === "function" \? getDisplayedContentTop\(\) : null'/);
    assert.match(main, /if \(chatterWatchTimer\) clearInterval\(chatterWatchTimer\);/);
    assert.match(main, /getClearance: \(\) => \(musicDetector\.isPlaying\(\) \? 24 : 6\)/);
    const { SHORTCUT_ACTIONS } = require("../src/shortcut-actions");
    assert.strictEqual(SHORTCUT_ACTIONS.chatterNow.persistent, true);
    assert.strictEqual(SHORTCUT_ACTIONS.chatterNow.defaultAccelerator, null, "unassigned until the user picks a key");
  });

  it("the bubble adds the clearance to its gap above the pet", () => {
    const { createChatterBubble: make } = require("../src/chatter-bubble");
    let bounds = null;
    class W {
      constructor() { this.webContents = { once() {}, send() {} }; }
      isDestroyed() { return false; }
      setIgnoreMouseEvents() {}
      setAlwaysOnTop() {}
      setBounds(b) { bounds = b; }
      showInactive() {}
      loadFile() {}
      on() {}
      destroy() {}
    }
    const place = (clearance) => {
      const bubble = make({
        BrowserWindow: W,
        timers: { setTimeout: () => ({}), clearTimeout() {} },
        getPetBounds: () => ({ x: 900, y: 700, width: 200, height: 200 }),
        getAnchorRect: () => ({ left: 930, top: 720, right: 1070, bottom: 890 }),
        getWorkArea: () => workArea,
        getClearance: () => clearance,
      });
      bubble.show("Hello there, friend.");
      return bounds.y + bounds.height;
    };
    assert.strictEqual(place(0), 720 - 4);
    assert.strictEqual(place(24), 720 - 4 - 24);
  });

  it("the model list goes through the trusted settings IPC", () => {
    const ipc = read("settings-ipc.js");
    assert.match(ipc, /handle\("settings:chatter-models", async \(event\) => \{\s*if \(!isTrustedSettingsEvent\(event\)\)/);
    assert.match(read("preload-settings.js"), /getChatterModels: \(\) => ipcRenderer\.invoke\("settings:chatter-models"\)/);
    assert.match(read("main.js"), /listChatterModels: \(\) => chatter\.listModels\(\)/);
  });

  it("the state route gives chatter its own call, skipping headless sessions", () => {
    const route = read("server-route-state.js");
    assert.match(route, /sessionUpdateApplied && !effHeadless && typeof ctx\.handleChatterEvent === "function"/);
  });

  it("the pref exists and is validated", () => {
    assert.match(read("prefs.js"), /chatterEnabled: \{ type: "boolean", default: false \}/);
    assert.match(read("settings-actions.js"), /chatterEnabled: requireBoolean\("chatterEnabled"\)/);
  });
});
