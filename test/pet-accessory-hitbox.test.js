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
  resolveAccessoryAwareHitBox,
} = require("../src/pet-accessory-hitbox");

const ROOT = path.join(__dirname, "..");
themeLoader.init(path.join(ROOT, "src"));

function baseHitBox(theme, file) {
  return theme.fileHitBoxes[file] || theme.hitBoxes.default;
}

function expectedUnion(base, descriptor, payload) {
  const frame = descriptor.staticFrame;
  const padding = descriptor.hitBoxPadding || {};
  const width = frame.width * payload.widthScale;
  const height = width / payload.aspect;
  const left = Math.min(base.x, frame.cx - width / 2 - (padding.left || 0));
  const top = Math.min(
    base.y,
    frame.baseY + payload.offsetY - height - (padding.top || 0)
  );
  const right = Math.max(
    base.x + base.w,
    frame.cx + width / 2 + (padding.right || 0)
  );
  const bottom = Math.max(
    base.y + base.h,
    frame.baseY + payload.offsetY + (padding.bottom || 0)
  );
  return { x: left, y: top, w: right - left, h: bottom - top };
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

  it("uses each selected accessory's own dimensions and per-animation motion padding", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    const files = [
      "clawd-working-typing.svg",
      "clawd-headphones-groove.svg",
      "clawd-working-building.svg",
    ];

    for (const file of files) {
      const base = baseHitBox(theme, file);
      const descriptor = theme.customization.accessories.files[file];
      const tops = new Set();
      for (const id of PET_ACCESSORY_IDS.filter((value) => value !== "none")) {
        const payload = resolvePetAccessoryPayload(id, theme);
        const resolved = resolveAccessoryAwareHitBox(
          theme,
          "working",
          file,
          base,
          payload
        );
        assert.deepStrictEqual(resolved, expectedUnion(base, descriptor, payload), `${file}/${id}`);
        tops.add(resolved.y);
      }
      assert.ok(tops.size >= 3, `${file} should not use a one-size-fits-all hat envelope`);
    }
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
