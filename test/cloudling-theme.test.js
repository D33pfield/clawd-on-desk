"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const hitGeometry = require("../src/hit-geometry");

themeLoader.init(path.join(__dirname, "..", "src"));

describe("built-in Cloudling prototype theme", () => {
  it("loads as schema v1 with trusted scripted SVG files scoped to the built-in theme", () => {
    const theme = themeLoader.loadTheme("cloudling", { strict: true });
    const rendererConfig = themeLoader.getRendererConfig();
    const expectedScriptedFiles = [
      "cloudling-idle.svg",
      "cloudling-building.svg",
      "cloudling-mini-enter-roll-in.svg",
      "cloudling-mini-idle.svg",
      "cloudling-mini-crabwalk.svg",
    ];

    assert.strictEqual(theme.schemaVersion, 1);
    assert.strictEqual(theme._builtin, true);
    assert.deepStrictEqual(theme.trustedRuntime.scriptedSvgFiles, expectedScriptedFiles);
    assert.deepStrictEqual(rendererConfig.trustedScriptedSvgFiles, expectedScriptedFiles);
    assert.strictEqual(theme.miniMode.states["mini-crabwalk"][0], "cloudling-mini-crabwalk.svg");

    for (const file of expectedScriptedFiles) {
      assert.ok(
        fs.existsSync(path.join(__dirname, "..", "themes", "cloudling", "assets", file)),
        `${file} should exist in the Cloudling prototype asset folder`
      );
    }
  });

  it("resolves Cloudling viewBoxes for normal, mini, and mini-crabwalk files", () => {
    const theme = themeLoader.loadTheme("cloudling", { strict: true });

    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "working", "cloudling-building.svg"),
      { x: -32, y: -24, width: 88, height: 72 }
    );
    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "mini-idle", "cloudling-mini-idle.svg"),
      { x: -12, y: -12, width: 48, height: 48 }
    );
    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "mini-crabwalk", "cloudling-mini-crabwalk.svg"),
      { x: -32, y: -24, width: 88, height: 72 }
    );
  });

  it("uses object-channel for built-in scripted files without granting that to external-like themes", () => {
    const theme = themeLoader.loadTheme("cloudling", { strict: true });
    const externalLikeTheme = { ...theme, _builtin: false };

    assert.strictEqual(
      hitGeometry.usesObjectChannel(theme, "working", "cloudling-building.svg"),
      true
    );
    assert.strictEqual(
      hitGeometry.usesObjectChannel(externalLikeTheme, "working", "cloudling-building.svg"),
      false
    );
  });
});
