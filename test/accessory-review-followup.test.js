"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const createPetGeometryMain = require("../src/pet-geometry-main");
const { resolveAccessoryAwareHitBox } = require("../src/pet-accessory-hitbox");
const { createHolidayAccessoryRuntime } = require("../src/holiday-accessory");
const schema = require("../src/theme-schema");
const {
  commitPetAccessoryPayload,
  getPetAccessoryPayloadSnapshot,
  resetPetAccessoryStateForTests,
} = require("../src/pet-accessory-state");

const PARTY = {
  id: "party-hat",
  assetFile: "party-hat.svg",
  aspect: 1,
  widthScale: 1,
  offsetY: 0,
};

function accessoryTheme(overrides = {}) {
  return {
    _id: "test-theme",
    _builtin: false,
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: { idle: ["idle.svg"] },
    customization: {
      accessories: {
        default: {
          staticFrame: { cx: 20, baseY: 40, width: 10 },
          hitBoxPadding: { left: 100, top: 100, right: 100, bottom: 100 },
        },
      },
    },
    ...overrides,
  };
}

test.afterEach(() => resetPetAccessoryStateForTests());

test("maximum-valid external accessory metadata cannot expand native input past rendered bounds", () => {
  const raw = {
    schemaVersion: 1,
    name: "Max external accessory fixture",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    sleepSequence: { mode: "direct" },
    states: {
      idle: ["idle.svg"],
      thinking: ["thinking.svg"],
      working: ["working.svg"],
      sleeping: ["sleeping.svg"],
    },
    customization: {
      accessories: {
        default: {
          // staticFrame keeps the pre-existing broad compatibility range; the
          // new public padding is capped to one effective viewBox per side.
          staticFrame: { cx: 200, baseY: 200, width: 400 },
          hitBoxPadding: { left: 100, top: 100, right: 100, bottom: 100 },
        },
      },
    },
  };
  assert.deepStrictEqual(schema.validateTheme(raw), []);
  const theme = schema.mergeDefaults(raw, "max-external", false);
  const base = { x: 45, y: 45, w: 10, h: 10 };
  const hit = resolveAccessoryAwareHitBox(theme, "idle", "idle.svg", base, PARTY);
  assert.ok(hit.x >= 0 && hit.y >= 0);
  assert.ok(hit.x + hit.w <= 100 && hit.y + hit.h <= 100);
});

test("containment preserves an existing base hitbox outside the viewBox", () => {
  const theme = accessoryTheme();
  const base = { x: -20, y: -10, w: 140, h: 125 };
  const hit = resolveAccessoryAwareHitBox(theme, "idle", "idle.svg", base, PARTY);
  assert.deepStrictEqual(hit, base);
});

test("mini accessory mirroring follows edgeLeft XOR miniFlipAssets", () => {
  function resolve(flipAssets, edge) {
    const theme = accessoryTheme({
      miniMode: { viewBox: { x: 0, y: 0, width: 100, height: 100 }, flipAssets },
      customization: {
        accessories: {
          mini: { staticFrame: { cx: 20, baseY: 40, width: 10 } },
          default: { staticFrame: { cx: 20, baseY: 40, width: 10 } },
        },
      },
    });
    commitPetAccessoryPayload(PARTY, theme);
    const hitGeometry = {
      resolveViewBox: () => theme.miniMode.viewBox,
      getHitRectScreen: (_theme, _bounds, _state, _file, box) => ({
        left: box.x,
        top: box.y,
        right: box.x + box.w,
        bottom: box.y + box.h,
      }),
      getAssetRectScreen: () => null,
      getAssetPointerPayload: () => null,
    };
    const geometry = createPetGeometryMain({
      hitGeometry,
      getActiveTheme: () => theme,
      getCurrentState: () => "mini-idle",
      getCurrentSvg: () => "idle.svg",
      getCurrentHitBox: () => ({ x: 45, y: 45, w: 10, h: 10 }),
      getCurrentAccessoryPayload: () => PARTY,
      getMiniMode: () => true,
      getMiniEdge: () => edge,
      getMiniPeekOffset: () => 0,
    });
    return geometry.getHitRectScreen({ x: 0, y: 0, width: 6000, height: 6000 });
  }

  const rightNormal = resolve(false, "right");
  const leftNormal = resolve(false, "left");
  const rightFlipped = resolve(true, "right");
  const leftFlipped = resolve(true, "left");

  assert.ok(rightNormal.left < 45 && rightNormal.right === 55);
  assert.ok(leftNormal.left === 45 && leftNormal.right > 55);
  assert.deepStrictEqual(rightFlipped, leftNormal);
  assert.deepStrictEqual(leftFlipped, rightNormal);
});

test("screen hit rectangles use outward integer rounding", () => {
  const theme = accessoryTheme({ customization: { accessories: null } });
  const geometry = createPetGeometryMain({
    hitGeometry: {
      resolveViewBox: () => theme.viewBox,
      getHitRectScreen: () => ({ left: 1.8, top: 2.2, right: 9.1, bottom: 10.01 }),
      getAssetRectScreen: () => null,
      getAssetPointerPayload: () => null,
    },
    getActiveTheme: () => theme,
    getCurrentState: () => "idle",
    getCurrentSvg: () => "idle.svg",
    getCurrentHitBox: () => ({ x: 1, y: 2, w: 8, h: 8 }),
  });
  assert.deepStrictEqual(
    geometry.getHitRectScreen({ x: 0, y: 0, width: 100, height: 100 }),
    { left: 1, top: 2, right: 10, bottom: 11 }
  );
});

test("geometry consumes the delivered canonical payload instead of re-resolving it", () => {
  const theme = accessoryTheme();
  commitPetAccessoryPayload(PARTY, theme);
  let fallbackResolves = 0;
  const geometry = createPetGeometryMain({
    hitGeometry: {
      resolveViewBox: () => theme.viewBox,
      getHitRectScreen: (_theme, _bounds, _state, _file, box) => ({
        left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h,
      }),
      getAssetRectScreen: () => null,
      getAssetPointerPayload: () => null,
    },
    getActiveTheme: () => theme,
    getCurrentState: () => "idle",
    getCurrentSvg: () => "idle.svg",
    getCurrentHitBox: () => ({ x: 45, y: 45, w: 10, h: 10 }),
    getCurrentAccessoryPayload: () => {
      fallbackResolves += 1;
      return { ...PARTY, id: "wrong-after-midnight" };
    },
  });
  geometry.getHitRectScreen({ x: 0, y: 0, width: 100, height: 100 });
  assert.strictEqual(fallbackResolves, 0);
  assert.strictEqual(getPetAccessoryPayloadSnapshot(theme).payload.id, "party-hat");
});

test("holiday geometry failure retries without resending an unchanged renderer payload", () => {
  const theme = { _id: "clawd", _builtin: true, _capabilities: { accessories: true } };
  let sends = 0;
  let applies = 0;
  const runtime = createHolidayAccessoryRuntime({
    getSettingsSnapshot: () => ({
      petAccessory: { clawd: "wizard-hat" },
      holidayAccessoryEnabled: { clawd: true },
    }),
    getActiveTheme: () => theme,
    sendToRenderer: () => { sends += 1; },
    onAccessoryChange: () => {
      applies += 1;
      if (applies === 1) throw new Error("synthetic hitbox failure");
    },
    now: () => new Date(2026, 11, 24, 12, 0, 0),
    logWarn: () => {},
  });

  assert.strictEqual(runtime.refresh(), false);
  assert.strictEqual(sends, 1);
  assert.strictEqual(applies, 1);
  assert.strictEqual(runtime.refresh(), true);
  assert.strictEqual(sends, 1);
  assert.strictEqual(applies, 2);
});
