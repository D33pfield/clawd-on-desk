"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPetAccessorySlotsCandidate,
  commitPetAccessorySlotsCandidate,
  getPetAccessorySlotsSnapshot,
  resetPetAccessoryStateForTests,
} = require("../src/pet-accessory-state");

const NONE = { id: "none", assetFile: null, aspect: 1, widthScale: 1, offsetY: 0 };
const HAT = { id: "cowboy-hat", assetFile: "cowboy-hat.svg", aspect: 2, widthScale: 1, offsetY: 0 };
const CIGARETTE = { id: "cigarette", assetFile: "cigarette.svg", aspect: 0.5, widthScale: 1, offsetY: 0 };

test.afterEach(resetPetAccessoryStateForTests);

test("mints one immutable generation for the complete head+mouth candidate and commits that object", () => {
  const theme = { _id: "clawd" };
  const candidate = createPetAccessorySlotsCandidate({ head: HAT, mouth: CIGARETTE }, theme);

  assert.ok(Object.isFrozen(candidate));
  assert.ok(Object.isFrozen(candidate.payloads));
  assert.strictEqual(candidate.themeId, "clawd");
  assert.strictEqual(candidate.accessoryGeneration, 1);
  assert.strictEqual(commitPetAccessorySlotsCandidate(candidate), candidate);
  assert.strictEqual(getPetAccessorySlotsSnapshot(theme), candidate);
});

test("a delivery failure may leave a monotonic generation hole without changing canonical state", () => {
  const theme = { _id: "clawd" };
  const undelivered = createPetAccessorySlotsCandidate({ head: HAT, mouth: NONE }, theme);
  const delivered = createPetAccessorySlotsCandidate({ head: NONE, mouth: CIGARETTE }, theme);

  assert.strictEqual(undelivered.accessoryGeneration, 1);
  assert.strictEqual(delivered.accessoryGeneration, 2);
  assert.strictEqual(getPetAccessorySlotsSnapshot(theme), null);
  commitPetAccessorySlotsCandidate(delivered);
  assert.strictEqual(getPetAccessorySlotsSnapshot(theme), delivered);
});

test("rejects commits that were not minted by the canonical candidate builder", () => {
  assert.throws(
    () => commitPetAccessorySlotsCandidate({
      themeId: "clawd",
      payloads: { head: NONE, mouth: NONE },
      accessoryGeneration: 99,
    }),
    /issued candidate/
  );
});
