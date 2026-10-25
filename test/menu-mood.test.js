const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");
const { describe, it } = require("node:test");

const MENU_MODULE_PATH = require.resolve("../src/menu");

function loadMenuWithElectron(fakeElectron, fakeTaskbar = null, platform = null) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  if (platform) {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
  }
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    if (fakeTaskbar && request === "./taskbar") return fakeTaskbar;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
    if (platform) Object.defineProperty(process, "platform", originalPlatform);
  }
}

function fakeElectron() {
  return {
    app: { quit: () => {}, setActivationPolicy: () => {}, dock: { show: () => {}, hide: () => {} } },
    BrowserWindow: function BrowserWindow() {},
    Menu: {
      buildFromTemplate(template) {
        return { template };
      },
    },
    Tray: function Tray() {},
    nativeImage: {
      createFromPath() {
        return {
          resize() { return this; },
          setTemplateImage() {},
        };
      },
    },
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ id: 1 }),
    },
  };
}

function buildBaseCtx(overrides = {}) {
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
    menuOpen: false,
    tray: null,
    contextMenuOwner: null,
    contextMenu: null,
    isQuitting: false,
    petHidden: false,
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    getDisableMiniMode: () => false,
    getActiveThemeCapabilities: () => ({ miniMode: true, petTint: true }),
    openDashboard: () => {},
    openSettingsWindow: () => {},
    togglePetVisibility: () => {},
    bringPetToPrimaryDisplay: () => {},
    enableDoNotDisturb: () => {},
    disableDoNotDisturb: () => {},
    enterMiniViaMenu: () => {},
    exitMiniMode: () => {},
    miniHandleResize: () => false,
    getPetWindowBounds: () => ({ x: 10, y: 20, width: 120, height: 120 }),
    applyPetWindowBounds: () => {},
    getCurrentPixelSize: () => ({ width: 200, height: 200 }),
    isProportionalMode: () => true,
    repositionBubbles: () => {},
    syncHitWin: () => {},
    flushRuntimeStateToPrefs: () => {},
    reapplyMacVisibility: () => {},
    getSettingsWindow: () => null,
    clampToScreenVisual: (x, y) => ({ x, y }),
    ...overrides,
  };
}

describe("Open Mood menu item", () => {
  function build(ctxOverrides = {}) {
    let trayTemplate = null;
    const ctx = buildBaseCtx({
      tray: { setContextMenu(menuObj) { trayTemplate = menuObj.template; } },
      ...ctxOverrides,
    });
    const menu = loadMenuWithElectron(fakeElectron())(ctx);
    menu.buildContextMenu();
    menu.buildTrayMenu();
    return { contextTemplate: ctx.contextMenu.template, trayTemplate };
  }

  const labelsOf = (template) => template.map((item) => item.label);

  it("sits next to the Dashboard entry in the context menu and the tray menu", () => {
    const { contextTemplate, trayTemplate } = build();
    const context = labelsOf(contextTemplate);
    assert.ok(context.indexOf("Open Mood") > context.indexOf("Open Dashboard"));
    assert.strictEqual(context.indexOf("Open Mood") - context.indexOf("Open Footprints"), 1);
    const tray = labelsOf(trayTemplate);
    assert.strictEqual(tray.indexOf("Open Mood") - tray.indexOf("Open Dashboard"), 1);
  });

  it("opens the mood window from either menu", () => {
    let opened = 0;
    const { contextTemplate, trayTemplate } = build({ openMood: () => { opened += 1; } });
    for (const template of [contextTemplate, trayTemplate]) {
      template.find((item) => item.label === "Open Mood").click();
    }
    assert.strictEqual(opened, 2);
  });

  it("does nothing when the host has no mood window", () => {
    const { contextTemplate } = build();
    assert.doesNotThrow(() => contextTemplate.find((item) => item.label === "Open Mood").click());
  });
});

describe("Chatter menu item", () => {
  function build(ctxOverrides = {}) {
    let trayTemplate = null;
    const ctx = buildBaseCtx({
      tray: { setContextMenu(menuObj) { trayTemplate = menuObj.template; } },
      ...ctxOverrides,
    });
    const menu = loadMenuWithElectron(fakeElectron())(ctx);
    menu.buildContextMenu();
    menu.buildTrayMenu();
    return { ctx, contextTemplate: ctx.contextMenu.template, trayTemplate };
  }

  const find = (template) => template.find((item) => item.label === "Chatter");

  it("is a checkbox in both menus, right after Open Mood, reflecting the setting", () => {
    for (const enabled of [true, false]) {
      const { contextTemplate, trayTemplate } = build({ chatterEnabled: enabled });
      for (const template of [contextTemplate, trayTemplate]) {
        const labels = template.map((item) => item.label);
        assert.strictEqual(labels.indexOf("Chatter") - labels.indexOf("Open Mood"), 1);
        assert.strictEqual(find(template).type, "checkbox");
        assert.strictEqual(find(template).checked, enabled);
      }
    }
  });

  it("writes the checkbox state back to the host", () => {
    const { ctx, contextTemplate, trayTemplate } = build({ chatterEnabled: true });
    find(contextTemplate).click({ checked: false });
    assert.strictEqual(ctx.chatterEnabled, false);
    find(trayTemplate).click({ checked: true });
    assert.strictEqual(ctx.chatterEnabled, true);
  });

  it("is unchecked when the host does not provide the setting", () => {
    const { contextTemplate } = build();
    assert.strictEqual(find(contextTemplate).checked, false);
  });
});
