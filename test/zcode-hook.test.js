"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildStateBody,
  run,
  stdinParseErrorCategory,
} = require("../hooks/zcode-hook");

describe("ZCode hook PID lifecycle", () => {
  it("passes the raw session context to the resolver and reports cached fields", () => {
    let context = null;
    const body = buildStateBody("PreToolUse", {
      session_id: "sid-1",
      cwd: "D:/repo",
    }, (received) => {
      context = received;
      return {
        stablePid: 101,
        agentPid: 202,
        cacheSource: "v2",
      };
    });

    assert.deepStrictEqual(context, {
      namespace: "zcode",
      sessionId: "sid-1",
      cacheCwd: "D:/repo",
      lifecycle: "event",
      cacheable: true,
    });
    assert.strictEqual(body.session_id, "zcode:sid-1");
    assert.strictEqual(body.source_pid, 101);
    assert.strictEqual(body.agent_pid, 202);
  });

  it("keeps Stop on the event lifecycle so its cache is not dropped", async () => {
    let context = null;
    const result = await run({
      hook_event_name: "Stop",
      session_id: "sid-2",
      cwd: "D:/repo",
    }, null, {
      resolvePid(received) {
        context = received;
        return { stablePid: 101, agentPid: 202, cacheSource: "v2" };
      },
      postState(_body, _options, callback) {
        callback(true, 23333);
      },
    });

    assert.strictEqual(context.lifecycle, "event");
    assert.strictEqual(result.body.state, "attention");
    assert.strictEqual(result.processMeta.cacheSource, "v2");
  });

  it("does not resolve local process metadata for a remote event", () => {
    let calls = 0;
    const body = buildStateBody("SessionStart", {
      session_id: "sid-3",
      cwd: "/repo",
    }, () => {
      calls++;
      return {};
    }, {
      remote: true,
      host: "remote-box",
    });

    assert.strictEqual(calls, 0);
    assert.strictEqual(body.host, "remote-box");
  });

  it("reduces stdin parse failures to a fixed debug category", () => {
    const rawError = "SECRET_TOKEN is not valid JSON";
    assert.strictEqual(stdinParseErrorCategory(rawError), "invalid-json");
    assert.ok(!stdinParseErrorCategory(rawError).includes("SECRET_TOKEN"));
    assert.strictEqual(stdinParseErrorCategory(null), null);
  });
});
