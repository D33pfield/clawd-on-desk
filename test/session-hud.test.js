const { describe, it } = require("node:test");
const assert = require("node:assert");

const sessionHud = require("../src/session-hud");
const { computeSessionHudBounds, constants } = sessionHud.__test;

describe("session HUD geometry", () => {
  it("positions below the pet hitbox and clamps horizontally", () => {
    const result = computeSessionHudBounds({
      hitRect: { left: 10, top: 80, right: 90, bottom: 160 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
    });

    assert.deepStrictEqual(result, {
      bounds: {
        x: 0,
        y: 160 + constants.HUD_PET_GAP,
        width: constants.HUD_WIDTH,
        height: constants.HUD_HEIGHT,
      },
      flippedAbove: false,
    });
  });

  it("flips above the hitbox when there is no room below", () => {
    const result = computeSessionHudBounds({
      hitRect: { left: 320, top: 520, right: 400, bottom: 590 },
      workArea: { x: 0, y: 0, width: 800, height: 620 },
    });

    assert.strictEqual(result.flippedAbove, true);
    assert.deepStrictEqual(result.bounds, {
      x: 240,
      y: 520 - constants.HUD_HEIGHT - constants.HUD_PET_GAP,
      width: constants.HUD_WIDTH,
      height: constants.HUD_HEIGHT,
    });
  });
});
