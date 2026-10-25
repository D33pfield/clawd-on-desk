"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createAwarenessRuntime } = require("../src/desktop-awareness-runtime");

function fakeSettings(initial) {
  const values = {
    desktopAwareness: false, desktopAwarenessArmed: false, desktopAwarenessScope: "window",
    desktopAwarenessMonitor: "pet", chatterEnabled: true, chatterModel: "", ...initial,
  };
  const subscribers = new Map();
  const updates = [];
  const controller = {
    get: (key) => values[key],
    applyUpdate: (key, value) => {
      updates.push([key, value]);
      values[key] = value;
      for (const cb of subscribers.get(key) || []) cb(value);
    },
    subscribeKey: (key, cb) => { subscribers.set(key, [...(subscribers.get(key) || []), cb]); },
  };
  return { controller, values, updates };
}

function setup(initial = {}, extra = {}) {
  const s = fakeSettings(initial);
  const warmed = [];
  const captures = [];
  const logs = [];
  const runtime = createAwarenessRuntime({
    settings: s.controller,
    electron: {},
    getChatter: () => ({ resolveModel: async () => "vision-model:1b", warm: async () => { warmed.push(true); } }),
    getChatterSettings: () => ({}),
    canSpeak: () => true,
    getPetCenter: () => null,
    log: (m) => logs.push(m),
    capturer: { capture: async (opts) => { captures.push(opts); return { ok: true, images: [{ buffer: Buffer.from("x"), displayId: 1 }] }; } },
    fetch: async (url, init) => {
      if (url.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: ["vision"] }) };
      return { ok: true, json: async () => ({ message: { content: "Someone is reading a web page." } }) };
    },
    ...extra,
  });
  return { runtime, applyUpdate: s.controller.applyUpdate, values: s.values, updates: s.updates, warmed, captures, logs };
}

describe("desktop awareness runtime: the two toggles", () => {
  it("disarms at every launch, whatever was saved", () => {
    const t = setup({ desktopAwareness: true, desktopAwarenessArmed: true });
    assert.strictEqual(t.values.desktopAwarenessArmed, false);
    assert.deepStrictEqual(t.updates[0], ["desktopAwarenessArmed", false]);
  });

  it("will not arm unless awareness is on", () => {
    const t = setup({ desktopAwareness: false });
    t.applyUpdate("desktopAwarenessArmed", true);
    assert.strictEqual(t.values.desktopAwarenessArmed, false);
  });

  it("switching awareness off disarms it", () => {
    const t = setup({ desktopAwareness: true });
    t.applyUpdate("desktopAwarenessArmed", true);
    assert.strictEqual(t.values.desktopAwarenessArmed, true);
    t.applyUpdate("desktopAwareness", false);
    assert.strictEqual(t.values.desktopAwarenessArmed, false);
  });

  it("re-warms the model when awareness changes, because the context size changes", () => {
    const t = setup();
    t.applyUpdate("desktopAwareness", true);
    t.applyUpdate("desktopAwareness", false);
    assert.strictEqual(t.warmed.length, 2);
  });
});

describe("desktop awareness runtime: capturing", () => {
  it("captures nothing until awareness is on; the settings choose the scope and monitor", async () => {
    const t = setup();
    assert.strictEqual(await t.runtime.getScreen("hotkey", "screen-share"), "");
    assert.strictEqual(t.captures.length, 0);
    t.applyUpdate("desktopAwareness", true);
    t.applyUpdate("desktopAwarenessScope", "screen");
    t.applyUpdate("desktopAwarenessMonitor", "all");
    assert.strictEqual(await t.runtime.getScreen("hotkey", "screen-share"), "Someone is reading a web page.");
    assert.deepStrictEqual(t.captures, [{ scope: "screen", monitor: "all" }]);
  });

  it("automatic captures happen only while armed", async () => {
    const t = setup({ desktopAwareness: true });
    assert.strictEqual(await t.runtime.getScreen("auto", "idle-check"), "");
    t.applyUpdate("desktopAwarenessArmed", true);
    assert.ok(await t.runtime.getScreen("auto", "idle-check"));
    assert.strictEqual(t.captures.length, 1);
  });

  it("reports the model, whether it can see, and the last description", async () => {
    const t = setup({ desktopAwareness: true });
    await t.runtime.getScreen("hotkey", "screen-share");
    assert.deepStrictEqual(await t.runtime.status(), { ok: true, model: "vision-model:1b", vision: true, lastSeen: "Someone is reading a web page." });
    t.applyUpdate("desktopAwareness", false);
    assert.strictEqual((await t.runtime.status()).lastSeen, "", "forgotten once switched off");
  });
});
