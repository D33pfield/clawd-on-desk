"use strict";

// Behaviour tests for the fork's wiring (src/fork-runtime.js): real mood, music,
// chatter and awareness code, with a fake Ollama, fake windows, a fake music
// reader and a fake clock. These replace tests that used to read main.js as text.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createForkRuntime } = require("../src/fork-runtime");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeSettings(initial) {
  const values = {
    moodEnabled: false, chatterEnabled: true, chatterModel: "m:1b", chatterPersonality: "deadpan",
    chatterCustomPersonality: "", chatterCheckinMinutes: 12, chatterShowBubbles: true, chatterBubbleSeconds: 12,
    chatterBubbleFont: "cascadia", desktopAwareness: false, desktopAwarenessArmed: false,
    desktopAwarenessScope: "window", desktopAwarenessMonitor: "pet", desktopAwarenessLogLines: false,
    ...initial,
  };
  const subscribers = new Map();
  return {
    values,
    controller: {
      get: (key) => values[key],
      applyUpdate: (key, value) => {
        values[key] = value;
        for (const cb of subscribers.get(key) || []) cb(value);
      },
      subscribeKey: (key, cb) => { subscribers.set(key, [...(subscribers.get(key) || []), cb]); },
    },
  };
}

class FakeBubbleWindow {
  static all = [];
  constructor() {
    this.destroyed = false;
    this.webContents = { once() {}, send() {} };
    FakeBubbleWindow.all.push(this);
  }
  isDestroyed() { return this.destroyed; }
  setIgnoreMouseEvents() {}
  setAlwaysOnTop() {}
  setBounds() {}
  showInactive() {}
  loadFile() {}
  on() {}
  destroy() { this.destroyed = true; }
}

function setup(initial = {}, extra = {}) {
  FakeBubbleWindow.all = [];
  const s = fakeSettings(initial);
  const requests = [];
  const sent = [];
  const logs = [];
  const timers = [];
  const state = { permissions: 0, hidden: false, mini: false, current: "idle", titles: [] };
  const clock = { t: 10_000_000 };
  const moodFilePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fork-runtime-")), "mood.json");
  const captures = [];
  const runtime = createForkRuntime({
    ipcMain: { on() {}, removeListener() {}, handle() {} },
    electron: { BrowserWindow: class {}, ipcMain: { handle() {} }, nativeTheme: {} },
    settings: s.controller,
    log: (m) => logs.push(m),
    sendToRenderer: (channel, value) => sent.push([channel, value]),
    iconPath: null,
    getWin: () => null,
    getPetWindowBounds: () => ({ x: 900, y: 700, width: 200, height: 200 }),
    getHitRectScreen: () => ({ left: 930, top: 720, right: 1070, bottom: 890 }),
    getUpdateBubbleAnchorRect: () => ({ left: 930, top: 700, right: 1070, bottom: 890 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    guardAlwaysOnTop: () => {},
    keepOutOfTaskbar: () => {},
    isPetHidden: () => state.hidden,
    isMiniMode: () => state.mini,
    getState: () => state.current,
    hasPendingPermissions: () => state.permissions > 0,
    getUpdateBubbleWindow: () => null,
    overrides: {
      moodFilePath,
      BrowserWindow: FakeBubbleWindow,
      now: () => clock.t,
      random: () => 0,
      platform: "win32",
      musicReader: { read: () => state.titles },
      timers: {
        setTimeout: (fn, ms) => { const handle = { fn, ms, cleared: false }; timers.push(handle); return handle; },
        clearTimeout: (handle) => { if (handle) handle.cleared = true; },
      },
      capturer: { capture: async (opts) => { captures.push(opts); return { ok: true, images: [{ buffer: Buffer.from("x"), displayId: 1 }] }; } },
      fetch: async (url, init) => {
        const body = init && init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: ["completion", "vision"] }) };
        if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: [{ name: "m:1b" }] }) };
        const hasImage = body && body.messages && body.messages[0] && body.messages[0].images;
        return { ok: true, json: async () => ({ message: { content: hasImage ? "Someone is reading a web page." : "Fine, I suppose.\nSecond line here." } }) };
      },
      ...extra,
    },
  });
  const chats = () => requests.filter((r) => r.url.endsWith("/api/chat"));
  return { runtime, ...s, requests, chats, sent, logs, timers, state, clock, moodFilePath, captures };
}

describe("fork runtime: chatter", () => {
  it("turning chatter on loads the model; turning it off hides the bubble and unloads the model", async () => {
    const t = setup({ chatterEnabled: false });
    t.controller.applyUpdate("chatterEnabled", true);
    await flush();
    assert.deepStrictEqual(t.chats().map((r) => r.body.keep_alive), ["30m"], "warm-up asks for the model to stay loaded");
    t.values.chatterEnabled = true;
    t.runtime.shortcuts.chatterNow();
    await flush(); await flush();
    assert.strictEqual(FakeBubbleWindow.all.filter((w) => !w.destroyed).length, 1, "a line is showing");
    t.controller.applyUpdate("chatterEnabled", false);
    await flush();
    assert.ok(FakeBubbleWindow.all.every((w) => w.destroyed), "bubble hidden");
    assert.strictEqual(t.chats().at(-1).body.keep_alive, 0, "model unloaded");
  });

  it("the Say something hotkey does nothing while chatter is off, and writes and shows a line when on", async () => {
    const off = setup({ chatterEnabled: false });
    off.runtime.shortcuts.chatterNow();
    await flush();
    assert.strictEqual(off.chats().length, 0);
    const on = setup();
    on.runtime.shortcuts.chatterNow();
    await flush(); await flush();
    assert.strictEqual(on.chats().length, 1);
    assert.strictEqual(FakeBubbleWindow.all.length, 1);
  });

  it("with bubbles switched off the line is still written, just not shown", async () => {
    const t = setup({ chatterShowBubbles: false });
    t.runtime.shortcuts.chatterNow();
    await flush(); await flush();
    assert.strictEqual(t.chats().length, 1);
    assert.strictEqual(FakeBubbleWindow.all.length, 0);
    assert.ok(t.logs.some((m) => m.startsWith("chatter trigger=hotkey")));
  });

  it("reads the model and awareness preferences on every request", async () => {
    const t = setup({ chatterModel: "chosen:7b" });
    await t.runtime.chatter.generate("idle-check");
    assert.strictEqual(t.chats().at(-1).body.model, "chosen:7b");
    assert.strictEqual(t.chats().at(-1).body.options.num_ctx, 2048);
    t.controller.applyUpdate("chatterModel", "other:3b");
    t.controller.applyUpdate("desktopAwareness", true);
    await flush();
    await t.runtime.chatter.generate("idle-check");
    assert.strictEqual(t.chats().at(-1).body.model, "other:3b");
    assert.strictEqual(t.chats().at(-1).body.options.num_ctx, 4096, "the larger context while awareness is on");
  });

  it("stays quiet while a permission bubble is open, the pet is hidden or asleep", async () => {
    for (const change of [(s) => { s.permissions = 1; }, (s) => { s.hidden = true; }, (s) => { s.mini = true; }, (s) => { s.current = "sleeping"; }]) {
      const t = setup();
      change(t.state);
      t.runtime.shortcuts.chatterNow();
      await flush();
      assert.strictEqual(t.chats().length, 0);
      assert.strictEqual(FakeBubbleWindow.all.length, 0);
    }
  });

  it("changing the model or the interval re-warms or reschedules", async () => {
    const t = setup();
    t.controller.applyUpdate("chatterModel", "new:1b");
    await flush();
    assert.strictEqual(t.chats().at(-1).body.model, "new:1b");
    assert.strictEqual(t.chats().at(-1).body.keep_alive, "30m");
  });
});

describe("fork runtime: desktop awareness hotkey", () => {
  it("does nothing unless awareness is on; then captures, describes and replies", async () => {
    const t = setup();
    t.runtime.shortcuts.shareScreen();
    await flush();
    assert.strictEqual(t.captures.length, 0);
    assert.strictEqual(t.chats().length, 0);
    t.controller.applyUpdate("desktopAwareness", true);
    await flush();
    t.chats().length = 0;
    t.runtime.shortcuts.shareScreen();
    await flush(); await flush(); await flush();
    assert.deepStrictEqual(t.captures, [{ scope: "window", monitor: "pet" }]);
    const chats = t.chats().filter((r) => r.body.messages);
    assert.ok(chats.some((r) => r.body.messages[0].images), "the picture went to the model once");
    const reply = chats.at(-1).body.messages[1].content;
    assert.match(reply, /SCREEN \(what the user is looking at right now/);
    assert.ok(!t.logs.some((m) => m.includes("reading a web page")), "what the screen showed is never logged");
  });
});

describe("fork runtime: music", () => {
  it("tells the renderer when music starts, and only brings it up in chatter after the first minute", async () => {
    const t = setup();
    t.state.titles = ["Example Artist - Example Song"];
    t.runtime.musicDetector.start();
    t.timers.at(-1).fn(); // first check, right after launch
    await flush();
    assert.deepStrictEqual(t.sent.at(-1), ["music-state", true]);
    assert.strictEqual(t.chats().length, 0, "music that was already playing at launch is not news");

    const later = setup();
    later.clock.t += 61 * 1000;
    later.state.titles = ["Example Artist - Example Song"];
    later.runtime.musicDetector.start();
    later.timers.at(-1).fn();
    await flush(); await flush();
    assert.deepStrictEqual(later.sent.at(-1), ["music-state", true]);
    assert.strictEqual(later.chats().length, 1, "a track that starts later can be commented on");
    assert.ok(later.logs.some((m) => m.includes("chatter trigger=music-started")));
    later.runtime.dispose();
  });
});

describe("fork runtime: a reloaded pet window", () => {
  it("is told music is playing again, and told nothing when it is not", async () => {
    const quiet = setup();
    quiet.runtime.resendRendererState();
    assert.deepStrictEqual(quiet.sent, []);
    const playing = setup();
    playing.state.titles = ["Example Artist - Example Song"];
    playing.runtime.musicDetector.start();
    playing.timers.at(-1).fn();
    await flush();
    playing.sent.length = 0;
    playing.runtime.resendRendererState();
    assert.deepStrictEqual(playing.sent, [["music-state", true]]);
    playing.runtime.dispose();
  });
});

describe("fork runtime: mood and cleanup", () => {
  it("applies hook events to the mood only while the mood feature is on", () => {
    const off = setup({ moodEnabled: false });
    assert.strictEqual(off.runtime.handleMoodEvent({ event: "PostToolUseFailure" }), false);
    const on = setup({ moodEnabled: true });
    const before = on.runtime.moodTracker.read().stress;
    assert.strictEqual(on.runtime.handleMoodEvent({ event: "PostToolUseFailure" }), true);
    assert.ok(on.runtime.moodTracker.read().stress > before);
    assert.strictEqual(on.runtime.handleMoodEvent({ event: "PostToolUseFailure" }, { headless: true }), false);
  });

  it("gives chatter no mood facts while the mood feature is off", async () => {
    const t = setup({ moodEnabled: false });
    await t.runtime.chatter.generate("idle-check");
    assert.doesNotMatch(t.chats().at(-1).body.messages[1].content, /The pet itself feels/);
  });

  it("dispose stops the music check and closes any bubble", async () => {
    const t = setup();
    t.state.titles = [];
    t.runtime.musicDetector.start();
    const timer = t.timers.at(-1);
    t.runtime.shortcuts.chatterNow();
    await flush(); await flush();
    t.runtime.dispose();
    assert.ok(timer.cleared || t.timers.some((h) => h.cleared), "the music timer was cleared");
    assert.ok(FakeBubbleWindow.all.every((w) => w.destroyed));
  });
});
