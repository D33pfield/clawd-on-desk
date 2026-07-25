"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { resolveHorizontalEdgeContext } = require("../src/display-edge");

const bounds = (x, y, w, h) => ({ x, y, width: w, height: h });

// Single display: D1 [0,800) x [0,600).
const SINGLE = [
  { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
];

// Two displays tiled side by side: D1 [0,800) and D2 [800,1600), same height.
const SIDE_BY_SIDE = [
  { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
  { bounds: bounds(800, 0, 800, 600), workArea: bounds(800, 0, 800, 600) },
];

const THREE_SIDE_BY_SIDE = [
  { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
  { bounds: bounds(800, 0, 800, 600), workArea: bounds(800, 0, 800, 600) },
  { bounds: bounds(1600, 0, 800, 600), workArea: bounds(1600, 0, 800, 600) },
];

describe("resolveHorizontalEdgeContext", () => {
  it("treats both edges of a single display as outer", () => {
    const wa = SINGLE[0].workArea;
    const ctx = resolveHorizontalEdgeContext({ displays: SINGLE, workArea: wa, yMid: 300 });

    assert.equal(ctx.left.isOuterWorkAreaEdge, true);
    assert.equal(ctx.left.hasAdjacentDisplay, false);
    assert.equal(ctx.left.workAreaBoundary, 0);
    assert.equal(ctx.left.physicalBoundary, 0);

    assert.equal(ctx.right.isOuterWorkAreaEdge, true);
    assert.equal(ctx.right.hasAdjacentDisplay, false);
    assert.equal(ctx.right.workAreaBoundary, 800);
    assert.equal(ctx.right.physicalBoundary, 800);
  });

  it("treats the shared edge between two horizontally adjacent, y-overlapping displays as an internal seam", () => {
    const wa = SIDE_BY_SIDE[0].workArea; // pet lives on D1
    const ctx = resolveHorizontalEdgeContext({ displays: SIDE_BY_SIDE, workArea: wa, yMid: 300 });

    assert.equal(ctx.right.hasAdjacentDisplay, true, "D1's right edge touches D2");
    assert.equal(ctx.right.isOuterWorkAreaEdge, false);
    assert.equal(ctx.right.physicalBoundary, 800);

    assert.equal(ctx.left.hasAdjacentDisplay, false, "nothing to D1's left");
    assert.equal(ctx.left.isOuterWorkAreaEdge, true);
  });

  it("still counts as an internal seam when the neighbour is vertically offset but still covers the pet's yMid", () => {
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
      // D2 shifted down 150px — still overlaps D1's vertical band at yMid≈240.
      { bounds: bounds(800, 150, 800, 600), workArea: bounds(800, 150, 800, 600) },
    ];
    const wa = displays[0].workArea;
    const ctx = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid: 240 });

    assert.equal(ctx.right.hasAdjacentDisplay, true);
    assert.equal(ctx.right.isOuterWorkAreaEdge, false);
  });

  it("treats the edge as outer when the neighbour does not cover the pet's yMid", () => {
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
      // Neighbour starts below the pet's vertical band entirely.
      { bounds: bounds(800, 700, 800, 600), workArea: bounds(800, 700, 800, 600) },
    ];
    const wa = displays[0].workArea;
    const ctx = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid: 300 });

    assert.equal(ctx.right.hasAdjacentDisplay, false);
    assert.equal(ctx.right.isOuterWorkAreaEdge, true);
  });

  it("supports a display with negative coordinates to the left of the origin", () => {
    // D1 sits to the left of the origin: [-800,0). D2 is the primary [0,800).
    const displays = [
      { bounds: bounds(-800, 0, 800, 600), workArea: bounds(-800, 0, 800, 600) },
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
    ];
    const wa = displays[1].workArea; // pet lives on D2
    const ctx = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid: 300 });

    assert.equal(ctx.left.hasAdjacentDisplay, true, "D2's left edge touches D1 at x=0");
    assert.equal(ctx.left.isOuterWorkAreaEdge, false);
    assert.equal(ctx.left.physicalBoundary, 0);

    assert.equal(ctx.right.hasAdjacentDisplay, false);
    assert.equal(ctx.right.isOuterWorkAreaEdge, true);
    assert.equal(ctx.right.physicalBoundary, 800);
  });

  it("treats both edges of the middle display in a three-monitor row as seams", () => {
    const wa = THREE_SIDE_BY_SIDE[1].workArea; // pet on the middle display
    const ctx = resolveHorizontalEdgeContext({ displays: THREE_SIDE_BY_SIDE, workArea: wa, yMid: 300 });

    assert.equal(ctx.left.hasAdjacentDisplay, true);
    assert.equal(ctx.left.isOuterWorkAreaEdge, false);
    assert.equal(ctx.left.physicalBoundary, 800);

    assert.equal(ctx.right.hasAdjacentDisplay, true);
    assert.equal(ctx.right.isOuterWorkAreaEdge, false);
    assert.equal(ctx.right.physicalBoundary, 1600);
  });

  it("keeps a dock-inset edge a seam when a display still touches beyond it", () => {
    // D1's workArea is narrower than its bounds (a right-side dock/panel).
    // D2's workArea is also inset on its left. The two displays' physical
    // bounds still touch at x=800, so this stays an internal seam: the pet
    // can still cross to D2 and mini's seam clip still applies. The dock only
    // changes *where* a clamp would land (workAreaBoundary=770), never
    // whether the edge is outer — reporting both flags true would enable
    // horizontal virtualization and the seam clip at the same time.
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 770, 560) },
      { bounds: bounds(800, 0, 800, 600), workArea: bounds(830, 0, 770, 560) },
    ];
    const wa = displays[0].workArea;
    const ctx = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid: 280 });

    assert.equal(ctx.right.workAreaBoundary, 770);
    assert.equal(ctx.right.physicalBoundary, 800);
    assert.equal(ctx.right.hasAdjacentDisplay, true, "physical bounds still touch");
    assert.equal(ctx.right.isOuterWorkAreaEdge, false, "a dock does not change the topology");
  });

  it("reports a dock-inset outer edge with the workArea boundary, not the display bounds edge", () => {
    // Single display with a right-side dock: nothing beyond it, so this edge
    // IS outer — and a clamp must land at the dock edge (770), not at the
    // physical display edge (800). This is how plan rule 1 actually takes
    // effect: through workAreaBoundary's value, not through the outer flag.
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 770, 560) },
    ];
    const ctx = resolveHorizontalEdgeContext({
      displays, workArea: displays[0].workArea, yMid: 280,
    });

    assert.equal(ctx.right.isOuterWorkAreaEdge, true);
    assert.equal(ctx.right.hasAdjacentDisplay, false);
    assert.equal(ctx.right.workAreaBoundary, 770);
    assert.equal(ctx.right.physicalBoundary, 800);
  });

  it("stays conservative when yMid is missing or not finite", () => {
    const ctx = resolveHorizontalEdgeContext({
      displays: SIDE_BY_SIDE, workArea: SIDE_BY_SIDE[0].workArea,
    });

    assert.equal(ctx.right.hasAdjacentDisplay, false, "matches seamBoundary()'s existing behavior");
    assert.equal(ctx.right.isOuterWorkAreaEdge, false, "unknown topology must not enable virtualization");
    assert.equal(ctx.left.isOuterWorkAreaEdge, false);
  });

  it("does not count a physical gap between displays as a seam", () => {
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
      // 50px gap between D1's right edge (800) and D2's left edge (850).
      { bounds: bounds(850, 0, 800, 600), workArea: bounds(850, 0, 800, 600) },
    ];
    const wa = displays[0].workArea;
    const ctx = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid: 300 });

    assert.equal(ctx.right.hasAdjacentDisplay, false);
    assert.equal(ctx.right.isOuterWorkAreaEdge, true);
  });

  it("falls back to a single-display topology without NaN when the display list is empty or damaged", () => {
    const wa = bounds(0, 0, 800, 600);

    const empty = resolveHorizontalEdgeContext({ displays: [], workArea: wa, yMid: 300 });
    assert.equal(Number.isFinite(empty.left.workAreaBoundary), true);
    assert.equal(Number.isFinite(empty.left.physicalBoundary), true);
    assert.equal(empty.left.hasAdjacentDisplay, false);
    assert.equal(empty.left.isOuterWorkAreaEdge, true);
    assert.equal(empty.right.isOuterWorkAreaEdge, true);

    const damaged = resolveHorizontalEdgeContext({
      displays: [
        { bounds: bounds(0, 0, NaN, 600), workArea: bounds(0, 0, 800, 600) },
        { bounds: null, workArea: bounds(800, 0, 800, 600) },
        undefined,
      ],
      workArea: wa,
      yMid: 300,
    });
    assert.equal(Number.isFinite(damaged.left.workAreaBoundary), true);
    assert.equal(Number.isFinite(damaged.left.physicalBoundary), true);
    assert.equal(Number.isFinite(damaged.right.workAreaBoundary), true);
    assert.equal(Number.isFinite(damaged.right.physicalBoundary), true);
    assert.equal(damaged.left.isOuterWorkAreaEdge, true);
    assert.equal(damaged.right.isOuterWorkAreaEdge, true);
  });

  it("returns both sides' conclusions from a single call", () => {
    const wa = SIDE_BY_SIDE[0].workArea; // left display of a two-display row
    const ctx = resolveHorizontalEdgeContext({ displays: SIDE_BY_SIDE, workArea: wa, yMid: 300 });

    assert.ok(ctx.left && ctx.right, "both sides present in one result");
    assert.equal(ctx.left.isOuterWorkAreaEdge, true, "nothing to the left of the left display");
    assert.equal(ctx.right.hasAdjacentDisplay, true, "D2 sits right next to it");
  });
});
