"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  WORKING_STALENESS_MS,
  createEmptyMonitorState,
  deriveTransitions,
  parseProjcacheFile,
  parseWorkspaceFile,
  resolveDshHome,
} = require("../agents/deepseek-harness-monitor");

const SESSION_A = "session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SESSION_B = "session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const WORKSPACE_ID = "workspace-1";

function workspaceText(sessionIds, archived = []) {
  return JSON.stringify({
    global: { workspaceIds: [WORKSPACE_ID], archivedSessionIds: archived },
    tables: {
      workspaces: {
        [WORKSPACE_ID]: {
          path: "D:\\Desktop",
          title: "Desktop",
          sessionIds,
        },
      },
    },
  });
}

function projcacheText(sessions) {
  const table = {};
  for (const [id, entry] of Object.entries(sessions)) {
    const val = {};
    if (entry.openStep !== undefined) {
      val.openStep = entry.openStep ? { turn: 1, step: 1 } : null;
    }
    val.pendingCalls = {};
    for (let i = 0; i < (entry.pendingCallCount || 0); i += 1) {
      val.pendingCalls[`call_${i}`] = 1;
    }
    const record = {
      identity: { createdAt: 1, cwd: entry.cwd || "D:\\Desktop" },
      rows: {
        sessionStats: { ver: 1, val },
        sessionListMetadata: {
          ver: 1,
          val: { blank: false, lastPromptAt: entry.lastPromptAt || 0 },
        },
        title: { ver: 1, val: entry.title || null },
      },
    };
    table[id] = record;
  }
  return JSON.stringify({ unit: { name: "session_projcache", version: 3 }, tables: { sessions: table } });
}

describe("deepseek-harness-monitor parsing", () => {
  it("resolves DSH_HOME from env, else ~/.dsh", () => {
    assert.strictEqual(resolveDshHome({ DSH_HOME: "C:\\custom" }), "C:\\custom");
    assert.strictEqual(resolveDshHome({ DSH_HOME: "  " }), resolveDshHome({}));
    assert.ok(resolveDshHome({}).endsWith(".dsh"));
  });

  it("parses workspace membership and archived ids", () => {
    const parsed = parseWorkspaceFile(workspaceText([SESSION_A, SESSION_B], [SESSION_B]));
    assert.deepStrictEqual([...parsed.active].sort(), [SESSION_A]);
    assert.deepStrictEqual([...parsed.archived], [SESSION_B]);
    assert.strictEqual(parsed.sessionPaths.get(SESSION_A), "D:\\Desktop");
  });

  it("is tolerant of malformed files", () => {
    assert.strictEqual(parseWorkspaceFile("not json").active.size, 0);
    assert.strictEqual(parseWorkspaceFile("").active.size, 0);
    assert.strictEqual(parseWorkspaceFile("{}").active.size, 0);
    assert.strictEqual(parseProjcacheFile("not json").size, 0);
    assert.strictEqual(parseProjcacheFile("").size, 0);
  });

  it("parses projcache work, title, cwd, and prompt watermark", () => {
    const parsed = parseProjcacheFile(projcacheText({
      [SESSION_A]: {
        openStep: true,
        pendingCallCount: 2,
        title: "Fix the build",
        cwd: "C:\\repo",
        lastPromptAt: 42,
      },
    }));
    const entry = parsed.get(SESSION_A);
    assert.strictEqual(entry.openStep, true);
    assert.strictEqual(entry.pendingCallCount, 2);
    assert.strictEqual(entry.title, "Fix the build");
    assert.strictEqual(entry.cwd, "C:\\repo");
    assert.strictEqual(entry.lastPromptAt, 42);
  });
});

describe("deepseek-harness-monitor state machine", () => {
  const now = () => 1_000_000;
  const fresh = { projcacheMtimeMs: now(), now };
  const stale = { projcacheMtimeMs: now() - WORKING_STALENESS_MS - 1000, now };

  it("announces existing sessions without replaying their historical prompt", () => {
    const pc = projcacheText({ [SESSION_A]: { openStep: false, lastPromptAt: 42 } });
    const { transitions } = deriveTransitions(workspaceText([SESSION_A]), pc, null, fresh);
    assert.deepStrictEqual(transitions.map((t) => [t.kind, t.state, t.event]), [
      ["start", "idle", "SessionStart"],
    ]);
  });

  it("detects a fresh prompt as UserPromptSubmit", () => {
    const pc1 = projcacheText({ [SESSION_A]: { lastPromptAt: 100 } });
    const first = deriveTransitions(workspaceText([SESSION_A]), pc1, null, fresh);
    const pc2 = projcacheText({ [SESSION_A]: { lastPromptAt: 200 } });
    const { transitions } = deriveTransitions(workspaceText([SESSION_A]), pc2, first.next, fresh);
    assert.deepStrictEqual(transitions.map((t) => [t.state, t.event]), [
      ["thinking", "UserPromptSubmit"],
    ]);
  });

  it("detects work and then completion", () => {
    const pcIdle = projcacheText({ [SESSION_A]: { openStep: false, lastPromptAt: 100 } });
    const first = deriveTransitions(workspaceText([SESSION_A]), pcIdle, null, fresh);

    const pcWorking = projcacheText({ [SESSION_A]: { openStep: true, lastPromptAt: 100 } });
    const working = deriveTransitions(workspaceText([SESSION_A]), pcWorking, first.next, fresh);
    assert.deepStrictEqual(working.transitions.map((t) => [t.state, t.event]), [
      ["working", "PreToolUse"],
    ]);

    const done = deriveTransitions(workspaceText([SESSION_A]), pcIdle, working.next, fresh);
    assert.deepStrictEqual(done.transitions.map((t) => [t.state, t.event]), [
      ["attention", "Stop"],
    ]);
  });

  it("treats pending tool calls as work", () => {
    const pcIdle = projcacheText({ [SESSION_A]: { pendingCallCount: 0, lastPromptAt: 100 } });
    const first = deriveTransitions(workspaceText([SESSION_A]), pcIdle, null, fresh);
    const pcWorking = projcacheText({ [SESSION_A]: { pendingCallCount: 1, lastPromptAt: 100 } });
    const { transitions } = deriveTransitions(workspaceText([SESSION_A]), pcWorking, first.next, fresh);
    assert.deepStrictEqual(transitions.map((t) => [t.state, t.event]), [
      ["working", "PreToolUse"],
    ]);
  });

  it("ignores a stale cached working signal", () => {
    const pcIdle = projcacheText({ [SESSION_A]: { openStep: false, lastPromptAt: 100 } });
    const first = deriveTransitions(workspaceText([SESSION_A]), pcIdle, null, fresh);
    // openStep present, but the cache mtime is old → not treated as work.
    const pcWorking = projcacheText({ [SESSION_A]: { openStep: true, lastPromptAt: 100 } });
    const { transitions } = deriveTransitions(workspaceText([SESSION_A]), pcWorking, first.next, stale);
    assert.strictEqual(transitions.length, 0);
  });

  it("ends a session that disappears from the workspace listing", () => {
    const pc = projcacheText({ [SESSION_A]: { lastPromptAt: 100 }, [SESSION_B]: { lastPromptAt: 200 } });
    const first = deriveTransitions(workspaceText([SESSION_A, SESSION_B]), pc, null, fresh);
    const { transitions } = deriveTransitions(workspaceText([SESSION_A]), pc, first.next, fresh);
    assert.deepStrictEqual(transitions.map((t) => [t.kind, t.state, t.event]), [
      ["end", "idle", "SessionEnd"],
    ]);
  });

  it("caps tracked sessions", () => {
    const many = Array.from({ length: 5 }, (_, i) => `session-${String(i).padStart(8, "0")}`);
    const first = deriveTransitions(workspaceText(many), projcacheText({}), null, { ...fresh, maxSessions: 3 });
    assert.strictEqual(first.next.known.size, 3);
    assert.strictEqual(first.transitions.filter((t) => t.kind === "start").length, 3);
  });

  it("keeps prior state when a projection is missing", () => {
    const pc = projcacheText({ [SESSION_A]: { openStep: true, lastPromptAt: 100 } });
    const first = deriveTransitions(workspaceText([SESSION_A]), pc, null, fresh);
    const { transitions } = deriveTransitions(workspaceText([SESSION_A]), projcacheText({}), first.next, fresh);
    assert.strictEqual(transitions.length, 0);
  });

  it("round-trips an empty monitor state", () => {
    const state = createEmptyMonitorState();
    assert.strictEqual(state.known.size, 0);
  });
});
