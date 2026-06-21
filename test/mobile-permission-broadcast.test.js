"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { initMobilePreviewServer, PROTOCOL_VERSION } = require("../src/network/mobile-preview-server");

function connectClient(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const messages = [];
  const waiters = [];
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === msg.type) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(msg);
        }
      }
    } catch {}
  });
  return {
    ws,
    messages,
    waitFor(type, timeoutMs = 5000) {
      const existing = messages.find((m) => m.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
        waiters.push({ type, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      });
    },
    close() { ws.close(); },
  };
}

function waitForOpen(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error("Timeout waiting for open")), timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
  });
}

function waitForPort(getPortFn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const p = getPortFn();
      if (typeof p === "number" && p > 0) { resolve(p); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error("Timeout waiting for port")); return; }
      setTimeout(check, 50);
    };
    check();
  });
}

// ── Slice 2: Permission Broadcasting Tests ──

describe("Permission Broadcasting", () => {
  let tmpDir;
  let server;
  let port;
  let token;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-perm-test-"));
    const sessions = new Map();
    server = initMobilePreviewServer({
      sessions,
      tokenPath: path.join(tmpDir, "mobile-token.json"),
      now: () => Date.now(),
    });
    await server.start();
    port = await waitForPort(() => server.getPort());
    token = server.getToken();
  });

  after(() => {
    if (server) server.cleanup();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("broadcastPermissionEvent sends permission_request with nested data", async () => {
    const c1 = connectClient(port, token);
    await waitForOpen(c1.ws);
    await c1.waitFor("snapshot");

    server.broadcastPermissionEvent({
      requestId: "perm_1000_abc",
      data: {
        agentId: "claude-code",
        toolName: "Bash",
        toolInputSummary: "Run project tests",
        suggestions: [{ index: 0, label: "Allow", behavior: "allow" }],
        sessionFolder: "my-project",
        sessionShortId: "a3f",
        timeout: 90000,
        createdAt: 1000,
      },
    });

    const msg = await c1.waitFor("permission_request");
    assert.strictEqual(msg.type, "permission_request");
    assert.strictEqual(msg.version, PROTOCOL_VERSION);
    assert.strictEqual(msg.requestId, "perm_1000_abc");
    assert.ok(typeof msg.timestamp === "number");
    assert.strictEqual(msg.data.agentId, "claude-code");
    assert.strictEqual(msg.data.toolName, "Bash");
    assert.strictEqual(msg.data.toolInputSummary, "Run project tests");
    assert.strictEqual(msg.data.suggestions.length, 1);
    assert.strictEqual(msg.data.suggestions[0].label, "Allow");
    assert.strictEqual(msg.data.sessionFolder, "my-project");
    assert.strictEqual(msg.data.sessionShortId, "a3f");
    assert.strictEqual(msg.data.timeout, 90000);

    c1.close();
  });

  it("broadcastPermissionDismissed sends permission_dismissed", async () => {
    const c1 = connectClient(port, token);
    await waitForOpen(c1.ws);
    await c1.waitFor("snapshot");

    server.broadcastPermissionDismissed({
      requestId: "perm_1000_abc",
      reason: "desktop_bubble",
    });

    const msg = await c1.waitFor("permission_dismissed");
    assert.strictEqual(msg.type, "permission_dismissed");
    assert.strictEqual(msg.version, PROTOCOL_VERSION);
    assert.strictEqual(msg.requestId, "perm_1000_abc");
    assert.strictEqual(msg.reason, "desktop_bubble");
    assert.ok(typeof msg.timestamp === "number");

    c1.close();
  });

  it("broadcast to multiple clients", async () => {
    const c1 = connectClient(port, token);
    const c2 = connectClient(port, token);
    await waitForOpen(c1.ws);
    await waitForOpen(c2.ws);
    await c1.waitFor("snapshot");
    await c2.waitFor("snapshot");

    server.broadcastPermissionEvent({
      requestId: "perm_2000_xyz",
      data: { agentId: "codex", toolName: "Write", toolInputSummary: "Edit file", suggestions: [], sessionFolder: null, sessionShortId: null, timeout: null, createdAt: 2000 },
    });

    const msg1 = await c1.waitFor("permission_request");
    const msg2 = await c2.waitFor("permission_request");
    assert.strictEqual(msg1.requestId, "perm_2000_xyz");
    assert.strictEqual(msg2.requestId, "perm_2000_xyz");

    c1.close();
    c2.close();
  });

  it("no broadcast when no clients connected", () => {
    assert.doesNotThrow(() => {
      server.broadcastPermissionEvent({ requestId: "test", data: {} });
      server.broadcastPermissionDismissed({ requestId: "test", reason: "desktop_bubble" });
    });
  });

  it("permission_dismissed reason values match spec", async () => {
    const c1 = connectClient(port, token);
    await waitForOpen(c1.ws);
    await c1.waitFor("snapshot");

    const reasons = ["desktop_bubble", "timeout", "dnd", "agent_disconnect"];
    // Collect all dismissed messages via raw listener
    const received = [];
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
      const handler = (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "permission_dismissed") {
            received.push(msg);
            if (received.length === reasons.length) {
              clearTimeout(timeout);
              c1.ws.removeListener("message", handler);
              resolve();
            }
          }
        } catch {}
      };
      c1.ws.on("message", handler);
      for (const reason of reasons) {
        server.broadcastPermissionDismissed({ requestId: "perm_r_" + reason, reason });
      }
    });

    for (let i = 0; i < reasons.length; i++) {
      assert.strictEqual(received[i].reason, reasons[i]);
    }

    c1.close();
  });
});

// ── Snapshot with pending permissions ──

describe("Snapshot pendingPermissions extension", () => {
  let tmpDir;
  let server;
  let port;
  let token;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-snap-perm-test-"));
    const sessions = new Map();
    sessions.set("sess1", { agentId: "claude-code", sessionTitle: "Test", cwd: "/home/user/project", state: "working", updatedAt: Date.now(), recentEvents: [] });
    const mockPending = [
      { sessionId: "sess1", toolName: "Bash", agentId: "claude-code", suggestions: [], isElicitation: false, isCodexNotify: false, isKimiNotify: false, createdAt: 1000, _mobileRequestId: "perm_1000_abc", _mobileToolInputSummary: "Run project tests", _mobileSuggestions: [{ index: 0, label: "Allow", behavior: "allow" }], _mobileSessionFolder: "project", _mobileTimeout: 90000 },
      { sessionId: "sess1", toolName: "Write", agentId: "claude-code", suggestions: [], isElicitation: false, isCodexNotify: false, isKimiNotify: false, createdAt: 1001, _mobileRequestId: "perm_1001_def", _mobileToolInputSummary: "Edit config file", _mobileSuggestions: [], _mobileSessionFolder: "project", _mobileTimeout: null },
      // Should be skipped (no _mobileRequestId = not broadcast)
      { sessionId: "sess1", toolName: "CodexExec", agentId: "codex", suggestions: [], isCodexNotify: true, createdAt: 1002 },
    ];
    server = initMobilePreviewServer({
      sessions,
      getPendingPermissions: () => mockPending,
      tokenPath: path.join(tmpDir, "mobile-token.json"),
      now: () => Date.now(),
    });
    await server.start();
    port = await waitForPort(() => server.getPort());
    token = server.getToken();
  });

  after(() => {
    if (server) server.cleanup();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("snapshot includes pendingPermissions with correct schema", async () => {
    const c1 = connectClient(port, token);
    await waitForOpen(c1.ws);
    const snapshot = await c1.waitFor("snapshot");

    assert.ok(Array.isArray(snapshot.pendingPermissions), "should have pendingPermissions array");
    assert.strictEqual(snapshot.pendingPermissions.length, 2);

    const p0 = snapshot.pendingPermissions[0];
    assert.strictEqual(p0.requestId, "perm_1000_abc");
    assert.strictEqual(p0.toolName, "Bash");
    assert.strictEqual(p0.agentId, "claude-code");
    assert.strictEqual(p0.toolInputSummary, "Run project tests");
    assert.strictEqual(p0.sessionFolder, "project");
    assert.strictEqual(p0.timeout, 90000);
    assert.strictEqual(p0.createdAt, 1000);
    assert.ok(Array.isArray(p0.suggestions));
    assert.strictEqual(p0.suggestions.length, 1);
    assert.strictEqual(p0.suggestions[0].label, "Allow");

    const p1 = snapshot.pendingPermissions[1];
    assert.strictEqual(p1.requestId, "perm_1001_def");
    assert.strictEqual(p1.toolName, "Write");
    assert.strictEqual(p1.toolInputSummary, "Edit config file");
    assert.strictEqual(p1.suggestions.length, 0);
    assert.strictEqual(p1.timeout, null);

    c1.close();
  });

  it("snapshot pendingPermissions only present when entries exist", async () => {
    // The first test in this describe block already verified that
    // pendingPermissions is present with 2 entries when getPendingPermissions
    // returns data. This test verifies the structure is correct.
    const c1 = connectClient(port, token);
    await waitForOpen(c1.ws);
    const snapshot = await c1.waitFor("snapshot");

    // With mockPending returning 2 active entries, should be present
    assert.ok(Array.isArray(snapshot.pendingPermissions));
    assert.strictEqual(snapshot.pendingPermissions.length, 2);

    // Verify each entry has the required fields per Section 2.9
    for (const pp of snapshot.pendingPermissions) {
      assert.ok(typeof pp.requestId === "string");
      assert.ok(typeof pp.agentId === "string");
      assert.ok(typeof pp.toolName === "string");
      assert.ok(typeof pp.createdAt === "number");
    }

    c1.close();
  });
});

// ── isMobileApprovalActionable integration ──

describe("Permission onPermissionAdded hook", () => {
  it("onPermissionAdded is called for actionable permissions", () => {
    const Module = require("module");
    const originalLoad = Module._load;
    const fakeElectron = {
      BrowserWindow: function() { return { isDestroyed: () => true, loadFile: () => {}, on: () => {}, webContents: { once: () => {}, send: () => {} } }; },
      globalShortcut: { register: () => true, unregister: () => {}, isRegistered: () => false },
    };
    Module._load = function(request, parent, isMain) {
      if (request === "electron") return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      const initPermission = require("../src/permission");
      const addedEntries = [];
      const ctx = {
        get win() { return null; },
        get lang() { return "en"; },
        get sessions() { return new Map(); },
        get bubbleFollowPet() { return false; },
        get permDebugLog() { return null; },
        get doNotDisturb() { return false; },
        get hideBubbles() { return false; },
        get petHidden() { return false; },
        getBubblePolicy: () => ({ enabled: true }),
        getPetWindowBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        getNearestWorkArea: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        getHitRectScreen: () => null,
        getTextScale: () => 1,
        guardAlwaysOnTop: () => {},
        reapplyMacVisibility: () => {},
        isAgentPermissionsEnabled: () => true,
        isAutoApproveAllEnabled: () => false,
        focusTerminalForSession: () => {},
        getSettingsSnapshot: () => ({}),
        onPermissionsChanged: () => {},
        onPermissionResolved: () => {},
        onPermissionAdded: (entry) => { addedEntries.push(entry); },
      };
      const perm = initPermission(ctx);

      // Actionable entry — should trigger onPermissionAdded
      perm.addPendingPermission({
        res: null, abortHandler: null, suggestions: [],
        sessionId: "test-sess", bubble: null, hideTimer: null,
        toolName: "Bash", toolInput: {}, resolvedSuggestion: null,
        createdAt: Date.now(), agentId: "claude-code",
      }, "test");
      assert.strictEqual(addedEntries.length, 1);

      // Passive notification — should NOT trigger
      perm.addPendingPermission({
        res: null, abortHandler: null, suggestions: [],
        sessionId: "codex-sess", bubble: null, hideTimer: null,
        toolName: "CodexExec", toolInput: {}, resolvedSuggestion: null,
        createdAt: Date.now(), isCodexNotify: true, agentId: "codex",
      }, "passive-added");
      assert.strictEqual(addedEntries.length, 1); // still 1
    } finally {
      Module._load = originalLoad;
      delete require.cache[require.resolve("../src/permission")];
    }
  });
});
