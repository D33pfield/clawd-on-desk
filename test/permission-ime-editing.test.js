"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

// The macOS IME-occlusion fix spans three processes: the bubble renderer
// detects text-input focus, the preload forwards it over IPC, and the main
// process (permission.js) drops the bubble out of always-on-top while a text
// field is focused. This smoke test guards the wiring end to end so a change
// in one file that silently breaks the chain gets caught.
function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");
}

describe("macOS IME editing wiring", () => {
  it("renderer reports text-input focus/blur to the main process", () => {
    const renderer = read("bubble-renderer.js");
    assert.match(renderer, /addEventListener\("focusin"/);
    assert.match(renderer, /addEventListener\("focusout"/);
    assert.match(renderer, /setImeEditing\(true\)/);
    assert.match(renderer, /setImeEditing\(false\)/);
  });

  it("preload exposes setImeEditing over the bubble-ime-editing channel", () => {
    const preload = read("preload-bubble.js");
    assert.match(preload, /setImeEditing:/);
    assert.match(preload, /"bubble-ime-editing"/);
  });

  it("permission main handles the channel and toggles always-on-top", () => {
    const permission = read("permission.js");
    assert.match(permission, /on\("bubble-ime-editing"/);
    assert.match(permission, /function handleImeEditing/);
    assert.match(permission, /__clawdMacImeEditing = true/);
    assert.match(permission, /setAlwaysOnTop\(false\)/);
    // Text-input bubbles opt out of the native SkyLight stationary treatment.
    assert.match(permission, /__clawdMacTextInputBubble = true/);
  });
});
