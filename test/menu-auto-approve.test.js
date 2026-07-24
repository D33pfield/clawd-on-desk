"use strict";

// Three-state permission automation control in the pet context and tray menus.
// Both automatic modes require a native confirmation; Ask every time is immediate.

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const MENU_MODULE_PATH = require.resolve("../src/menu");

function loadMenuWithElectron(fakeElectron) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
  }
}

function makeFakeElectron(messageBoxResponse, checkboxChecked = false) {
  const dialogCalls = [];
  return {
    _dialogCalls: dialogCalls,
    app: { quit() {}, setActivationPolicy() {}, dock: { show() {}, hide() {} } },
    BrowserWindow: function BrowserWindow() {},
    Menu: { buildFromTemplate(template) { return { template }; } },
    Tray: function Tray() {},
    nativeImage: { createFromPath() { return { resize() { return this; }, setTemplateImage() {} }; } },
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ id: 1 }),
    },
    dialog: {
      // Electron's showMessageBox is overloaded: (options) or (parent, options).
      // The auto-pilot confirm must be parentless (standalone, screen-centered)
      // so it doesn't render as a sheet on the tiny pet window — so normalize
      // both shapes and record whether a parent window was passed.
      showMessageBox(arg1, arg2) {
        const hasParent = arg2 !== undefined;
        const parent = hasParent ? arg1 : undefined;
        const opts = hasParent ? arg2 : arg1;
        dialogCalls.push({ parent, opts });
        return Promise.resolve({ response: messageBoxResponse, checkboxChecked });
      },
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    win: { isDestroyed: () => false },
    sessions: new Map(),
    currentSize: "P:15",
    doNotDisturb: false,
    lang: "en",
    showTray: true,
    showDock: true,
    openAtLogin: false,
    bubbleFollowPet: false,
    hideBubbles: false,
    soundMuted: false,
    permissionAutomationMode: "off",
    permissionAutomationAutoToolsWarningDismissed: false,
    permissionAutomationUnattendedWarningDismissed: false,
    menuOpen: false,
    tray: null,
    contextMenuOwner: null,
    contextMenu: null,
    isQuitting: false,
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    getDisableMiniMode: () => false,
    getActiveThemeCapabilities: () => ({ miniMode: true }),
    openDashboard() {},
    openSettingsWindow() {},
    togglePetVisibility() {},
    bringPetToPrimaryDisplay() {},
    enableDoNotDisturb() {},
    disableDoNotDisturb() {},
    enterMiniViaMenu() {},
    exitMiniMode() {},
    miniHandleResize: () => false,
    getPetWindowBounds: () => ({ x: 10, y: 20, width: 120, height: 120 }),
    applyPetWindowBounds() {},
    getCurrentPixelSize: () => ({ width: 200, height: 200 }),
    isProportionalMode: () => true,
    repositionBubbles() {},
    syncHitWin() {},
    flushRuntimeStateToPrefs() {},
    reapplyMacVisibility() {},
    clampToScreenVisual: (x, y) => ({ x, y }),
    rebuildAllMenus() {},
    isPermissionAutomationWarningDismissed(mode) {
      if (mode === "auto-tools") return this.permissionAutomationAutoToolsWarningDismissed;
      if (mode === "unattended") return this.permissionAutomationUnattendedWarningDismissed;
      return false;
    },
    async setPermissionAutomationMode(mode, options = {}) {
      this.permissionAutomationMode = mode;
      if (options.suppressFutureConfirmation === true && mode === "auto-tools") {
        this.permissionAutomationAutoToolsWarningDismissed = true;
      }
      if (options.suppressFutureConfirmation === true && mode === "unattended") {
        this.permissionAutomationUnattendedWarningDismissed = true;
      }
      return { status: "ok" };
    },
    newSessionWithFolder() {},
    newSessionInCurrentDir() {},
    ...overrides,
  };
}

function findPermissionAutomationItem(template) {
  return template.find((item) => item && typeof item.label === "string"
    && item.label.startsWith("Permission handling:"));
}

function findModeItem(item, label) {
  return item.submenu.find((entry) => entry.label === label);
}

describe("permission automation menu", () => {
  it("shows three explicit radio choices with Ask every time selected by default", () => {
    const menu = loadMenuWithElectron(makeFakeElectron(0));
    const ctx = makeCtx({ permissionAutomationMode: "off" });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findPermissionAutomationItem(ctx.contextMenu.template);
    assert.ok(item, "permission automation item present in context menu");
    assert.strictEqual(item.submenu.length, 3);
    assert.ok(item.submenu.every((entry) => entry.type === "radio"));
    assert.strictEqual(findModeItem(item, "Ask every time").checked, true);
  });

  it("reflects Auto-approve as the committed state", () => {
    const menu = loadMenuWithElectron(makeFakeElectron(0));
    const ctx = makeCtx({ permissionAutomationMode: "unattended" });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findPermissionAutomationItem(ctx.contextMenu.template);
    assert.strictEqual(findModeItem(item, "Auto-approve").checked, true);
  });

  it("switches to Ask every time immediately without a confirm dialog", async () => {
    const fake = makeFakeElectron(0);
    const menu = loadMenuWithElectron(fake);
    const calls = [];
    const ctx = makeCtx({
      permissionAutomationMode: "unattended",
      async setPermissionAutomationMode(mode) {
        calls.push(mode);
        this.permissionAutomationMode = mode;
        return { status: "ok" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Ask every time").click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepStrictEqual(calls, ["off"]);
    assert.strictEqual(fake._dialogCalls.length, 0, "no confirm dialog on disable");
  });

  it("Question prompts only shows a confirm dialog and commits only when confirmed", async () => {
    const fake = makeFakeElectron(0); // 0 = Enable button
    const menu = loadMenuWithElectron(fake);
    const calls = [];
    const ctx = makeCtx({
      async setPermissionAutomationMode(mode) {
        calls.push(mode);
        this.permissionAutomationMode = mode;
        return { status: "ok" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Question prompts only").click();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(fake._dialogCalls.length, 1, "confirm dialog shown");
    assert.strictEqual(fake._dialogCalls[0].opts.type, "warning");
    assert.strictEqual(fake._dialogCalls[0].parent, undefined, "dialog is parentless (screen-centered, not a sheet on the pet)");
    assert.match(fake._dialogCalls[0].opts.checkboxLabel, /understand the risks/i);
    assert.strictEqual(fake._dialogCalls[0].opts.checkboxChecked, false);
    assert.deepStrictEqual(calls, ["auto-tools"]);
    const rebuiltItem = findPermissionAutomationItem(ctx.contextMenu.template);
    assert.strictEqual(findModeItem(rebuiltItem, "Question prompts only").checked, true);
  });

  it("automatic mode does NOT commit when the user cancels", async () => {
    const fake = makeFakeElectron(1); // 1 = Cancel button
    const menu = loadMenuWithElectron(fake);
    const calls = [];
    const ctx = makeCtx({
      async setPermissionAutomationMode(mode) {
        calls.push(mode);
        return { status: "ok" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Auto-approve").click();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(fake._dialogCalls.length, 1, "confirm dialog shown");
    assert.deepStrictEqual(calls, [], "nothing committed on cancel");
  });

  it("uses the stronger warning when escalating to Auto-approve", async () => {
    const fake = makeFakeElectron(0);
    const menu = loadMenuWithElectron(fake);
    const ctx = makeCtx({ permissionAutomationMode: "auto-tools" });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Auto-approve").click();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(fake._dialogCalls[0].opts.title, /tools and decisions/i);
  });

  it("persists don't-show-again only after a confirmed automatic choice", async () => {
    const fake = makeFakeElectron(0, true);
    const menu = loadMenuWithElectron(fake);
    const calls = [];
    const ctx = makeCtx({
      async setPermissionAutomationMode(mode, options = {}) {
        calls.push({ mode, options });
        return { status: "ok" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Question prompts only").click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepStrictEqual(calls, [{
      mode: "auto-tools",
      options: { confirmed: true, suppressFutureConfirmation: true },
    }]);
  });

  it("skips only the warning previously dismissed for that exact mode", async () => {
    const fake = makeFakeElectron(0);
    const menu = loadMenuWithElectron(fake);
    const calls = [];
    const ctx = makeCtx({
      permissionAutomationAutoToolsWarningDismissed: true,
      async setPermissionAutomationMode(mode, options = {}) {
        calls.push({ mode, options });
        this.permissionAutomationMode = mode;
        return { status: "ok" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Question prompts only").click();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(fake._dialogCalls.length, 0);
    assert.deepStrictEqual(calls, [{
      mode: "auto-tools",
      options: { confirmed: false },
    }]);

    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Auto-approve").click();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(fake._dialogCalls.length, 1, "auto-tools acknowledgement must not suppress unattended");
  });

  it("shows a native error when a confirmed mode change is not persisted", async () => {
    const fake = makeFakeElectron(0);
    const menu = loadMenuWithElectron(fake);
    const ctx = makeCtx({
      async setPermissionAutomationMode() {
        return { status: "error", message: "disk full" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();

    findModeItem(
      findPermissionAutomationItem(ctx.contextMenu.template),
      "Question prompts only"
    ).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    assert.strictEqual(fake._dialogCalls.length, 2);
    assert.strictEqual(fake._dialogCalls[0].opts.type, "warning");
    assert.strictEqual(fake._dialogCalls[1].opts.type, "error");
    assert.strictEqual(fake._dialogCalls[1].opts.detail, "disk full");
    assert.strictEqual(ctx.permissionAutomationMode, "off");
  });

  it("shows a native error when turning automation off rejects", async () => {
    const fake = makeFakeElectron(0);
    const menu = loadMenuWithElectron(fake);
    const ctx = makeCtx({
      permissionAutomationMode: "auto-tools",
      async setPermissionAutomationMode() {
        throw new Error("read only");
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();

    findModeItem(
      findPermissionAutomationItem(ctx.contextMenu.template),
      "Ask every time"
    ).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    assert.strictEqual(fake._dialogCalls.length, 1);
    assert.strictEqual(fake._dialogCalls[0].opts.type, "error");
    assert.strictEqual(fake._dialogCalls[0].opts.detail, "read only");
  });

  it("is present in the tray menu too", () => {
    const menu = loadMenuWithElectron(makeFakeElectron(0));
    let trayTemplate = null;
    const ctx = makeCtx({
      tray: { setContextMenu(menuObj) { trayTemplate = menuObj.template; } },
    });
    const m = menu(ctx);
    m.buildTrayMenu();
    assert.ok(findPermissionAutomationItem(trayTemplate), "permission automation item present in tray menu");
  });
});
