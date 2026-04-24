"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  maybeShowClaudeAutoModeNotice,
  readClaudeDefaultMode,
  shouldShowClaudeAutoModeNotice,
} = require("../src/claude-auto-mode-notice");

function makeFs(settings) {
  return {
    readFileSync() {
      if (settings instanceof Error) throw settings;
      return typeof settings === "string" ? settings : JSON.stringify(settings);
    },
  };
}

function makeController(initialShown = false) {
  const state = { claudeAutoModeNoticeShown: initialShown };
  const updates = [];
  return {
    state,
    updates,
    get(key) {
      return state[key];
    },
    applyUpdate(key, value) {
      updates.push({ key, value });
      state[key] = value;
      return { status: "ok" };
    },
  };
}

describe("claude auto mode notice", () => {
  it("reads permissions.defaultMode from Claude settings", () => {
    assert.strictEqual(
      readClaudeDefaultMode({
        fs: makeFs({ permissions: { defaultMode: "auto" } }),
        settingsPath: "/tmp/settings.json",
      }),
      "auto"
    );
  });

  it("treats missing or malformed settings as unknown", () => {
    assert.strictEqual(
      readClaudeDefaultMode({
        fs: makeFs(new Error("missing")),
        settingsPath: "/tmp/settings.json",
      }),
      null
    );
    assert.strictEqual(
      readClaudeDefaultMode({
        fs: makeFs("{not-json"),
        settingsPath: "/tmp/settings.json",
      }),
      null
    );
  });

  it("only shows for auto mode before dismissal", () => {
    assert.strictEqual(
      shouldShowClaudeAutoModeNotice({ defaultMode: "auto", noticeShown: false }),
      true
    );
    assert.strictEqual(
      shouldShowClaudeAutoModeNotice({ defaultMode: "auto", noticeShown: true }),
      false
    );
    assert.strictEqual(
      shouldShowClaudeAutoModeNotice({ defaultMode: "default", noticeShown: false }),
      false
    );
  });

  it("shows once and persists the dismissal flag", async () => {
    const controller = makeController(false);
    const calls = [];
    const result = await maybeShowClaudeAutoModeNotice({
      settingsController: controller,
      fs: makeFs({ permissions: { defaultMode: "auto" } }),
      settingsPath: "/tmp/settings.json",
      dialog: {
        async showMessageBox(parent, options) {
          calls.push({ parent, options });
          return { response: 0 };
        },
      },
      getParent: () => "parent-window",
      lang: "en",
    });

    assert.deepStrictEqual(result, { shown: true, persisted: true, defaultMode: "auto" });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].parent, "parent-window");
    assert.strictEqual(calls[0].options.type, "info");
    assert.deepStrictEqual(controller.updates, [
      { key: "claudeAutoModeNoticeShown", value: true },
    ]);
  });

  it("does not show again after the dismissal flag is set", async () => {
    const controller = makeController(true);
    const calls = [];
    const result = await maybeShowClaudeAutoModeNotice({
      settingsController: controller,
      fs: makeFs({ permissions: { defaultMode: "auto" } }),
      settingsPath: "/tmp/settings.json",
      dialog: {
        async showMessageBox() {
          calls.push("shown");
        },
      },
    });

    assert.deepStrictEqual(result, { shown: false, reason: "already-shown" });
    assert.deepStrictEqual(calls, []);
  });

  it("does not show when Claude default mode is not auto", async () => {
    const controller = makeController(false);
    const calls = [];
    const result = await maybeShowClaudeAutoModeNotice({
      settingsController: controller,
      fs: makeFs({ permissions: { defaultMode: "default" } }),
      settingsPath: "/tmp/settings.json",
      dialog: {
        async showMessageBox() {
          calls.push("shown");
        },
      },
    });

    assert.deepStrictEqual(result, {
      shown: false,
      reason: "not-auto-mode",
      defaultMode: "default",
    });
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(controller.updates, []);
  });
});
