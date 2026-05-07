"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RENDERER = path.join(__dirname, "..", "src", "renderer.js");
const PRELOAD = path.join(__dirname, "..", "src", "preload.js");
const MAIN = path.join(__dirname, "..", "src", "main.js");

function readNormalized(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function matchSource(source, pattern, message) {
  const match = source.match(pattern);
  assert.ok(match, message || `missing pattern ${pattern}`);
  return match;
}

describe("renderer low-power idle mode", () => {
  it("waits for an animation boundary before pausing the current SVG", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function getLowPowerAnimationBoundaryDelayMs(root)"));
    assert.ok(source.includes("root.getAnimations({ subtree: true })"));
    assert.ok(source.includes("pauseCurrentSvgForLowPower({ waitForBoundary: true })"));
    assert.ok(source.includes("LOW_POWER_BOUNDARY_EPSILON_MS"));
  });

  it("keeps the disabled-mode eye-move path cheap", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("if (!lowPowerIdleMode && !lowPowerSvgPaused) return;"));
  });

  it("does not treat passive eye or pointer tracking as low-power activity", () => {
    const source = readNormalized(RENDERER);
    const eyeHandler = matchSource(
      source,
      /window\.electronAPI\.onEyeMove\(\(dx, dy\) => \{([\s\S]*?)\n\}\);/,
      "missing eye-move handler"
    )[1];
    const pointerHandler = matchSource(
      source,
      /window\.electronAPI\.onCloudlingPointer\(\(payload\) => \{([\s\S]*?)\n\s+\}\);/,
      "missing Cloudling pointer handler"
    )[1];

    assert.ok(!eyeHandler.includes("noteLowPowerActivity()"));
    assert.ok(!pointerHandler.includes("noteLowPowerActivity()"));
  });

  it("suppresses passive tracking while low-power paused and cancels layered RAF", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function shouldSuppressPassiveTrackingForLowPower()"));
    assert.ok(source.includes("return lowPowerIdleMode && lowPowerSvgPaused && shouldPauseForLowPower();"));
    assert.ok(source.includes("function _cancelLayerAnimLoop()"));
    assert.ok(source.includes("if (next) _cancelLayerAnimLoop();"));
    assert.ok(source.includes("if (shouldSuppressPassiveTrackingForLowPower()) { _layerAnimFrame = null; return; }"));
    assert.ok(source.includes("if (shouldSuppressPassiveTrackingForLowPower()) {\n    _cancelLayerAnimLoop();\n    return;\n  }"));
    assert.ok(source.includes("if (shouldSuppressPassiveTrackingForLowPower()) return;\n  if (!shouldUseCloudlingPointerBridge"));
  });

  it("notifies main only when the low-power paused state changes", () => {
    const source = readNormalized(RENDERER);
    const preload = readNormalized(PRELOAD);

    assert.ok(source.includes("function setLowPowerSvgPaused(paused)"));
    assert.ok(source.includes("if (lowPowerSvgPaused === next) return;"));
    assert.ok(source.includes("window.electronAPI.setLowPowerIdlePaused(next);"));
    assert.ok(preload.includes('setLowPowerIdlePaused: (paused) => ipcRenderer.send("low-power-idle-paused", !!paused)'));
  });

  it("resets main's paused mirror on renderer reload/crash and boosts eye resend on resume", () => {
    const source = readNormalized(MAIN);

    assert.ok(source.includes("function setLowPowerIdlePaused(value)"));
    assert.ok(source.includes("if (!next) setForceEyeResend(true);"));
    assert.ok(source.includes('win.webContents.on("did-start-loading", () => {'));
    assert.ok(source.includes('win.webContents.on("render-process-gone", (_event, details) => {'));
    assert.ok(source.includes("setLowPowerIdlePaused(false);"));
  });
});

describe("renderer object-channel selection", () => {
  it("allows built-in trusted scripted SVG files to use <object>", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("_trustedScriptedSvgFiles = new Set"));
    assert.ok(source.includes("_forceSvgObjectChannel"));
    assert.ok(source.includes("return _forceSvgObjectChannel || needsEyeTracking(state) || _trustedScriptedSvgFiles.has(file);"));
  });

  it("keeps eye-tracking attachment state-based only", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function needsEyeTracking(state)"));
    assert.match(source, /if \(state && needsEyeTracking\(state\)\) {\r?\n\s+attachEyeTracking\(next\);/);
  });

  it("does not hard-code click or drag reactions to the img channel", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("swapToFile(svgFile, null);"));
    assert.ok(source.includes("swapToFile(_dragSvg, null);"));
    assert.ok(!source.includes("swapToFile(svgFile, null, false);"));
    assert.ok(!source.includes("swapToFile(_dragSvg, null, false);"));
  });

  it("uses a monotonic cache-bust counter for remaining img-channel SVG swaps", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("let _imgCacheBustSeq = 0;"));
    assert.ok(source.includes("++_imgCacheBustSeq"));
    assert.ok(source.includes("const cacheBust = `${Date.now()}-${++_imgCacheBustSeq}`;"));
    assert.ok(!source.includes("_t=${Date.now()}"));
  });

  it("deduplicates displayed files by resolved asset URL, not filename alone", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("let currentDisplayedAssetUrl = null;"));
    assert.ok(source.includes("let pendingAssetUrl = null;"));
    assert.ok(source.includes("const desiredAssetUrl = getAssetUrl(svg);"));
    assert.ok(source.includes("currentDisplayedAssetUrl === desiredAssetUrl"));
    assert.ok(source.includes("pendingAssetUrl === desiredAssetUrl"));
  });
});

describe("renderer Cloudling pointer bridge", () => {
  it("bridges only selected Cloudling pointer states through the exporter API", () => {
    const source = fs.readFileSync(RENDERER, "utf8");
    const preload = fs.readFileSync(PRELOAD, "utf8");

    assert.ok(source.includes('const CLOUDLING_POINTER_BRIDGE_STATES = new Set(["idle", "mini-idle", "mini-peek"]);'));
    assert.ok(source.includes('typeof svgWindow.__cloudlingSetPointer === "function"'));
    assert.ok(source.includes('svgWindow.__cloudlingSetPointer(payload);'));
    assert.ok(source.includes('window.electronAPI.onCloudlingPointer((payload) => {'));
    assert.ok(preload.includes('onCloudlingPointer: (callback) => ipcRenderer.on("cloudling-pointer", (_, payload) => callback(payload))'));
  });
});

describe("renderer glyph flip compensation", () => {
  it("flips reverse-drawn mini crabwalk assets during pre-entry without entering mini layout", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("let _miniPreEntryMode = false;"));
    assert.ok(source.includes("_miniPreEntryMode = !!enabled && preEntry;"));
    assert.ok(source.includes("_miniPreEntryMode && state === \"mini-crabwalk\""));
    assert.ok(source.includes("_inMiniMode = !!enabled && !preEntry;"));
    assert.ok(source.includes("applyMiniFlip(next, state);"));
  });

  it("notifies object-channel SVGs when mini-left glyph compensation changes", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("typeof svgWindow.__clawdSetGlyphFlipCompensation === \"function\""));
    assert.ok(source.includes("svgWindow.__clawdSetGlyphFlipCompensation(true);"));
    assert.ok(source.includes("svgWindow.__clawdSetGlyphFlipCompensation(false);"));
  });
});
