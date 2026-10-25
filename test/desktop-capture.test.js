"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  displayHolding, pickDisplays, cropForWindow, fitSize, createDesktopCapturer,
} = require("../src/desktop-capture");

const left = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const right = { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 };

describe("desktop capture: choosing", () => {
  it("finds the display holding most of a window, or none", () => {
    assert.strictEqual(displayHolding([left, right], { x: 100, y: 100, width: 400, height: 300 }), left);
    assert.strictEqual(displayHolding([left, right], { x: 1800, y: 100, width: 600, height: 300 }), right, "more of it is on the right");
    assert.strictEqual(displayHolding([left, right], { x: 5000, y: 5000, width: 100, height: 100 }), null);
  });

  it("picks monitors: the pet's, the primary, or all", () => {
    const opts = { primaryId: 1, petCenter: { x: 2500, y: 300 } };
    assert.deepStrictEqual(pickDisplays([left, right], "pet", opts), [right]);
    assert.deepStrictEqual(pickDisplays([left, right], "primary", opts), [left]);
    assert.deepStrictEqual(pickDisplays([left, right], "all", opts), [left, right]);
    assert.deepStrictEqual(pickDisplays([left, right], "pet", { primaryId: 2, petCenter: null }), [right], "unknown pet position: primary");
    assert.deepStrictEqual(pickDisplays([], "all", opts), []);
  });

  it("crops a window in the pixels of a scaled display, clamped to it", () => {
    const window = { x: 1920 + 100, y: 50, width: 400, height: 200 };
    assert.deepStrictEqual(cropForWindow(right, window, { width: 1920, height: 1080 }), { x: 150, y: 75, width: 600, height: 300 });
    // Hanging off the display edge: only the part on this display.
    const edge = { x: 1920 + 1200, y: 600, width: 400, height: 400 };
    assert.deepStrictEqual(cropForWindow(right, edge, { width: 1920, height: 1080 }), { x: 1800, y: 900, width: 120, height: 180 });
    // A capture a little smaller than the display scales the crop with it.
    assert.deepStrictEqual(cropForWindow(left, { x: 0, y: 0, width: 960, height: 540 }, { width: 960, height: 540 }), { x: 0, y: 0, width: 480, height: 270 });
    assert.strictEqual(cropForWindow(left, { x: 3000, y: 0, width: 100, height: 100 }, { width: 1920, height: 1080 }), null);
  });

  it("fits the longest edge, never enlarging", () => {
    assert.deepStrictEqual(fitSize(1920, 1080), { width: 1024, height: 576 });
    assert.deepStrictEqual(fitSize(500, 300), { width: 500, height: 300 });
    assert.deepStrictEqual(fitSize(600, 3000), { width: 205, height: 1024 });
  });
});

function fakeImage(width, height, log) {
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    crop: (rect) => { log.push(["crop", rect]); return fakeImage(rect.width, rect.height, log); },
    resize: (size) => { log.push(["resize", size.width, size.height]); return fakeImage(size.width, size.height, log); },
    toJPEG: () => Buffer.from(`jpeg-${width}x${height}`),
  };
  return image;
}

function setupCapturer(overrides = {}) {
  const calls = [];
  const ops = [];
  const electron = {
    desktopCapturer: {
      getSources: async (opts) => {
        calls.push(opts);
        return [left, right].map((d) => ({
          display_id: String(d.id),
          thumbnail: fakeImage(Math.min(opts.thumbnailSize.width, Math.round(d.bounds.width * d.scaleFactor)),
            Math.min(opts.thumbnailSize.height, Math.round(d.bounds.height * d.scaleFactor)), ops),
        }));
      },
    },
    screen: {
      getAllDisplays: () => [left, right],
      getPrimaryDisplay: () => left,
      screenToDipRect: (win, rect) => ({ ...rect }),
    },
  };
  const capturer = createDesktopCapturer({
    electron,
    platform: "win32",
    ownPid: 4242,
    getPetCenter: () => ({ x: 2500, y: 300 }),
    readForeground: overrides.readForeground || (() => ({ ok: true, pid: 99, title: "Editor", rect: { left: 100, top: 100, right: 700, bottom: 500 } })),
  });
  return { capturer, calls, ops };
}

describe("desktop capture: the capturer", () => {
  it("never captures a window of its own process, nor the desktop, nor a missing window", async () => {
    for (const [fg, reason] of [
      [{ ok: true, pid: 4242, title: "Clawd", rect: { left: 0, top: 0, right: 100, bottom: 100 } }, "foreground-is-own-window"],
      [{ ok: true, pid: 5, title: "Program Manager", rect: { left: 0, top: 0, right: 1920, bottom: 1080 } }, "foreground-is-desktop"],
      [{ ok: false, reason: "no-foreground-window" }, "no-foreground-window"],
      [{ ok: false, reason: "foreground-minimized" }, "foreground-minimized"],
    ]) {
      const t = setupCapturer({ readForeground: () => fg });
      const result = await t.capturer.capture({ scope: "window", monitor: "pet" });
      assert.deepStrictEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason });
      assert.strictEqual(t.calls.length, 0, `${reason}: the screen was never even asked`);
    }
  });

  it("refuses a window that is off every display instead of capturing the screen", async () => {
    const t = setupCapturer({ readForeground: () => ({ ok: true, pid: 9, title: "x", rect: { left: 9000, top: 9000, right: 9100, bottom: 9100 } }) });
    const result = await t.capturer.capture({ scope: "window", monitor: "all" });
    assert.strictEqual(result.reason, "window-off-screen");
    assert.strictEqual(t.calls.length, 0);
  });

  it("window scope: asks for screens only, at the display's pixel size, then crops and shrinks", async () => {
    const t = setupCapturer();
    const result = await t.capturer.capture({ scope: "window", monitor: "all" });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(t.calls[0].types, ["screen"], "never asks for window sources");
    assert.deepStrictEqual(t.calls[0].thumbnailSize, { width: 1920, height: 1080 });
    assert.deepStrictEqual(t.ops[0], ["crop", { x: 100, y: 100, width: 600, height: 400 }]);
    assert.strictEqual(result.images.length, 1);
    assert.strictEqual(result.images[0].displayId, 1, "the monitor setting does not widen a window capture");
    assert.ok(Buffer.isBuffer(result.images[0].buffer));
  });

  it("screen scope: the pet's monitor, the primary, or all, each at most 1024 px", async () => {
    const pet = await setupCapturer().capturer.capture({ scope: "screen", monitor: "pet" });
    assert.deepStrictEqual(pet.images.map((i) => i.displayId), [2]);
    const primary = await setupCapturer().capturer.capture({ scope: "screen", monitor: "primary" });
    assert.deepStrictEqual(primary.images.map((i) => i.displayId), [1]);
    const t = setupCapturer();
    const all = await t.capturer.capture({ scope: "screen", monitor: "all" });
    assert.deepStrictEqual(all.images.map((i) => i.displayId), [1, 2]);
    assert.deepStrictEqual(t.calls[0].thumbnailSize, { width: 1024, height: 1024 });
  });

  it("does nothing off Windows, and reports a capture error instead of throwing", async () => {
    const off = createDesktopCapturer({ electron: setupCapturer.electron || { desktopCapturer: {}, screen: {} }, platform: "linux" });
    assert.strictEqual((await off.capture({ scope: "screen" })).reason, "unsupported-platform");
    const broken = createDesktopCapturer({
      electron: { desktopCapturer: { getSources: async () => { throw new Error("denied"); } }, screen: { getAllDisplays: () => [left], getPrimaryDisplay: () => left } },
      platform: "win32", readForeground: () => ({ ok: false, reason: "x" }),
    });
    const result = await broken.capture({ scope: "screen", monitor: "primary" });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /capture-error:denied/);
  });

  it("never writes to disk", () => {
    const source = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "desktop-capture.js"), "utf8");
    assert.doesNotMatch(source, /require\(["']fs["']\)|writeFile|createWriteStream|appendFile|\.toPNG\(|savePage|capturePage/);
  });
});
