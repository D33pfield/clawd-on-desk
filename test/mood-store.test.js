"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createMoodStore, loadMoodState, defaultMoodFilePath } = require("../src/mood-store");

describe("mood store", () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-mood-"));
    file = path.join(dir, "nested", "mood.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeTimers() {
    const pending = [];
    return {
      pending,
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, cleared: false };
        pending.push(handle);
        return handle;
      },
      clearTimeout: (handle) => { handle.cleared = true; },
      fire() {
        for (const handle of pending.splice(0)) if (!handle.cleared) handle.fn();
      },
    };
  }

  it("defaults to ~/.clawd/mood.json", () => {
    assert.strictEqual(defaultMoodFilePath("/home/x"), path.join("/home/x", ".clawd", "mood.json"));
  });

  it("loads null for a missing or corrupt file", () => {
    assert.strictEqual(loadMoodState(file), null);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    assert.strictEqual(loadMoodState(file), null);
  });

  it("debounces saves into one atomic write", () => {
    const timers = fakeTimers();
    let state = { version: 1, n: 1 };
    const store = createMoodStore({ filePath: file, getState: () => state, delayMs: 5000, ...timers });
    store.scheduleSave();
    store.scheduleSave();
    store.scheduleSave();
    assert.strictEqual(timers.pending.length, 1);
    assert.strictEqual(timers.pending[0].ms, 5000);
    assert.strictEqual(fs.existsSync(file), false);

    state = { version: 1, n: 2 };
    timers.fire();
    assert.deepStrictEqual(loadMoodState(file), { version: 1, n: 2 });
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ["mood.json"]);

    store.scheduleSave();
    assert.strictEqual(timers.pending.length, 1, "a new save can be scheduled after the write");
  });

  it("flush writes immediately and cancels the pending timer", () => {
    const timers = fakeTimers();
    const store = createMoodStore({ filePath: file, getState: () => ({ version: 1, n: 3 }), ...timers });
    store.scheduleSave();
    store.flush();
    assert.strictEqual(timers.pending[0].cleared, true);
    assert.deepStrictEqual(loadMoodState(file), { version: 1, n: 3 });
  });

  it("writes the file private to the user", { skip: process.platform === "win32" }, () => {
    const store = createMoodStore({ filePath: file, getState: () => ({ version: 1 }) });
    store.flush();
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("swallows write failures and cleans up", () => {
    const logs = [];
    const failing = {
      ...fs,
      mkdirSync: fs.mkdirSync,
      writeFileSync: () => { throw new Error("disk full"); },
      unlinkSync: () => {},
    };
    const store = createMoodStore({
      filePath: file, getState: () => ({ version: 1 }), fs: failing, log: (line) => logs.push(line),
    });
    assert.doesNotThrow(() => store.flush());
    assert.match(logs[0], /mood save failed: disk full/);
  });
});
