"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const prefs = require("../src/prefs");
const { updateRegistry } = require("../src/settings-actions");

const ok = (key, value) => updateRegistry[key](value).status === "ok";

describe("chatter prefs", () => {
  it("default to off (it talks to a local Ollama server), with everything else ready for when it is turned on", () => {
    const defaults = prefs.getDefaults();
    assert.strictEqual(defaults.chatterEnabled, false);
    assert.strictEqual(defaults.chatterShowBubbles, true);
    assert.strictEqual(defaults.chatterModel, "");
    assert.strictEqual(defaults.chatterPersonality, "deadpan");
    assert.strictEqual(defaults.chatterCustomPersonality, "");
    assert.strictEqual(defaults.chatterCheckinMinutes, 12);
    assert.strictEqual(defaults.chatterBubbleSeconds, 12);
    for (const key of ["Checkin", "Tests", "Error", "Return", "Music"]) {
      assert.strictEqual(defaults[`chatterTrigger${key}`], true, key);
    }
  });

  it("every chatter pref has an update validator", () => {
    const chatterKeys = prefs.SCHEMA_KEYS.filter((key) => key.startsWith("chatter"));
    assert.strictEqual(chatterKeys.length, 12);
    for (const key of chatterKeys) assert.strictEqual(typeof updateRegistry[key], "function", key);
  });

  it("accept in-range values and refuse the rest", () => {
    assert.ok(ok("chatterCheckinMinutes", 2) && ok("chatterCheckinMinutes", 180));
    assert.ok(!ok("chatterCheckinMinutes", 1) && !ok("chatterCheckinMinutes", 181) && !ok("chatterCheckinMinutes", 12.5));
    assert.ok(ok("chatterBubbleSeconds", 3) && ok("chatterBubbleSeconds", 60));
    assert.ok(!ok("chatterBubbleSeconds", 2) && !ok("chatterBubbleSeconds", 61) && !ok("chatterBubbleSeconds", "12"));
    for (const id of ["deadpan", "wholesome", "anxious", "custom"]) assert.ok(ok("chatterPersonality", id), id);
    assert.ok(!ok("chatterPersonality", "grumpy") && !ok("chatterPersonality", ""));
    assert.ok(ok("chatterCustomPersonality", "") && ok("chatterCustomPersonality", "x".repeat(300)));
    assert.ok(!ok("chatterCustomPersonality", "x".repeat(301)) && !ok("chatterCustomPersonality", 5));
    assert.ok(ok("chatterTriggerMusic", false) && !ok("chatterTriggerMusic", "no"));
    assert.ok(ok("chatterShowBubbles", false) && !ok("chatterShowBubbles", 0));
  });

  it("only take plain model names, since the name goes to Ollama", () => {
    for (const name of ["", "qwen3.5:4b", "hf.co/User/Model-8B:Q4_K_M", "baytout3/qwen3.5-uncensored:9b"]) {
      assert.ok(ok("chatterModel", name), name);
    }
    for (const name of ["a b", "model\n", "../../etc", "x;y", "a".repeat(121), 7, null]) {
      assert.ok(!ok("chatterModel", name), String(name));
    }
  });

  it("a saved file is validated the same way on load", () => {
    const loaded = prefs.validate({
      chatterCheckinMinutes: 9999,
      chatterBubbleSeconds: 20,
      chatterPersonality: "nope",
      chatterModel: "bad name",
    });
    assert.strictEqual(loaded.chatterCheckinMinutes, 12, "out of range falls back to the default");
    assert.strictEqual(loaded.chatterBubbleSeconds, 20);
    assert.strictEqual(loaded.chatterPersonality, "deadpan");
    assert.strictEqual(loaded.chatterModel, "");
  });
});
