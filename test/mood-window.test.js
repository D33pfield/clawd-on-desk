"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createMoodWindow, MOOD_GET_CHANNEL } = require("../src/mood-window");

function fakeElectron({ dark = false } = {}) {
  const created = [];
  const handlers = new Map();
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.listeners = {};
      this.destroyed = false;
      this.minimized = false;
      this.calls = [];
      created.push(this);
    }
    setMenuBarVisibility(visible) { this.calls.push(["menuBar", visible]); }
    loadFile(file) { this.calls.push(["loadFile", file]); }
    once(event, fn) { this.listeners[event] = fn; }
    on(event, fn) { this.listeners[event] = fn; }
    show() { this.calls.push(["show"]); }
    focus() { this.calls.push(["focus"]); }
    restore() { this.minimized = false; this.calls.push(["restore"]); }
    isMinimized() { return this.minimized; }
    isDestroyed() { return this.destroyed; }
  }
  return {
    created,
    handlers,
    electron: {
      BrowserWindow: FakeWindow,
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      nativeTheme: { shouldUseDarkColors: dark },
    },
  };
}

describe("mood window", () => {
  it("creates one small framed window with a sandboxed preload and shows it when ready", () => {
    const { created, electron } = fakeElectron();
    const moodWindow = createMoodWindow({ electron, getValues: () => ({}), iconPath: "/icon.png" });

    const win = moodWindow.open();
    assert.strictEqual(created.length, 1);
    assert.strictEqual(win.options.title, "Mood");
    assert.strictEqual(win.options.frame, true);
    assert.strictEqual(win.options.resizable, false);
    assert.strictEqual(win.options.icon, "/icon.png");
    assert.deepStrictEqual(
      { ...win.options.webPreferences, preload: undefined },
      { preload: undefined, nodeIntegration: false, contextIsolation: true, sandbox: true }
    );
    assert.match(win.options.webPreferences.preload, /preload-mood\.js$/);
    assert.ok(win.calls.some(([name, file]) => name === "loadFile" && /mood\.html$/.test(file)));

    assert.deepStrictEqual(win.calls.filter(([name]) => name === "show"), []);
    win.listeners["ready-to-show"]();
    assert.ok(win.calls.some(([name]) => name === "show"));
  });

  it("matches the system theme for the initial background", () => {
    assert.strictEqual(fakeElectron({ dark: false }).electron.nativeTheme.shouldUseDarkColors, false);
    const light = fakeElectron({ dark: false });
    createMoodWindow({ electron: light.electron }).open();
    const dark = fakeElectron({ dark: true });
    createMoodWindow({ electron: dark.electron }).open();
    assert.notStrictEqual(light.created[0].options.backgroundColor, dark.created[0].options.backgroundColor);
  });

  it("focuses the existing window instead of opening a second one", () => {
    const { created, electron } = fakeElectron();
    const moodWindow = createMoodWindow({ electron });
    const first = moodWindow.open();
    first.minimized = true;
    const again = moodWindow.open();
    assert.strictEqual(again, first);
    assert.strictEqual(created.length, 1);
    assert.ok(first.calls.some(([name]) => name === "restore"));
  });

  it("creates a fresh window after the old one closes", () => {
    const { created, electron } = fakeElectron();
    const moodWindow = createMoodWindow({ electron });
    const first = moodWindow.open();
    first.listeners.closed();
    assert.strictEqual(moodWindow.getWindow(), null);
    moodWindow.open();
    assert.strictEqual(created.length, 2);
  });

  it("answers the page's poll with the current values, registering the handler once", () => {
    const { handlers, electron } = fakeElectron();
    let values = { stress: 0.4 };
    const moodWindow = createMoodWindow({ electron, getValues: () => values });
    moodWindow.open();
    moodWindow.getWindow().listeners.closed();
    moodWindow.open();

    assert.strictEqual(handlers.size, 1);
    assert.deepStrictEqual(handlers.get(MOOD_GET_CHANNEL)(), { stress: 0.4 });
    values = { stress: 0.1 };
    assert.deepStrictEqual(handlers.get(MOOD_GET_CHANNEL)(), { stress: 0.1 });
  });
});
