"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createDesktopAwareness, cleanDescription, DESCRIBE_PROMPT } = require("../src/desktop-awareness");

// Fakes only: no real screen is ever captured by a test, and no fixture comes from one.
function setup(overrides = {}) {
  const logs = [];
  const chats = [];
  const captured = [];
  let captureCalls = 0;
  const settings = { enabled: true, armed: true, scope: "window", monitor: "pet", chatterEnabled: true, ...(overrides.settings || {}) };
  const capturer = overrides.capturer || {
    capture: async () => {
      captureCalls++;
      const buffer = Buffer.from("FAKE-JPEG-BYTES");
      captured.push(buffer);
      return { ok: true, images: [{ buffer, displayId: 7 }] };
    },
  };
  const state = { vision: overrides.vision !== false, replies: [...(overrides.replies || ["The person is writing code in an editor."])] };
  const awareness = createDesktopAwareness({
    capturer,
    log: (msg) => logs.push(msg),
    getSettings: () => settings,
    canSpeak: overrides.canSpeak || (() => true),
    resolveModel: async () => "test-model:1b",
    fetch: overrides.fetch || (async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/api/show")) {
        return { ok: true, json: async () => ({ capabilities: state.vision ? ["completion", "vision"] : ["completion"] }) };
      }
      chats.push(body);
      const next = state.replies.shift();
      if (next instanceof Error) throw next;
      return { ok: true, json: async () => ({ message: { content: next === undefined ? "Something on screen." : next } }) };
    }),
  });
  return { awareness, settings, logs, chats, captured, calls: () => captureCalls };
}

describe("desktop awareness: when it may capture", () => {
  it("captures nothing unless awareness is on", async () => {
    const t = setup({ settings: { enabled: false } });
    assert.strictEqual(await t.awareness.describe("hotkey"), null);
    assert.strictEqual(t.calls(), 0);
  });

  it("automatic mode needs it armed; the hotkey does not", async () => {
    const t = setup({ settings: { armed: false } });
    assert.strictEqual(await t.awareness.describe("auto"), null);
    assert.strictEqual(t.calls(), 0);
    assert.ok(await t.awareness.describe("hotkey"));
    assert.strictEqual(t.calls(), 1);
  });

  it("captures nothing while chatter is off or the pet cannot speak", async () => {
    const off = setup({ settings: { chatterEnabled: false } });
    assert.strictEqual(await off.awareness.describe("hotkey"), null);
    assert.strictEqual(off.calls(), 0);
    const quiet = setup({ canSpeak: () => false });
    assert.strictEqual(await quiet.awareness.describe("auto"), null);
    assert.strictEqual(quiet.calls(), 0, "a permission bubble may be open: no capture");
  });

  it("captures nothing when the model cannot see images, and says why", async () => {
    const t = setup({ vision: false });
    assert.strictEqual(await t.awareness.describe("hotkey"), null);
    assert.strictEqual(t.calls(), 0);
    assert.ok(t.logs.some((m) => m.includes("reason=no-vision")));
    assert.deepStrictEqual(await t.awareness.visionStatus(), { model: "test-model:1b", vision: false });
  });

  it("an unreachable Ollama counts as no vision, never as permission", async () => {
    const t = setup({ fetch: async () => { throw new Error("ECONNREFUSED"); } });
    assert.strictEqual(await t.awareness.describe("hotkey"), null);
    assert.strictEqual(t.calls(), 0);
  });
});

describe("desktop awareness: the image is discarded", () => {
  it("overwrites the image bytes with zeros after a successful description", async () => {
    const t = setup();
    assert.ok(await t.awareness.describe("hotkey"));
    assert.strictEqual(t.captured.length, 1);
    assert.ok(t.captured[0].every((byte) => byte === 0), "bytes zeroed");
  });

  it("zeroes them even when the request fails or times out", async () => {
    const failing = setup({ replies: [new Error("boom")] });
    assert.strictEqual(await failing.awareness.describe("hotkey"), null);
    assert.ok(failing.captured[0].every((byte) => byte === 0));
    const aborted = setup({ fetch: async (url, init) => {
      if (url.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: ["vision"] }) };
      const err = new Error("aborted"); err.name = "AbortError"; throw err;
    } });
    assert.strictEqual(await aborted.awareness.describe("hotkey"), null);
    assert.ok(aborted.captured[0].every((byte) => byte === 0));
    assert.ok(aborted.logs.some((m) => m.includes("error=timeout")));
  });

  it("sends the image to the local model, with the larger context, and nowhere else", async () => {
    const t = setup();
    await t.awareness.describe("hotkey");
    assert.strictEqual(t.chats.length, 1);
    const body = t.chats[0];
    assert.strictEqual(body.model, "test-model:1b");
    assert.strictEqual(body.options.num_ctx, 4096);
    assert.strictEqual(body.messages[0].content, DESCRIBE_PROMPT);
    assert.strictEqual(body.messages[0].images.length, 1);
  });

  it("never writes to disk", () => {
    const source = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "desktop-awareness.js"), "utf8");
    assert.doesNotMatch(source, /require\(["']fs["']\)|writeFile|createWriteStream|appendFile/);
  });
});

describe("desktop awareness: refusals from the capturer are final", () => {
  it("does not fall back to a wider capture when the capturer says no", async () => {
    let asked = 0;
    const t = setup({ capturer: { capture: async () => { asked++; return { ok: false, reason: "foreground-is-own-window" }; } } });
    assert.strictEqual(await t.awareness.describe("hotkey"), null);
    assert.strictEqual(asked, 1, "asked once, never retried wider");
    assert.ok(t.logs.some((m) => m.includes("reason=foreground-is-own-window")));
    assert.strictEqual(t.chats.length, 0);
  });
});

describe("desktop awareness: the sentence", () => {
  it("is logged by size only, never by content, and kept for the settings page", async () => {
    const seen = [];
    const t = setup();
    const description = await t.awareness.describe("hotkey", "hotkey");
    assert.strictEqual(description, "The person is writing code in an editor.");
    assert.strictEqual(t.awareness.getLastSeen(), description);
    assert.ok(t.logs.some((m) => m.startsWith("awareness described mode=hotkey")));
    assert.ok(!t.logs.some((m) => m.includes("writing code")), "the sentence is not in the log");
    t.awareness.clearLastSeen();
    assert.strictEqual(t.awareness.getLastSeen(), "");
    void seen;
  });

  it("joins one description per monitor", async () => {
    const t = setup({
      replies: ["Someone is reading a web page.", "A video is playing."],
      capturer: { capture: async () => ({ ok: true, images: [
        { buffer: Buffer.from("a"), displayId: 1 },
        { buffer: Buffer.from("b"), displayId: 2 },
      ] }) },
    });
    const description = await t.awareness.describe("hotkey");
    assert.strictEqual(description, "Monitor 1: Someone is reading a web page. Monitor 2: A video is playing.");
    assert.strictEqual(t.chats.length, 2, "one call per monitor, never several images in one");
  });

  it("cleans untrusted output: non-strings, markup, control characters, long text", () => {
    assert.strictEqual(cleanDescription({ not: "text" }), "");
    assert.strictEqual(cleanDescription(["array"]), "");
    assert.strictEqual(cleanDescription("<think>x</think>A **code** editor\u202E is open.\u0007"), "A code editor is open.");
    assert.strictEqual(cleanDescription("One. Two. Three. Four."), "One. Two.");
    assert.ok(cleanDescription("word ".repeat(200)).length <= 220);
  });

  it("an empty description is dropped, not passed on", async () => {
    const t = setup({ replies: ["   "] });
    assert.strictEqual(await t.awareness.describe("hotkey"), null);
    assert.ok(t.logs.some((m) => m.includes("empty-description")));
  });

  it("runs one capture at a time", async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.awareness.describe("hotkey"), t.awareness.describe("hotkey")]);
    assert.ok((a && !b) || (!a && b));
    assert.strictEqual(t.calls(), 1);
  });
});
