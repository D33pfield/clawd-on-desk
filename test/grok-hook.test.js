const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  HOOK_MAP,
  stdoutForEvent,
  deriveSessionTitle,
  normalizeHookName,
  pickSessionId,
  GROK_AGENT_NAMES,
  isGrokCommandLine,
} = require("../hooks/grok-hook");

describe("Grok hook runtime", () => {
  it("maps lifecycle events to idle / thinking / sleeping", () => {
    assert.strictEqual(HOOK_MAP.SessionStart.state, "idle");
    assert.strictEqual(HOOK_MAP.UserPromptSubmit.state, "thinking");
    assert.strictEqual(HOOK_MAP.SessionEnd.state, "sleeping");
  });

  it("maps tool-boundary events to working and subagents to juggling", () => {
    assert.strictEqual(HOOK_MAP.PreToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.SubagentStart.state, "juggling");
  });

  it("maps Stop to attention and Notification to notification", () => {
    assert.strictEqual(HOOK_MAP.Stop.state, "attention");
    assert.strictEqual(HOOK_MAP.Notification.state, "notification");
  });

  it("returns no decision so Grok keeps native permission control", () => {
    assert.strictEqual(stdoutForEvent("PreToolUse"), "{}");
    assert.strictEqual(stdoutForEvent("Stop"), "{}");
  });

  it("reads Grok camelCase session ids and Claude snake_case aliases", () => {
    assert.strictEqual(pickSessionId({ sessionId: "abc" }), "abc");
    assert.strictEqual(pickSessionId({ session_id: "def" }), "def");
  });

  it("normalizes Grok snake_case hookEventName to PascalCase", () => {
    assert.strictEqual(normalizeHookName({ hook_event_name: "PreToolUse" }), "PreToolUse");
    assert.strictEqual(normalizeHookName({ hookEventName: "pre_tool_use" }), "PreToolUse");
  });

  it("derives a title from the first prompt line", () => {
    assert.strictEqual(
      deriveSessionTitle("UserPromptSubmit", { prompt: "fix the login bug\nmore" }),
      "fix the login bug"
    );
  });

  it("matches grok process names", () => {
    assert.ok(GROK_AGENT_NAMES.mac.has("grok"));
    assert.ok(isGrokCommandLine("/Users/a1-6/.grok/bin/grok --yolo"));
    assert.strictEqual(isGrokCommandLine("/usr/bin/claude"), false);
  });
});
