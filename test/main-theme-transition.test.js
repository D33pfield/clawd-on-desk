const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const MAIN_JS = path.join(__dirname, "..", "src", "main.js");

describe("main theme transition wiring", () => {
  it("fades the render window out before theme reload and back in after load", () => {
    const source = fs.readFileSync(MAIN_JS, "utf8");

    assert.ok(
      source.includes('require("./theme-fade-sequencer")'),
      "main should delegate raw theme fade/reload sequencing"
    );
    assert.match(source, /THEME_SWITCH_FADE_OUT_MS\s*=\s*140/);
    assert.match(source, /THEME_SWITCH_FADE_IN_MS\s*=\s*180/);

    const activateIndex = source.indexOf("function activateTheme(");
    const runIndex = source.indexOf("themeFadeSequencer.run({", activateIndex);
    const syncIndex = source.indexOf("syncRendererStateAfterLoad({ includeStartupRecovery: false })", activateIndex);
    const finishIndex = source.indexOf("const finishThemeReload = ", activateIndex);

    assert.ok(runIndex > activateIndex, "activateTheme should run the theme fade sequencer");
    assert.ok(runIndex > finishIndex, "sequencer should run after the finish callback is defined");
    assert.ok(syncIndex > finishIndex, "renderer sync should stay inside the guarded finish path");
    assert.ok(finishIndex > activateIndex, "theme reload should have one guarded finish path");
    assert.ok(
      source.includes("THEME_SWITCH_FADE_FALLBACK_MS"),
      "theme transition should have an opacity fallback so the window cannot stay transparent"
    );
    assert.ok(source.includes("onFallback: () => finishThemeReload()"));
    assert.ok(source.includes("onReloadFinished: () => finishThemeReload()"));
    assert.match(source, /const finishThemeReload = \(\) =>/);
    assert.ok(
      !source.includes("_buildAnimationAssetProbe"),
      "main should not retain stale private helper references"
    );
  });
});
