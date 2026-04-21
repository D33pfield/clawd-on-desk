"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_HTML = path.join(__dirname, "..", "src", "settings.html");
const SETTINGS_RENDERER = path.join(__dirname, "..", "src", "settings-renderer.js");

describe("settings renderer browser environment", () => {
  it("loads the size-slider helper as a plain script before settings-renderer", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const helperIndex = html.indexOf('<script src="settings-size-slider.js"></script>');
    const rendererIndex = html.indexOf('<script src="settings-renderer.js"></script>');
    assert.notStrictEqual(helperIndex, -1, "settings.html should load the size-slider helper");
    assert.notStrictEqual(rendererIndex, -1, "settings.html should load settings-renderer.js");
    assert.ok(helperIndex < rendererIndex, "size-slider helper must load before settings-renderer.js");
  });

  it("does not use CommonJS require in settings-renderer.js", () => {
    const source = fs.readFileSync(SETTINGS_RENDERER, "utf8");
    assert.ok(!source.includes('require("./settings-size-slider")'));
    assert.ok(source.includes("globalThis.ClawdSettingsSizeSlider"));
  });

  it("does not animate the size bubble's horizontal position", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const match = html.match(/\.size-bubble\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, "settings.html should define a .size-bubble rule");
    assert.ok(!/transition:\s*left\b/.test(match[1]));
    assert.ok(/transition:\s*transform 0\.14s ease,\s*box-shadow 0\.18s ease;/.test(match[1]));
  });

  it("renders the size bubble tail as a separated double-layer callout instead of overlapping the pill", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(/--size-bubble-tail-size:\s*4px;/.test(html));
    assert.ok(/--size-bubble-tail-inner-size:\s*3px;/.test(html));
    assert.ok(/--size-bubble-tail-gap:\s*1px;/.test(html));
    assert.ok(/padding-top:\s*29px;/.test(html));
    assert.ok(/\.size-bubble\s*\{[\s\S]*top:\s*6px;[\s\S]*border-radius:\s*9px;[\s\S]*padding:\s*0 7px;[\s\S]*line-height:\s*1\.2;[\s\S]*\}/.test(html));
    assert.ok(/\.size-bubble::before,\s*\.size-bubble::after\s*\{/.test(html));
    assert.ok(/\.size-bubble::before\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*var\(--size-bubble-tail-gap\)\);[\s\S]*border-top:\s*var\(--size-bubble-tail-size\)\s+solid\s+var\(--accent\);[\s\S]*\}/.test(html));
    assert.ok(/\.size-bubble::after\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*var\(--size-bubble-tail-gap\)\);[\s\S]*border-top:\s*var\(--size-bubble-tail-inner-size\)\s+solid\s+var\(--panel-bg\);[\s\S]*\}/.test(html));
    assert.ok(!/\.size-bubble::after\s*\{[\s\S]*margin-top:\s*-1px;/.test(html));
  });
});

describe("macOS platform detection (Settings shortcut labels)", () => {
  // Mirrors the top-level IS_MAC expression in settings-renderer.js. Because
  // that const runs inside the Settings window's DOM context, we can't eval
  // it from node directly — so we (a) lock the source expression shape with a
  // string check, and (b) spot-check the logic against all navigator.platform
  // values macOS has been known to emit.
  const isMac = (platform) => (platform || "").startsWith("Mac");

  it("keeps the unified (navigator.platform startsWith 'Mac') check", () => {
    const source = fs.readFileSync(SETTINGS_RENDERER, "utf8");
    assert.ok(
      source.includes('(navigator.platform || "").startsWith("Mac")'),
      "settings-renderer.js must use startsWith('Mac'); word-boundary regex caused #135"
    );
  });

  it("detects every known macOS navigator.platform value", () => {
    // Values Apple has shipped across Intel / Apple Silicon / PPC / legacy.
    // If any later Electron/OS build emits something outside this set, the
    // Shortcut tab will silently fall back to Windows labels — catch here.
    assert.strictEqual(isMac("MacIntel"), true);
    assert.strictEqual(isMac("MacPPC"), true);
    assert.strictEqual(isMac("Mac68K"), true);
    assert.strictEqual(isMac("MacARM64"), true);
  });

  it("returns false for non-macOS platforms and degenerate values", () => {
    assert.strictEqual(isMac("Win32"), false);
    assert.strictEqual(isMac("Linux x86_64"), false);
    assert.strictEqual(isMac("iPhone"), false);
    assert.strictEqual(isMac(""), false);
    assert.strictEqual(isMac(undefined), false);
    assert.strictEqual(isMac(null), false);
  });
});
