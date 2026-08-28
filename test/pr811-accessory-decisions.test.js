"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const accessoryLayout = require("../src/pet-accessory-layout");

const ROOT = path.join(__dirname, "..");
themeLoader.init(path.join(ROOT, "src"));

const VISIBLE_MOUTH_FILES = Object.freeze([
  "clawd-idle-follow.svg",
  "clawd-idle-yawn.svg",
  "clawd-idle-doze.svg",
  "clawd-working-thinking.svg",
  "clawd-working-typing.svg",
  "clawd-headphones-groove.svg",
  "clawd-notification.svg",
  "clawd-working-carrying.svg",
  "clawd-wake.svg",
  "clawd-dizzy.svg",
  "clawd-working-juggling.svg",
  "clawd-idle-look.svg",
  "clawd-idle-reading.svg",
  "clawd-react-left.svg",
  "clawd-react-right.svg",
  "clawd-react-annoyed.svg",
  "clawd-react-double.svg",
  "clawd-react-double-jump.svg",
]);

const HIDDEN_MOUTH_FILES = Object.freeze([
  "clawd-mini-crabwalk.svg",
  "clawd-collapse-sleep.svg",
  "clawd-working-sweeping.svg",
  "clawd-error.svg",
  "clawd-happy.svg",
  "clawd-working-building.svg",
  "clawd-idle-bubble.svg",
  "clawd-working-debugger.svg",
  "clawd-react-drag.svg",
  "clawd-sleeping.svg",
  "clawd-mini-idle.svg",
  "clawd-mini-alert.svg",
  "clawd-mini-happy.svg",
  "clawd-mini-enter.svg",
  "clawd-mini-peek.svg",
  "clawd-mini-typing.svg",
  "clawd-mini-enter-sleep.svg",
  "clawd-mini-sleep.svg",
]);

test("PR #811 mouth policy covers the approved 36 stock sprites exactly", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const files = theme.customization.mouthAccessories.files;

  assert.strictEqual(theme._capabilities.mouthAccessories, true);
  assert.deepStrictEqual(
    new Set(Object.keys(files)),
    new Set([...VISIBLE_MOUTH_FILES, ...HIDDEN_MOUTH_FILES])
  );
  assert.strictEqual(Object.keys(files).length, 36);

  for (const file of VISIBLE_MOUTH_FILES) {
    assert.ok(files[file].staticFrame, `${file} must keep a static fallback`);
    assert.ok(files[file].followTarget, `${file} must follow its rendered animation anchor`);
    assert.notStrictEqual(files[file].visibility, "hidden", file);
  }
  for (const file of HIDDEN_MOUTH_FILES) {
    assert.deepStrictEqual(files[file], { visibility: "hidden" }, file);
  }
});

test("cowboy-only pose policy does not change the other head accessories", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const base = theme.customization.accessories.files;
  const cowboy = theme.customization.accessories.itemOverrides["cowboy-hat"].files;

  assert.deepStrictEqual(base["clawd-error.svg"], { visibility: "hidden" });
  assert.deepStrictEqual(base["clawd-wake.svg"], { visibility: "hidden" });
  assert.ok(cowboy["clawd-error.svg"].staticFrame);
  assert.ok(cowboy["clawd-wake.svg"].staticFrame);
  assert.strictEqual(cowboy["clawd-error.svg"].staticFrame.baseY, 10.5);

  for (const file of [
    "clawd-collapse-sleep.svg",
    "clawd-working-carrying.svg",
    "clawd-sleeping.svg",
    "clawd-working-building.svg",
  ]) {
    assert.deepStrictEqual(cowboy[file], { visibility: "hidden" }, file);
  }
});

test("notification and wake anchors are named on the elements that own their motion", () => {
  const notification = fs.readFileSync(
    path.join(ROOT, "assets", "svg", "clawd-notification.svg"),
    "utf8"
  );
  const wake = fs.readFileSync(
    path.join(ROOT, "assets", "svg", "clawd-wake.svg"),
    "utf8"
  );
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const notificationDescriptor =
    theme.customization.mouthAccessories.files["clawd-notification.svg"];

  assert.match(
    notification,
    /<rect id="mouth-anchor-right" class="arm-l-balance" x="0" y="9" width="2" height="2"/
  );
  assert.deepStrictEqual(notificationDescriptor.followTarget, {
    id: "mouth-anchor-right",
    frame: { cx: 1, baseY: 11, width: 5 },
    normalizeReflection: "x",
  });
  assert.deepStrictEqual(notificationDescriptor.staticFrame, {
    cx: 13.5,
    baseY: 11,
    width: 5,
  });
  assert.match(
    wake,
    /<g id="accessory-anchor" class="once torso-shift">/
  );
});

test("the canonical cigarette frame reproduces the pinned standard-pose coordinates", () => {
  const layout = accessoryLayout.computeDynamicAccessoryLayout({
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    mediaOffset: { x: 0, y: 0 },
    frame: { cx: 14, baseY: 13, width: 5 },
    accessory: { aspect: 5 / 9, widthScale: 1, offsetY: 0 },
    stageSize: { width: 100, height: 100 },
  });

  // The canonical SVG's paper begins at local (0.5, 7). After this frame it
  // lands at (12, 11), exactly matching PR #811's generated CIG fragment.
  assert.deepStrictEqual(layout.matrix, { a: 1, b: 0, c: 0, d: 1, e: 11.5, f: 4 });
  assert.strictEqual(layout.width, 5);
  assert.strictEqual(layout.height, 9);
});

test("every visible animated cigarette has a measured or authored hit envelope", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const files = theme.customization.mouthAccessories.files;
  const measured = require("../src/pet-accessory-hitbox").BUILTIN_ACCESSORY_MOTION_PADDING.clawd;

  for (const file of VISIBLE_MOUTH_FILES) {
    assert.ok(
      measured[file] || files[file].hitBoxPadding,
      `${file} needs a native hit-window motion envelope`
    );
  }
  assert.ok(
    theme.customization.accessories.itemOverrides["cowboy-hat"].files["clawd-wake.svg"]
      .hitBoxPadding,
    "the newly visible wake cowboy hat needs its own one-shot motion envelope"
  );
});
