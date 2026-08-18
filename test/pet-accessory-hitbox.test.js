"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const {
  PET_ACCESSORY_IDS,
  resolvePetAccessoryPayload,
} = require("../src/pet-customization-catalog");
const {
  BUILTIN_ACCESSORY_MOTION_PADDING,
  resolveAccessoryAwareHitBox,
} = require("../src/pet-accessory-hitbox");

const ROOT = path.join(__dirname, "..");
themeLoader.init(path.join(ROOT, "src"));

function baseHitBox(theme, file) {
  return theme.fileHitBoxes[file] || theme.hitBoxes.default;
}

describe("accessory-aware hit boxes", () => {
  it("does not add a transparent hat region when no accessory is worn", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    for (const file of [
      "clawd-working-typing.svg",
      "clawd-headphones-groove.svg",
      "clawd-working-building.svg",
    ]) {
      const base = baseHitBox(theme, file);
      assert.strictEqual(
        resolveAccessoryAwareHitBox(
          theme,
          "working",
          file,
          base,
          resolvePetAccessoryPayload("none", theme)
        ),
        base,
        file
      );
    }
  });

  it("keeps selected-accessory geometry size-aware without a one-size-fits-all envelope", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    for (const file of ["clawd-working-typing.svg", "clawd-working-building.svg"]) {
      const base = baseHitBox(theme, file);
      const tops = new Set();
      const heights = new Set();
      for (const id of PET_ACCESSORY_IDS.filter((value) => value !== "none")) {
        const resolved = resolveAccessoryAwareHitBox(
          theme,
          "working",
          file,
          base,
          resolvePetAccessoryPayload(id, theme)
        );
        assert.ok(resolved.x <= base.x, `${file}/${id} must preserve the base left edge`);
        assert.ok(resolved.y <= base.y, `${file}/${id} must preserve the base top edge`);
        assert.ok(resolved.x + resolved.w >= base.x + base.w, `${file}/${id} must preserve the base right edge`);
        assert.ok(resolved.y + resolved.h >= base.y + base.h, `${file}/${id} must preserve the base bottom edge`);
        tops.add(resolved.y);
        heights.add(resolved.h);
      }
      assert.ok(tops.size >= 3, `${file} should react to the selected accessory's dimensions`);
      assert.ok(heights.size >= 3, `${file} should not use a single tall transparent envelope`);
    }
  });

  it("keeps measured animated motion envelopes separate from authored theme padding", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    const file = "clawd-headphones-groove.svg";
    const authored = theme.customization.accessories.files[file].hitBoxPadding;
    const measured = BUILTIN_ACCESSORY_MOTION_PADDING.clawd[file];

    // The original authored 1.5-unit padding is intentionally retained in the
    // theme. Chromium sampling showed it misses horizontally, so the built-in
    // runtime envelope supplies the measured correction instead of mutating
    // public theme metadata or teaching this unit test the production union formula.
    assert.strictEqual(authored.left, 1.5);
    assert.strictEqual(authored.right, 1.5);
    assert.ok(measured.left > authored.left);
    assert.ok(measured.right > authored.right);
  });

  it("keeps hidden accessories from changing the animation hitbox", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    const file = "clawd-collapse-sleep.svg";
    const base = baseHitBox(theme, file);
    assert.strictEqual(
      resolveAccessoryAwareHitBox(
        theme,
        "collapsing",
        file,
        base,
        resolvePetAccessoryPayload("wizard-hat", theme)
      ),
      base
    );
  });
});
