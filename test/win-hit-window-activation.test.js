"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createHitWindowActivationController,
  createHitWindowFocusableSetter,
  WS_EX_NOACTIVATE,
  STYLE_REFRESH_FLAGS,
} = require("../src/win-hit-window-activation");

function makeHarness({ initialStyle = 0n, electronFocusable = false, refreshResult = true } = {}) {
  let style = initialStyle;
  const nativeCalls = [];
  const electronCalls = [];
  const hwnd = { id: 42 };
  const win = {
    isDestroyed: () => false,
    isFocusable: () => electronFocusable,
    setFocusable(value) {
      electronFocusable = !!value;
      electronCalls.push(value);
    },
  };
  const controller = createHitWindowActivationController({
    isWin: true,
    pointerBits: 64,
    hwndOf: (candidate) => candidate === win ? hwnd : null,
    bindings: {
      getStyle(candidate) {
        assert.strictEqual(candidate, hwnd);
        nativeCalls.push(["getStyle"]);
        return style;
      },
      setStyle(candidate, next) {
        assert.strictEqual(candidate, hwnd);
        nativeCalls.push(["setStyle", next]);
        style = BigInt.asUintN(64, BigInt(next));
        return 0n;
      },
      refreshStyle(candidate) {
        assert.strictEqual(candidate, hwnd);
        nativeCalls.push(["refreshStyle", STYLE_REFRESH_FLAGS]);
        return refreshResult;
      },
    },
  });
  return {
    controller,
    win,
    nativeCalls,
    electronCalls,
    getStyle: () => style,
  };
}

describe("Windows hit-window activation controller", () => {
  it("adds WS_EX_NOACTIVATE without calling Electron setFocusable(false)", () => {
    const h = makeHarness({ initialStyle: 0x00080088n });

    assert.equal(h.controller.setFocusable(h.win, false), true);

    assert.equal((h.getStyle() & WS_EX_NOACTIVATE) !== 0n, true);
    assert.deepStrictEqual(h.electronCalls, []);
    assert.deepStrictEqual(h.nativeCalls, [
      ["getStyle"],
      ["setStyle", 0x08080088n],
      ["refreshStyle", STYLE_REFRESH_FLAGS],
      ["getStyle"],
    ]);
  });

  it("is idempotent while the hit window is already non-activating", () => {
    const h = makeHarness({ initialStyle: WS_EX_NOACTIVATE | 0x88n });

    assert.equal(h.controller.setFocusable(h.win, false), true);

    assert.deepStrictEqual(h.nativeCalls, [["getStyle"]]);
    assert.deepStrictEqual(h.electronCalls, []);
  });

  it("removes only WS_EX_NOACTIVATE when fullscreen ends", () => {
    const h = makeHarness({ initialStyle: WS_EX_NOACTIVATE | 0x00080088n });

    assert.equal(h.controller.setFocusable(h.win, true), true);

    assert.equal(h.getStyle(), 0x00080088n);
    assert.deepStrictEqual(h.electronCalls, []);
  });

  it("keeps Electron focusability disabled when native activation is restored", () => {
    const h = makeHarness({
      initialStyle: WS_EX_NOACTIVATE | 0x88n,
      electronFocusable: false,
    });

    assert.equal(h.controller.setFocusable(h.win, true), true);

    assert.deepStrictEqual(h.electronCalls, []);
    assert.equal((h.getStyle() & WS_EX_NOACTIVATE) !== 0n, false);
  });

  it("never falls back to the focus-stealing Electron false call when native refresh fails", () => {
    const h = makeHarness({ refreshResult: false });

    assert.equal(h.controller.setFocusable(h.win, false), false);
    assert.deepStrictEqual(h.electronCalls, []);
  });

  it("degrades without mutating Electron focusability when native bindings are unavailable", () => {
    const calls = [];
    const errors = [];
    const win = {
      isDestroyed: () => false,
      setFocusable: (value) => calls.push(value),
    };
    const unavailable = createHitWindowActivationController({
      isWin: true,
      koffi: { load() { throw new Error("user32 unavailable"); } },
      onError: (error) => errors.push(error.message),
    });

    assert.equal(unavailable.available, false);
    assert.equal(unavailable.setFocusable(win, false), false);
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(errors, ["user32 unavailable"]);
  });

  it("routes main's fullscreen focusability changes through the native controller", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const start = mainSource.indexOf("const setHitWinFocusable = createHitWindowFocusableSetter({");
    const end = mainSource.indexOf("// ── Mini Mode", start);
    assert.ok(start >= 0 && end > start);
    const setterSource = mainSource.slice(start, end);

    assert.match(setterSource, /controller:\s*_hitWindowActivationController/);
    assert.match(setterSource, /getHitWindow:\s*\(\)\s*=>\s*hitWin/);
    assert.doesNotMatch(mainSource, /hitWin\.setFocusable\(/);
    assert.match(mainSource, /setHitWinFocusable,\s*\n/);
    assert.match(
      mainSource,
      /windowsHitWindowFocusable:\s*isWin\s*&&\s*!_hitWindowActivationController\.available/,
    );
  });

  it("the main-wiring setter delegates dynamically to the owned hit window", () => {
    const calls = [];
    let hitWin = { id: 1 };
    const setter = createHitWindowFocusableSetter({
      isWin: true,
      controller: {
        setFocusable: (win, focusable) => {
          calls.push([win.id, focusable]);
          return true;
        },
      },
      getHitWindow: () => hitWin,
    });

    assert.equal(setter(false), true);
    hitWin = { id: 2 };
    assert.equal(setter(true), true);
    assert.deepStrictEqual(calls, [[1, false], [2, true]]);
  });
});
