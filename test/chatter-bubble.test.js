"use strict";

const { describe, it } = require("node:test");
const { CHATTER_FONTS, CHATTER_FONT_IDS, resolveChatterFont } = require("../src/chatter-fonts");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  WIDTH,
  HEIGHT,
  DEFAULT_SHOW_MS,
  TYPE_CHAR_MS,
  MIN_HOLD_MS,
  holdTimes,
  computeChatterBubbleBounds,
  resolveChatterAnchor,
  createChatterBubble,
} = require("../src/chatter-bubble");

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

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
    assert.strictEqual(win.sent[0].payload.font.size, 14, "no font chosen: the default face");
    assert.ok(bubble.isVisible());
  });

  it("fades out after its reading time, then destroys the window", () => {
    const { bubble, windows, timers, handles } = setup();
    bubble.show("Hello there, friend.");
    const win = windows[0];
    win.finishLoad();
    assert.strictEqual(handles[0].ms, "Hello there, friend.".length * TYPE_CHAR_MS + DEFAULT_SHOW_MS, "typing first, then the hold");
    timers.fire();
    assert.strictEqual(win.sent.at(-1).channel, "chatter-bubble-hide");
    assert.strictEqual(win.destroyed, false);
    timers.fire();
    assert.strictEqual(win.destroyed, true);
    assert.strictEqual(bubble.isVisible(), false);
  });

  it("shows a reply for the requested total time, and ignores nonsense durations", () => {
    const text = "Hello there, friend.";
    const custom = setup();
    custom.bubble.show(text, { durationMs: 20000 });
    assert.strictEqual(custom.handles[0].ms, text.length * TYPE_CHAR_MS + 20000);
    const bad = setup();
    bad.bubble.show(text, { durationMs: -5 });
    assert.strictEqual(bad.handles[0].ms, text.length * TYPE_CHAR_MS + DEFAULT_SHOW_MS);
    assert.ok(DEFAULT_SHOW_MS >= 10000, "long enough to actually read");
  });

  it("shares the total hold time across bubbles by length, with a floor", () => {
    assert.deepStrictEqual(holdTimes(["aaa bbb"], 12000), [12000]);
    const [long, short] = holdTimes(["one two three four five six", "ok"], 12000);
    assert.ok(long > short);
    assert.strictEqual(holdTimes(["one two", "one two"], 12000)[0], 6000);
    assert.ok(holdTimes(["a", "b", "c"], 3000).every((ms) => ms >= MIN_HOLD_MS), "every bubble is readable");
  });

  it("plays a reply's bubbles back to back, each held after its typing, then fades out", () => {
    const parts = ["First line here.", "Second line follows now.", "Third and last."];
    const { bubble, windows, timers, handles } = setup();
    assert.strictEqual(bubble.show(parts, { durationMs: 12000 }), true);
    const win = windows[0];
    win.finishLoad();
    const shown = () => win.sent.filter((m) => m.channel === "chatter-bubble-show" && !m.payload.quiet).map((m) => m.payload.text);
    assert.deepStrictEqual(shown(), [parts[0]]);
    assert.strictEqual(win.sent[0].payload.charMs, TYPE_CHAR_MS, "the page is told how fast to type");

    const holds = holdTimes(parts, 12000);
    assert.strictEqual(handles.at(-1).ms, parts[0].length * TYPE_CHAR_MS + holds[0]);
    timers.fire();
    assert.deepStrictEqual(shown(), [parts[0], parts[1]]);
    assert.strictEqual(handles.at(-1).ms, parts[1].length * TYPE_CHAR_MS + holds[1], "the second hold starts after the second typing");
    timers.fire();
    assert.deepStrictEqual(shown(), parts);
    assert.strictEqual(win.destroyed, false);
    timers.fire(); // the last bubble's time is up: fade out
    assert.strictEqual(win.sent.at(-1).channel, "chatter-bubble-hide");
    timers.fire();
    assert.strictEqual(win.destroyed, true);
    assert.strictEqual(bubble.isVisible(), false);
  });

  it("a click skips to the next bubble, and dismisses the reply on the last one", () => {
    const { bubble, windows, ipcHandlers, timers } = setup();
    bubble.show(["One here.", "Two here.", "Three here."]);
    const win = windows[0];
    win.finishLoad();
    const own = { sender: win.webContents };
    const texts = () => win.sent.filter((m) => m.channel === "chatter-bubble-show" && !m.payload.quiet).map((m) => m.payload.text);
    ipcHandlers.get("chatter-bubble-dismiss")(own);
    assert.deepStrictEqual(texts(), ["One here.", "Two here."]);
    assert.strictEqual(win.destroyed, false);
    ipcHandlers.get("chatter-bubble-dismiss")(own);
    assert.deepStrictEqual(texts(), ["One here.", "Two here.", "Three here."]);
    ipcHandlers.get("chatter-bubble-dismiss")(own);
    assert.strictEqual(win.destroyed, true);
    assert.strictEqual(bubble.isVisible(), false);
    timers.fire(); // a stale part timer must not resurrect or crash anything
  });

  it("a skip cancels the old bubble's timer, so bubbles never advance twice", () => {
    const { bubble, windows, ipcHandlers, handles } = setup();
    bubble.show(["One here.", "Two here.", "Three here."]);
    windows[0].finishLoad();
    const first = handles.at(-1);
    ipcHandlers.get("chatter-bubble-dismiss")({ sender: windows[0].webContents });
    assert.ok(first.cleared);
  });

  it("hide() and dispose() cancel the remaining bubbles", () => {
    const hidden = setup();
    hidden.bubble.show(["One here.", "Two here."]);
    hidden.windows[0].finishLoad();
    hidden.bubble.hide();
    assert.ok(hidden.handles.every((h) => h.cleared || h.fired));
    assert.strictEqual(hidden.windows[0].destroyed, true);
    const disposed = setup();
    disposed.bubble.show(["One here.", "Two here."]);
    disposed.bubble.dispose();
    assert.ok(disposed.handles.every((h) => h.cleared || h.fired));
  });

  it("repositioning while a bubble is typing only moves it: a quiet update, never new text", () => {
    let petX = 900;
    const { bubble, windows } = setup({
      getPetBounds: () => ({ x: petX, y: 700, width: 200, height: 200 }),
      getAnchorRect: (b) => ({ left: b.x + 30, top: 720, right: b.x + 170, bottom: 890 }),
    });
    bubble.show(["First line here.", "Second line here."]);
    windows[0].finishLoad();
    petX = 1100;
    bubble.reposition();
    const last = windows[0].sent.at(-1).payload;
    assert.strictEqual(last.quiet, true);
    assert.strictEqual(last.text, "First line here.", "the current bubble's text, for the page to ignore");
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

  it("the chosen font reaches the page, an unknown one falls back to the default", () => {
    const { bubble, windows } = setup();
    bubble.show("Hello there, friend.", { font: "courier" });
    windows[0].finishLoad();
    assert.deepStrictEqual(windows[0].sent[0].payload.font, CHATTER_FONTS.courier);
    bubble.hide();

    const second = setup();
    second.bubble.show("Hello there, friend.", { font: "<script>" });
    second.windows[0].finishLoad();
    assert.deepStrictEqual(second.windows[0].sent[0].payload.font, CHATTER_FONTS.cascadia);
  });

  it("every preset ends in monospace and has a usable size", () => {
    for (const id of CHATTER_FONT_IDS) {
      const font = resolveChatterFont(id);
      assert.match(font.family, /monospace$/, id);
      assert.ok(font.size >= 12 && font.size <= 16, id);
      assert.ok(font.lineHeight >= 1.3 && font.lineHeight <= 1.6, id);
    }
  });
});

describe("chatter bubble placement", () => {
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
});
