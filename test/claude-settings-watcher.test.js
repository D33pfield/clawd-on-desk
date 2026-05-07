"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const {
  settingsNeedClaudeHookResync,
  createClaudeSettingsWatcher,
} = require("../src/claude-settings-watcher");

class FakeWatcher extends EventEmitter {
  constructor(callback) {
    super();
    this._callback = callback;
    this.closed = false;
    this.closeCalls = 0;
  }

  emitChange(filename = "settings.json") {
    if (this.closed) return;
    this._callback("change", filename);
  }

  close() {
    this.closed = true;
    this.closeCalls++;
  }
}

function makeFakeTimers() {
  const pending = [];
  return {
    setTimeout(fn) {
      const token = { fn, cleared: false };
      pending.push(token);
      return token;
    },
    clearTimeout(token) {
      if (token) token.cleared = true;
    },
    flush() {
      while (pending.length) {
        const token = pending.shift();
        if (!token.cleared) token.fn();
      }
    },
    pendingCount() {
      return pending.length;
    },
  };
}

function makeWatcher(overrides = {}) {
  const timers = makeFakeTimers();
  const syncCalls = [];
  let watchedDir = null;
  let lastWatcher = null;
  let settingsRaw = JSON.stringify({
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: 'node "/tmp/clawd-hook.js" Stop' }],
        },
      ],
      PermissionRequest: [
        {
          matcher: "",
          hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }],
        },
      ],
    },
  });

  const watcher = createClaudeSettingsWatcher({
    fs: {
      watch(dir, callback) {
        watchedDir = dir;
        lastWatcher = new FakeWatcher(callback);
        return lastWatcher;
      },
      readFileSync() {
        return settingsRaw;
      },
    },
    path: {
      join: (...parts) => parts.join("/"),
    },
    os: {
      homedir: () => "/home/tester",
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: () => 10000,
    getHookServerPort: () => 23333,
    shouldManageClaudeHooks: () => true,
    isAgentEnabled: () => true,
    syncClawdHooks: () => syncCalls.push("claude"),
    ...overrides,
  });

  return {
    watcher,
    timers,
    syncCalls,
    getWatchedDir: () => watchedDir,
    getWatcher: () => lastWatcher,
    setSettingsRaw: (raw) => { settingsRaw = raw; },
  };
}

describe("settingsNeedClaudeHookResync", () => {
  it("returns false for empty or invalid settings content", () => {
    assert.strictEqual(settingsNeedClaudeHookResync("", "http://127.0.0.1:23333/permission"), false);
    assert.strictEqual(settingsNeedClaudeHookResync("not json", "http://127.0.0.1:23333/permission"), false);
  });

  it("requires both managed command hooks and the expected PermissionRequest URL", () => {
    const expectedUrl = "http://127.0.0.1:23333/permission";
    const intact = JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "node clawd-hook.js Stop" }] }],
        PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: expectedUrl }] }],
      },
    });
    const wrongPermissionPort = JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "node clawd-hook.js Stop" }] }],
        PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:23335/permission" }] }],
      },
    });

    assert.strictEqual(settingsNeedClaudeHookResync(intact, expectedUrl), false);
    assert.strictEqual(settingsNeedClaudeHookResync(wrongPermissionPort, expectedUrl), true);
    assert.strictEqual(settingsNeedClaudeHookResync('{"hooks":{}}', expectedUrl), true);
  });
});

describe("createClaudeSettingsWatcher", () => {
  it("watches the Claude settings directory and ignores unrelated filenames", () => {
    const { watcher, timers, syncCalls, getWatchedDir, getWatcher, setSettingsRaw } = makeWatcher();

    assert.strictEqual(watcher.start(), true);
    assert.strictEqual(getWatchedDir(), "/home/tester/.claude");

    setSettingsRaw('{"hooks":{}}');
    getWatcher().emitChange("other.json");
    timers.flush();

    assert.deepStrictEqual(syncCalls, []);
  });

  it("debounces settings changes and clears the pending timer on stop", () => {
    const { watcher, timers, syncCalls, getWatcher, setSettingsRaw } = makeWatcher();

    watcher.start();
    setSettingsRaw('{"hooks":{}}');
    getWatcher().emitChange("settings.json");
    assert.strictEqual(timers.pendingCount(), 1);
    assert.strictEqual(watcher.stop(), true);
    timers.flush();

    assert.deepStrictEqual(syncCalls, []);
    assert.strictEqual(getWatcher().closeCalls, 1);
  });

  it("re-syncs missing hooks when management and Claude Code are enabled", () => {
    const { watcher, timers, syncCalls, getWatcher, setSettingsRaw } = makeWatcher();

    watcher.start();
    setSettingsRaw('{"hooks":{}}');
    getWatcher().emitChange("settings.json");
    timers.flush();

    assert.deepStrictEqual(syncCalls, ["claude"]);
  });
});
