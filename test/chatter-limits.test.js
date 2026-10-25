"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { MAX_CUSTOM_PERSONALITY_CHARS, MAX_MODEL_NAME_CHARS, isValidChatterModel, isValidCustomPersonality } = require("../src/chatter-limits");
const prefs = require("../src/prefs");
const { updateRegistry } = require("../src/settings-actions");

describe("chatter limits", () => {
  it("accepts plain model names, including an empty one, and refuses odd ones", () => {
    for (const name of ["", "qwen3.5:4b", "hf.co/User/Model-8B:Q4_K_M", "someone/example-model:9b"]) assert.ok(isValidChatterModel(name), name);
    for (const name of ["../etc/passwd", "/abs/path", "a b", "a;b", "x".repeat(MAX_MODEL_NAME_CHARS + 1), 5, null, undefined]) {
      assert.ok(!isValidChatterModel(name), String(name));
    }
    assert.ok(isValidChatterModel("x".repeat(MAX_MODEL_NAME_CHARS)));
  });

  it("limits custom personality text", () => {
    assert.ok(isValidCustomPersonality("") && isValidCustomPersonality("x".repeat(MAX_CUSTOM_PERSONALITY_CHARS)));
    assert.ok(!isValidCustomPersonality("x".repeat(MAX_CUSTOM_PERSONALITY_CHARS + 1)));
    assert.ok(!isValidCustomPersonality(7));
  });

  it("the prefs file and the Settings update path agree, because they share these checks", () => {
    const ok = (key, value) => updateRegistry[key](value).status === "ok";
    const stored = (key, value) => prefs.validate({ ...prefs.getDefaults(), [key]: value })[key] === value;
    for (const value of ["", "qwen3.5:4b", "../bad", "/abs", "x".repeat(121)]) {
      assert.strictEqual(ok("chatterModel", value), stored("chatterModel", value), `model ${value.slice(0, 12)}`);
    }
    for (const value of ["", "x".repeat(300), "x".repeat(301)]) {
      assert.strictEqual(ok("chatterCustomPersonality", value), stored("chatterCustomPersonality", value), `custom ${value.length}`);
    }
  });
});
