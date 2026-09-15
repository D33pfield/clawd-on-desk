"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { resolveMiniEdgeFile } = require("../src/mini-edge-files");

const theme = {
  miniMode: {
    leftEdgeFiles: { "mini-happy.apng": "mini-happy-left.apng" },
  },
};
const LEFT = { miniMode: true, edge: "left" };

describe("resolveMiniEdgeFile", () => {
  it("swaps in the left-edge variant only while mini mode sits on the left edge", () => {
    assert.strictEqual(resolveMiniEdgeFile(theme, "mini-happy.apng", LEFT), "mini-happy-left.apng");
    assert.strictEqual(resolveMiniEdgeFile(theme, "mini-happy.apng", { miniMode: true, edge: "right" }), "mini-happy.apng");
    // Pre-entry crabwalk already knows the edge but is not in mini mode yet.
    assert.strictEqual(resolveMiniEdgeFile(theme, "mini-happy.apng", { miniMode: false, edge: "left" }), "mini-happy.apng");
    assert.strictEqual(resolveMiniEdgeFile(theme, "mini-happy.apng"), "mini-happy.apng");
  });

  it("leaves files without a variant, and themes without the map, untouched", () => {
    assert.strictEqual(resolveMiniEdgeFile(theme, "mini-idle.apng", LEFT), "mini-idle.apng");
    assert.strictEqual(resolveMiniEdgeFile({ miniMode: {} }, "mini-happy.apng", LEFT), "mini-happy.apng");
    assert.strictEqual(resolveMiniEdgeFile({}, "mini-happy.apng", LEFT), "mini-happy.apng");
    assert.strictEqual(resolveMiniEdgeFile(null, "mini-happy.apng", LEFT), "mini-happy.apng");
    assert.strictEqual(resolveMiniEdgeFile(theme, null, LEFT), null);
  });

  it("ignores inherited keys and non-string variants", () => {
    const inherited = { miniMode: { leftEdgeFiles: Object.create({ "a.apng": "a-left.apng" }) } };
    assert.strictEqual(resolveMiniEdgeFile(inherited, "a.apng", LEFT), "a.apng");
    assert.strictEqual(resolveMiniEdgeFile(theme, "toString", LEFT), "toString");
    assert.strictEqual(resolveMiniEdgeFile({ miniMode: { leftEdgeFiles: { "a.apng": 5 } } }, "a.apng", LEFT), "a.apng");
    assert.strictEqual(resolveMiniEdgeFile({ miniMode: { leftEdgeFiles: { "a.apng": "" } } }, "a.apng", LEFT), "a.apng");
  });
});
