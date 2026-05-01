"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RENDERER = path.join(__dirname, "..", "src", "renderer.js");

describe("renderer low-power idle mode", () => {
  it("waits for an animation boundary before pausing the current SVG", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("function getLowPowerAnimationBoundaryDelayMs(root)"));
    assert.ok(source.includes("root.getAnimations({ subtree: true })"));
    assert.ok(source.includes("pauseCurrentSvgForLowPower({ waitForBoundary: true })"));
    assert.ok(source.includes("LOW_POWER_BOUNDARY_EPSILON_MS"));
  });

  it("keeps the disabled-mode eye-move path cheap", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("if (!lowPowerIdleMode && !lowPowerSvgPaused) return;"));
  });
});

describe("renderer object-channel selection", () => {
  it("allows built-in trusted scripted SVG files to use <object>", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("_trustedScriptedSvgFiles = new Set"));
    assert.ok(source.includes("return needsEyeTracking(state) || _trustedScriptedSvgFiles.has(file);"));
  });

  it("keeps eye-tracking attachment state-based only", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("function needsEyeTracking(state)"));
    assert.ok(source.includes("if (state && needsEyeTracking(state)) {\n        attachEyeTracking(next);"));
  });
});
