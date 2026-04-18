const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const themeLoader = require("../src/theme-loader");
const hitGeometry = require("../src/hit-geometry");
const {
  getThemeMarginBox,
  collectThemeEnvelopeFiles,
  computeStableVisibleContentMargins,
  getLooseDragMargins,
  getRestClampMargins,
} = require("../src/visible-margins");

themeLoader.init(path.join(__dirname, "..", "src"));

describe("visible margin envelopes", () => {
  const bounds = { x: 0, y: 0, width: 280, height: 280 };

  it("prefers layout.marginBox over contentBox when present", () => {
    const clawd = themeLoader.loadTheme("clawd");
    assert.deepStrictEqual(getThemeMarginBox(clawd), clawd.layout.marginBox);

    const idleFile = clawd.states.idle[0];
    const contentRect = hitGeometry.getContentRectScreen(clawd, bounds, "idle", idleFile, {
      box: clawd.layout.contentBox,
    });
    const marginRect = hitGeometry.getContentRectScreen(clawd, bounds, "idle", idleFile, {
      box: clawd.layout.marginBox,
    });

    assert.ok(marginRect.top < contentRect.top);
    assert.strictEqual(
      Math.round(bounds.y + bounds.height - marginRect.bottom),
      Math.round(bounds.y + bounds.height - contentRect.bottom)
    );
  });

  it("collects a non-mini envelope file set", () => {
    const clawd = themeLoader.loadTheme("clawd");
    const files = collectThemeEnvelopeFiles(clawd);

    assert.ok(files.includes("clawd-working-typing.svg"));
    assert.ok(files.includes("clawd-react-drag.svg"));
    assert.ok(!files.includes("clawd-mini-idle.svg"));
    assert.ok(!files.some((file) => file.startsWith("mini-")));
  });

  it("uses the minimum top and bottom margins across a theme envelope", () => {
    const calico = themeLoader.loadTheme("calico");
    const files = collectThemeEnvelopeFiles(calico);
    const expected = files.reduce((acc, file) => {
      const rect = hitGeometry.getContentRectScreen(calico, bounds, null, file, {
        box: calico.layout.contentBox,
      });
      if (!rect) return acc;
      return {
        top: Math.min(acc.top, Math.max(0, Math.round(rect.top - bounds.y))),
        bottom: Math.min(acc.bottom, Math.max(0, Math.round(bounds.y + bounds.height - rect.bottom))),
      };
    }, { top: Infinity, bottom: Infinity });

    const stable = computeStableVisibleContentMargins(calico, bounds);
    assert.deepStrictEqual(stable, expected);

    const idleRect = hitGeometry.getContentRectScreen(calico, bounds, "idle", calico.states.idle[0], {
      box: calico.layout.contentBox,
    });
    assert.ok(stable.top < Math.round(idleRect.top - bounds.y));
    assert.ok(stable.bottom <= Math.round(bounds.y + bounds.height - idleRect.bottom));
  });
});

describe("edge pinning margin policy", () => {
  it("keeps bottom drag rubber-band unchanged when edge pinning is off", () => {
    const margins = getLooseDragMargins({
      width: 200,
      height: 120,
      visibleMargins: { top: 18, bottom: 9 },
      allowEdgePinning: false,
    });

    assert.deepStrictEqual(margins, {
      marginX: 50,
      marginTop: 48,
      marginBottom: 30,
    });
  });

  it("drops only the top drag protection when edge pinning is on", () => {
    const margins = getLooseDragMargins({
      width: 200,
      height: 120,
      visibleMargins: { top: 18, bottom: 9 },
      allowEdgePinning: true,
    });

    assert.deepStrictEqual(margins, {
      marginX: 50,
      marginTop: 30,
      marginBottom: 30,
    });
  });

  it("preserves rest clamp margins when edge pinning is off", () => {
    assert.deepStrictEqual(
      getRestClampMargins({
        visibleMargins: { top: 22, bottom: 14 },
        allowEdgePinning: false,
      }),
      { top: 22, bottom: 14 }
    );
  });

  it("drops rest clamp margins when edge pinning is on", () => {
    assert.deepStrictEqual(
      getRestClampMargins({
        visibleMargins: { top: 22, bottom: 14 },
        allowEdgePinning: true,
      }),
      { top: 0, bottom: 0 }
    );
  });
});
