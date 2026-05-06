const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const createSettingsWindowRuntime = require("../src/settings-window");

class FakeBrowserWindow {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.minimized = false;
    this.calls = [];
    this.events = new Map();
    this.onceEvents = new Map();
    FakeBrowserWindow.instances.push(this);
  }

  isDestroyed() {
    return this.destroyed;
  }

  isMinimized() {
    return this.minimized;
  }

  restore() {
    this.calls.push("restore");
    this.minimized = false;
  }

  show() {
    this.calls.push("show");
  }

  focus() {
    this.calls.push("focus");
  }

  setAppDetails(details) {
    this.calls.push("setAppDetails");
    this.appDetails = details;
  }

  setMenuBarVisibility(value) {
    this.calls.push(["setMenuBarVisibility", value]);
    this.menuBarVisible = value;
  }

  loadFile(filePath) {
    this.calls.push(["loadFile", filePath]);
    this.loadedFile = filePath;
  }

  once(eventName, listener) {
    this.onceEvents.set(eventName, listener);
  }

  on(eventName, listener) {
    this.events.set(eventName, listener);
  }

  emit(eventName) {
    const onceListener = this.onceEvents.get(eventName);
    if (onceListener) {
      this.onceEvents.delete(eventName);
      onceListener();
    }
    const listener = this.events.get(eventName);
    if (listener) listener();
  }
}

function createFakeApp({ ready = true, packaged = false } = {}) {
  const listeners = new Map();
  return {
    app: {
      isPackaged: packaged,
      isReady: () => ready,
      getAppPath: () => "C:\\app",
      once(eventName, listener) {
        listeners.set(eventName, listener);
      },
    },
    listeners,
  };
}

function createRuntime(options = {}) {
  FakeBrowserWindow.instances = [];
  const { app, listeners } = createFakeApp(options.app);
  const fs = {
    existsSync(filePath) {
      return /assets[\\/](icons[\\/]256x256\.png|icon\.ico)$/.test(filePath);
    },
  };
  const runtime = createSettingsWindowRuntime({
    app,
    BrowserWindow: FakeBrowserWindow,
    fs,
    isWin: true,
    nativeTheme: { shouldUseDarkColors: !!options.dark },
    path: path.win32,
    platform: "win32",
    resourcesPath: "C:\\resources",
    execPath: "C:\\electron\\electron.exe",
    appDir: "C:\\app",
    settingsHtmlPath: "C:\\app\\src\\settings.html",
    preloadPath: "C:\\app\\src\\preload-settings.js",
    ...options.runtime,
  });
  return { runtime, listeners };
}

test("settings window runtime creates the Settings BrowserWindow with taskbar identity", () => {
  const events = [];
  let runtime;
  ({ runtime } = createRuntime({
    dark: true,
    runtime: {
      onBeforeCreate: () => events.push("before-create"),
      onBeforeClosed: () => events.push("before-closed"),
      onAfterClosed: () => events.push(runtime.getWindow() === null ? "after-closed-null" : "after-closed-live"),
    },
  }));

  runtime.open();
  assert.strictEqual(FakeBrowserWindow.instances.length, 1);
  const win = FakeBrowserWindow.instances[0];

  assert.strictEqual(runtime.getWindow(), win);
  assert.strictEqual(win.options.title, "Clawd Settings");
  assert.strictEqual(win.options.backgroundColor, "#1c1c1f");
  assert.strictEqual(win.options.webPreferences.preload, "C:\\app\\src\\preload-settings.js");
  assert.strictEqual(win.options.webPreferences.nodeIntegration, false);
  assert.strictEqual(win.options.webPreferences.contextIsolation, true);
  assert.match(win.options.icon, /assets[\\/]icons[\\/]256x256\.png$/);
  assert.strictEqual(win.menuBarVisible, false);
  assert.strictEqual(win.loadedFile, "C:\\app\\src\\settings.html");
  assert.match(win.appDetails.appIconPath, /assets[\\/]icon\.ico$/);
  assert.ok(win.appDetails.relaunchCommand.includes("--open-settings-window"));
  assert.deepStrictEqual(events, ["before-create"]);

  win.emit("ready-to-show");
  assert.deepStrictEqual(win.calls.slice(-2), ["show", "focus"]);

  win.emit("closed");
  assert.deepStrictEqual(events, ["before-create", "before-closed", "after-closed-null"]);
  assert.strictEqual(runtime.getWindow(), null);
});

test("settings window runtime reuses an existing non-destroyed Settings window", () => {
  const { runtime } = createRuntime();
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.calls = [];
  win.minimized = true;

  runtime.open();

  assert.strictEqual(FakeBrowserWindow.instances.length, 1);
  assert.deepStrictEqual(win.calls, ["restore", "show", "focus"]);
});

test("settings window runtime defers opening until Electron is ready", () => {
  const { runtime, listeners } = createRuntime({ app: { ready: false } });

  runtime.openWhenReady();

  assert.strictEqual(FakeBrowserWindow.instances.length, 0);
  assert.strictEqual(typeof listeners.get("ready"), "function");

  listeners.get("ready")();

  assert.strictEqual(FakeBrowserWindow.instances.length, 1);
});
