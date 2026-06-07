// test/linux-ozone.test.js — Unit tests for src/linux-ozone.js (issue #441)
const { describe, it } = require("node:test");
const assert = require("node:assert");

const { resolveLinuxOzonePlatform } = require("../src/linux-ozone");

// resolve(platform, env, cliOzonePlatform)
const resolve = (platform, env, cli) =>
  resolveLinuxOzonePlatform({ platform, env, cliOzonePlatform: cli });

describe("resolveLinuxOzonePlatform()", () => {
  it("returns null on non-Linux platforms regardless of env", () => {
    const waylandEnv = { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" };
    assert.strictEqual(resolve("darwin", waylandEnv), null);
    assert.strictEqual(resolve("win32", waylandEnv), null);
  });

  describe("explicit CLAWD_OZONE_PLATFORM override (highest priority)", () => {
    it("=x11 forces XWayland", () => {
      assert.strictEqual(resolve("linux", { CLAWD_OZONE_PLATFORM: "x11" }), "x11");
    });

    it("=x11 wins even with no DISPLAY (user asked for it explicitly)", () => {
      assert.strictEqual(
        resolve("linux", { CLAWD_OZONE_PLATFORM: "x11", XDG_SESSION_TYPE: "wayland" }),
        "x11"
      );
    });

    it("=wayland forces native Wayland", () => {
      assert.strictEqual(resolve("linux", { CLAWD_OZONE_PLATFORM: "wayland" }), "wayland");
    });

    it("=wayland overrides a differing --ozone-platform already on argv", () => {
      assert.strictEqual(
        resolve("linux", { CLAWD_OZONE_PLATFORM: "wayland", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, "x11"),
        "wayland"
      );
    });

    it("=auto leaves things untouched, even with an existing CLI switch", () => {
      assert.strictEqual(
        resolve("linux", { CLAWD_OZONE_PLATFORM: "auto", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }),
        null
      );
      // auto must NOT erase a user's explicit CLI choice
      assert.strictEqual(resolve("linux", { CLAWD_OZONE_PLATFORM: "auto" }, "wayland"), null);
    });

    it("is case-insensitive and trims surrounding whitespace", () => {
      assert.strictEqual(resolve("linux", { CLAWD_OZONE_PLATFORM: "  X11 " }), "x11");
      assert.strictEqual(resolve("linux", { CLAWD_OZONE_PLATFORM: " WAYLAND " }), "wayland");
    });

    it("ignores an unrecognized override value and falls back to detection", () => {
      assert.strictEqual(
        resolve("linux", { CLAWD_OZONE_PLATFORM: "garbage", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }),
        "x11"
      );
    });
  });

  describe("existing --ozone-platform on argv (no env override)", () => {
    it("is respected — auto-detection does not override it", () => {
      assert.strictEqual(
        resolve("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, "wayland"),
        null
      );
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, "x11"), null);
    });

    it("blank/whitespace CLI value is treated as absent → auto-detection runs", () => {
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, "  "), "x11");
    });
  });

  describe("auto-detection (no override, no CLI switch)", () => {
    it("forces x11 on a Wayland session when XWayland (DISPLAY) is available", () => {
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }), "x11");
    });

    it("detects Wayland via WAYLAND_DISPLAY when XDG_SESSION_TYPE is unset", () => {
      assert.strictEqual(resolve("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }), "x11");
    });

    it("does NOT force x11 on Wayland when no DISPLAY (no XWayland) — would crash startup", () => {
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "wayland" }), null);
      assert.strictEqual(resolve("linux", { WAYLAND_DISPLAY: "wayland-0" }), null);
    });

    it("treats whitespace-only DISPLAY / WAYLAND_DISPLAY as absent", () => {
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: "   " }), null);
      assert.strictEqual(resolve("linux", { WAYLAND_DISPLAY: "  ", DISPLAY: ":0" }), null);
    });

    it("leaves a native X11 session alone (already positionable)", () => {
      assert.strictEqual(resolve("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), null);
    });

    it("returns null when there are no Wayland signals at all", () => {
      assert.strictEqual(resolve("linux", {}), null);
      assert.strictEqual(resolve("linux", { DISPLAY: ":0" }), null);
    });
  });
});
