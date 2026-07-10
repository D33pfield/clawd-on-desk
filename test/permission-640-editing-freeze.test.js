"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

// ── Mock electron before requiring permission.js (same pattern as
// permission-ime-editing.test.js): handleImeEditing and friends resolve IPC
// senders via BrowserWindow.fromWebContents, and the test runtime's
// require("electron") returns a path string.
const __electronMock = {
  BrowserWindow: { fromWebContents: (sender) => (sender && sender.__win) || null },
  globalShortcut: {
    register: () => {}, unregister: () => {}, unregisterAll: () => {}, isRegistered: () => false,
  },
};
const __origModuleLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return __electronMock;
  return __origModuleLoad.apply(this, arguments);
};
const initPermission = require("../src/permission");
Module._load = __origModuleLoad;

const macOnly = { skip: process.platform !== "darwin" ? "macOS-only" : false };

function makeCtx(overrides = {}) {
  return {
    reapplyMacVisibility: () => {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => ({ x: 200, y: 200, width: 120, height: 120 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => ({ x: 200, y: 200, width: 120, height: 120 }),
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    focusTerminalForSession: () => {},
    win: { isDestroyed: () => false },
    bubbleFollowPet: true,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map(),
    pendingPermissions: [],
    subscribeShortcuts: () => () => {},
    onPermissionsChanged: () => {},
    onPermissionResolved: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    ...overrides,
  };
}

function makeBubble(overrides = {}) {
  return {
    isDestroyed: () => false,
    setBoundsCalls: [],
    setBounds(bounds) { this.setBoundsCalls.push(bounds); },
    getBounds: () => ({ x: 0, y: 0, width: 300, height: 200 }),
    ...overrides,
  };
}

describe("repositionBubbles freeze while editing (#640)", () => {
  it("skips the bubble being typed into and still places the others", () => {
    const ctx = makeCtx();
    const { repositionBubbles, pendingPermissions } = initPermission(ctx);

    const frozen = makeBubble();
    frozen.__clawdMacImeEditing = true;
    const normal = makeBubble();
    pendingPermissions.push(
      { bubble: frozen, suggestions: [], measuredHeight: 120 },
      { bubble: normal, suggestions: [], measuredHeight: 120 },
    );

    repositionBubbles();

    assert.strictEqual(frozen.setBoundsCalls.length, 0,
      "the editing bubble must hold its position");
    assert.strictEqual(normal.setBoundsCalls.length, 1,
      "non-editing bubbles still get placed");
  });

  it("places every bubble again once editing ends", () => {
    const ctx = makeCtx();
    const { repositionBubbles, pendingPermissions } = initPermission(ctx);

    const bubble = makeBubble();
    bubble.__clawdMacImeEditing = true;
    pendingPermissions.push({ bubble, suggestions: [], measuredHeight: 120 });

    repositionBubbles();
    assert.strictEqual(bubble.setBoundsCalls.length, 0);

    delete bubble.__clawdMacImeEditing;
    repositionBubbles();
    assert.strictEqual(bubble.setBoundsCalls.length, 1);
  });
});

describe("removePendingPermission editing cleanup (#640)", () => {
  it("re-runs the mac visibility pass when the removed bubble was mid-edit", macOnly, () => {
    const reapply = [];
    const ctx = makeCtx({ reapplyMacVisibility: () => reapply.push(true) });
    const { removePendingPermission, pendingPermissions } = initPermission(ctx);

    const bubble = makeBubble();
    bubble.__clawdMacImeEditing = true;
    const perm = { bubble, suggestions: [] };
    pendingPermissions.push(perm);

    removePendingPermission(perm, "test");

    assert.strictEqual(reapply.length, 1,
      "closing an editing bubble must restore the pet via reapplyMacVisibility");
  });

  it("does not run the visibility pass for a non-editing bubble", macOnly, () => {
    const reapply = [];
    const ctx = makeCtx({ reapplyMacVisibility: () => reapply.push(true) });
    const { removePendingPermission, pendingPermissions } = initPermission(ctx);

    const perm = { bubble: makeBubble(), suggestions: [] };
    pendingPermissions.push(perm);

    removePendingPermission(perm, "test");

    assert.strictEqual(reapply.length, 0);
  });
});
