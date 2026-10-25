"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// ── Mock electron before requiring permission.js (same seam as
// permission-plan-feedback.test.js) ──
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

function createMockResponse() {
  const captured = {
    statusCode: null,
    headers: {},
    body: null,
    ended: false,
    listeners: {},
  };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    setHeader(key, value) { captured.headers[key] = value; },
    writeHead(status, headers) {
      captured.statusCode = status;
      this.headersSent = true;
      if (headers) Object.assign(captured.headers, headers);
    },
    write(chunk) { captured.body = (captured.body || "") + String(chunk); },
    end(chunk) {
      if (chunk !== undefined) captured.body = (captured.body || "") + String(chunk);
      captured.ended = true;
      this.writableEnded = true;
    },
    on(evt, fn) {
      (captured.listeners[evt] = captured.listeners[evt] || []).push(fn);
    },
    removeListener(evt, fn) {
      const arr = captured.listeners[evt] || [];
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
    destroy() { this.destroyed = true; },
  };
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalCalls: [],
    focusTerminalForSession(sessionId, opts) {
      this.focusTerminalCalls.push({ sessionId, opts });
    },
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    updateDebugLog: null,
    sessionDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    sessions: new Map(),
    pendingPermissions: [],
    subscribeShortcuts: () => () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    onPermissionsChanged: () => {},
    onPermissionResolved: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    ...overrides,
  };
}

function makeFakeBubble() {
  return { isDestroyed: () => false, webContents: { send: () => {} }, destroy: () => {} };
}
function makeEventFor(bubble) {
  return { sender: { __win: bubble } };
}

function makePermEntry(res, overrides = {}) {
  const entry = {
    res,
    abortHandler: () => {},
    suggestions: [],
    sessionId: "wire-session-1",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "rm -rf build" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    ...overrides,
  };
  // Mirror the server route: the abort handler is registered on the socket.
  res.on("close", entry.abortHandler);
  return entry;
}

describe("permission bubble mood tap", () => {
  function setup(entryOverrides = {}) {
    const moodCalls = [];
    const ctx = makeCtx({ handleMoodEvent: (...args) => moodCalls.push(args) });
    const perm = initPermission(ctx);
    const bubble = makeFakeBubble();
    const permEntry = makePermEntry(createMockResponse(), { bubble, ...entryOverrides });
    perm.pendingPermissions.push(permEntry);
    return { moodCalls, perm, bubble };
  }

  it("reports a user allow and a user deny", () => {
    for (const [behavior, expected] of [["allow", "allow"], ["deny", "deny"]]) {
      const { moodCalls, perm, bubble } = setup();
      perm.handleDecide(makeEventFor(bubble), behavior);
      assert.deepStrictEqual(moodCalls, [[{ permissionDecision: expected }, { headless: false }]], behavior);
    }
  });

  it("counts deny-and-focus as a deny", () => {
    const { moodCalls, perm, bubble } = setup();
    perm.handleDecide(makeEventFor(bubble), "deny-and-focus");
    assert.deepStrictEqual(moodCalls[0][0], { permissionDecision: "deny" });
  });

  it("ignores other bubble actions, passive notifications and unmatched bubbles", () => {
    const other = setup();
    other.perm.handleDecide(makeEventFor(other.bubble), "session-trust");
    assert.deepStrictEqual(other.moodCalls, []);

    const notify = setup({ isCodexNotify: true });
    notify.perm.handleDecide(makeEventFor(notify.bubble), "allow");
    assert.deepStrictEqual(notify.moodCalls, []);

    const unmatched = setup();
    unmatched.perm.handleDecide(makeEventFor(makeFakeBubble()), "deny");
    assert.deepStrictEqual(unmatched.moodCalls, []);
  });

  it("does not let a failing mood handler break the decision", () => {
    const ctx = makeCtx({ handleMoodEvent: () => { throw new Error("tracker gone"); } });
    const perm = initPermission(ctx);
    const bubble = makeFakeBubble();
    const permEntry = makePermEntry(createMockResponse(), { bubble });
    perm.pendingPermissions.push(permEntry);
    assert.doesNotThrow(() => perm.handleDecide(makeEventFor(bubble), "deny"));
    assert.strictEqual(perm.pendingPermissions.indexOf(permEntry), -1);
  });
});
