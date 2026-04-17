"use strict";

// Unit tests for hooks/clawd-hook.js pure helpers.
// Tests `buildStateBody` — the body-construction logic extracted from main().
// The top-level `main()` path (stdin read, HTTP post, process.exit) is not
// tested here; its side effects are exercised by manual / end-to-end runs.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");

const { buildStateBody } = require("../hooks/clawd-hook.js");

const mockResolve = () => ({
  stablePid: null,
  agentPid: null,
  detectedEditor: null,
  pidChain: [],
});

describe("buildStateBody", () => {
  it("returns null for unknown events", () => {
    assert.strictEqual(buildStateBody("UnknownEvent", {}, mockResolve), null);
  });

  it("returns null for empty event name", () => {
    assert.strictEqual(buildStateBody("", {}, mockResolve), null);
  });

  it("builds body with state + session_id + event + agent_id", () => {
    const body = buildStateBody(
      "SessionStart",
      { session_id: "sid-1", cwd: "/tmp/p" },
      mockResolve
    );
    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.session_id, "sid-1");
    assert.strictEqual(body.event, "SessionStart");
    assert.strictEqual(body.agent_id, "claude-code");
    assert.strictEqual(body.cwd, "/tmp/p");
  });

  it("maps PreToolUse to working state", () => {
    const body = buildStateBody("PreToolUse", { session_id: "s" }, mockResolve);
    assert.strictEqual(body.state, "working");
  });

  it("maps Stop to attention state", () => {
    const body = buildStateBody("Stop", { session_id: "s" }, mockResolve);
    assert.strictEqual(body.state, "attention");
  });

  it("maps SubagentStart to juggling state", () => {
    const body = buildStateBody("SubagentStart", { session_id: "s" }, mockResolve);
    assert.strictEqual(body.state, "juggling");
  });

  it("remaps SessionEnd + source=clear to sweeping state", () => {
    const body = buildStateBody(
      "SessionEnd",
      { session_id: "sid-1", source: "clear" },
      mockResolve
    );
    assert.strictEqual(body.state, "sweeping");
  });

  it("remaps SessionEnd + reason=clear to sweeping state", () => {
    // `reason` is an alias for `source` per existing payload handling
    const body = buildStateBody(
      "SessionEnd",
      { session_id: "sid-1", reason: "clear" },
      mockResolve
    );
    assert.strictEqual(body.state, "sweeping");
  });

  it("keeps SessionEnd as sleeping when source is not clear", () => {
    const body = buildStateBody(
      "SessionEnd",
      { session_id: "sid-1", source: "user" },
      mockResolve
    );
    assert.strictEqual(body.state, "sleeping");
  });

  it("falls back to 'default' when session_id is missing", () => {
    const body = buildStateBody("PreToolUse", {}, mockResolve);
    assert.strictEqual(body.session_id, "default");
  });

  it("omits cwd field when payload has no cwd", () => {
    const body = buildStateBody("PreToolUse", { session_id: "s" }, mockResolve);
    assert.ok(!("cwd" in body));
  });

  it("includes source_pid from resolve() in non-remote mode", () => {
    const resolveWithPid = () => ({
      stablePid: 12345,
      agentPid: null,
      detectedEditor: null,
      pidChain: [],
    });
    const body = buildStateBody("PreToolUse", { session_id: "s" }, resolveWithPid);
    assert.strictEqual(body.source_pid, 12345);
  });

  it("includes editor when resolve() detects one", () => {
    const resolveWithEditor = () => ({
      stablePid: 1,
      agentPid: null,
      detectedEditor: "vscode",
      pidChain: [],
    });
    const body = buildStateBody("PreToolUse", { session_id: "s" }, resolveWithEditor);
    assert.strictEqual(body.editor, "vscode");
  });

  it("includes pid_chain when non-empty", () => {
    const resolveWithChain = () => ({
      stablePid: 1,
      agentPid: null,
      detectedEditor: null,
      pidChain: [100, 200, 300],
    });
    const body = buildStateBody("PreToolUse", { session_id: "s" }, resolveWithChain);
    assert.deepStrictEqual(body.pid_chain, [100, 200, 300]);
  });

  it("omits pid_chain when empty", () => {
    const body = buildStateBody("PreToolUse", { session_id: "s" }, mockResolve);
    assert.ok(!("pid_chain" in body));
  });

  describe("remote mode (CLAWD_REMOTE=1)", () => {
    before(() => { process.env.CLAWD_REMOTE = "1"; });
    after(() => { delete process.env.CLAWD_REMOTE; });

    it("includes host prefix instead of source_pid", () => {
      const body = buildStateBody("SessionStart", { session_id: "sid-1" }, mockResolve);
      assert.strictEqual(typeof body.host, "string");
      assert.ok(body.host.length > 0);
      assert.ok(!("source_pid" in body));
      assert.ok(!("pid_chain" in body));
    });

    it("does not call resolve() in remote mode", () => {
      let called = false;
      const countingResolve = () => {
        called = true;
        return mockResolve();
      };
      buildStateBody("SessionStart", { session_id: "s" }, countingResolve);
      assert.strictEqual(called, false);
    });
  });
});
