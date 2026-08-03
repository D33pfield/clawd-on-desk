"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");
const { pathToFileURL } = require("node:url");

// core.mjs resolves ~/.clawd at module evaluation and every plugin init resets
// its debug log. Keep the production-shaped fixture entirely inside a temp HOME.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-family-session-cwd-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const OPENCODE_CONFIG = Object.freeze({
  agentId: "opencode",
  hookSource: "opencode-plugin",
  logFileName: "opencode-plugin.log",
  sessionIdPrefix: "opencode:",
});

const fetchCalls = [];
let createOpencodeFamilyPlugin;
let bridgePort = 41000;

function createContext(directory) {
  return {
    serverUrl: "http://127.0.0.1:1/",
    directory,
    client: {
      _client: {
        post: async () => ({ data: {} }),
      },
    },
  };
}

async function settlePosts() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

before(async () => {
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({
      url: String(url),
      body: opts && opts.body ? JSON.parse(opts.body) : null,
    });
    return {
      status: 200,
      headers: { get: (name) => name === "x-clawd-server" ? "clawd-on-desk" : null },
      text: async () => "ok",
    };
  };
  globalThis.Bun = {
    serve() {
      bridgePort += 1;
      return { port: bridgePort };
    },
  };

  const modulePath = path.join(__dirname, "..", "hooks", "opencode-family-plugin", "core.mjs");
  ({ createOpencodeFamilyPlugin } = await import(pathToFileURL(modulePath).href));
});

after(() => {
  delete globalThis.fetch;
  delete globalThis.Bun;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("opencode-family session directory ownership (#796)", () => {
  it("uses the owning session directory after a later directory initializes the same factory", async () => {
    // Production shape: one entry-module factory product, invoked once per
    // directory Instance. v1.18.11 routes the session event only to hooksA.
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooksA = await plugin(createContext("C:\\active-project"));
    await plugin(createContext("C:\\history-b"));

    fetchCalls.length = 0;
    await hooksA.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_live",
          info: {
            id: "ses_live",
            directory: "C:\\active-project",
          },
        },
      },
    });

    await settlePosts();
    const statePost = fetchCalls.find((call) => call.url.endsWith("/state"));
    assert.ok(statePost, "owning handler did not POST /state");

    // This is the single red→green assertion. Before the fix it is
    // C:\history-b (the latest init); after the fix it is session info truth.
    assert.strictEqual(statePost.body.cwd, "C:\\active-project");
  });

  it("keeps legacy fallback before the info latch and omits unknown cwd after it", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\legacy-single-project"));
    assert.deepStrictEqual(plugin.__test.resolveSessionDirectory("opencode:default"), {
      directory: "C:\\legacy-single-project",
      source: "legacy-init-fallback",
    });

    fetchCalls.length = 0;
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_legacy", status: { type: "busy" } },
      },
    });
    await settlePosts();
    const legacyPost = fetchCalls.find((call) => call.url.endsWith("/state"));
    assert.ok(legacyPost);
    assert.strictEqual(legacyPost.body.cwd, "C:\\legacy-single-project");

    await hooks.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_known",
          info: { id: "ses_known", directory: "C:\\known" },
        },
      },
    });
    assert.strictEqual(plugin.__test._hostEmitsSessionInfo, true);
    assert.deepStrictEqual(plugin.__test.resolveSessionDirectory("opencode:default"), {
      directory: null,
      source: "none",
    });

    fetchCalls.length = 0;
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_unknown", status: { type: "busy" } },
      },
    });
    await settlePosts();
    const unknownPost = fetchCalls.find((call) => call.url.endsWith("/state"));
    assert.ok(unknownPost);
    assert.strictEqual(Object.hasOwn(unknownPost.body, "cwd"), false);
  });

  it("captures session.updated even though it does not map to a Clawd state", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\active-project"));

    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_move",
          info: { id: "ses_move", directory: "C:\\before" },
        },
      },
    });
    await settlePosts();
    fetchCalls.length = 0;

    await hooks.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_move",
          info: { id: "ses_move", directory: "C:\\after" },
        },
      },
    });
    await settlePosts();
    assert.strictEqual(fetchCalls.some((call) => call.url.endsWith("/state")), false);

    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_move", status: { type: "busy" } },
      },
    });
    await settlePosts();
    const statePost = fetchCalls.find((call) => call.url.endsWith("/state"));
    assert.ok(statePost);
    assert.strictEqual(statePost.body.cwd, "C:\\after");
  });

  it("keeps two owning handlers bound to their own directories across interleaved state and tool events", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooksA = await plugin(createContext("C:\\project-a"));
    const hooksB = await plugin(createContext("C:\\project-b"));

    await hooksA.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_a",
          info: { id: "ses_a", directory: "C:\\project-a" },
        },
      },
    });
    await hooksB.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_b",
          info: { id: "ses_b", directory: "C:\\project-b" },
        },
      },
    });
    await settlePosts();
    fetchCalls.length = 0;

    await hooksA.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "busy" } },
      },
    });
    await hooksB.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_b", status: { type: "busy" } },
      },
    });
    await hooksA.event({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_a",
          part: { type: "tool", state: { status: "running" } },
        },
      },
    });
    await hooksB.event({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_b",
          part: { type: "tool", state: { status: "running" } },
        },
      },
    });
    await settlePosts();

    const statePosts = fetchCalls.filter((call) => call.url.endsWith("/state"));
    assert.deepStrictEqual(
      statePosts.map((call) => [call.body.session_id, call.body.state, call.body.cwd]),
      [
        ["opencode:ses_a", "thinking", "C:\\project-a"],
        ["opencode:ses_b", "thinking", "C:\\project-b"],
        ["opencode:ses_a", "working", "C:\\project-a"],
        ["opencode:ses_b", "working", "C:\\project-b"],
      ]
    );
  });

  it("serializes a deleted session with its authoritative cwd before cleanup", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\active-project"));

    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_delete",
          info: { id: "ses_delete", directory: "C:\\active-project" },
        },
      },
    });
    await settlePosts();
    fetchCalls.length = 0;

    await hooks.event({
      event: {
        type: "session.deleted",
        properties: {
          sessionID: "ses_delete",
          info: { id: "ses_delete", directory: "C:\\active-project" },
        },
      },
    });
    await settlePosts();
    const endPost = fetchCalls.find((call) => (
      call.url.endsWith("/state") && call.body.event === "SessionEnd"
    ));
    assert.ok(endPost);
    assert.strictEqual(endPost.body.cwd, "C:\\active-project");
    assert.strictEqual(plugin.__test._sessionDirectoryById.has("opencode:ses_delete"), false);
  });

  it("uses info-only session ids for root, lastSeen, and SessionStart", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\info-project"));

    fetchCalls.length = 0;
    await hooks.event({
      event: {
        type: "session.created",
        properties: {
          info: { id: "ses_info_only", directory: "C:\\info-project" },
        },
      },
    });
    await settlePosts();

    assert.strictEqual(plugin.__test._rootSessionId, "ses_info_only");
    assert.strictEqual(plugin.__test._lastSeenSessionId, "ses_info_only");
    const startPost = fetchCalls.find((call) => call.url.endsWith("/state"));
    assert.ok(startPost);
    assert.strictEqual(startPost.body.session_id, "opencode:ses_info_only");
    assert.strictEqual(startPost.body.cwd, "C:\\info-project");
  });

  it("binds an explicit permission session before the legacy lastSeen fallback", async () => {
    const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG);
    const hooks = await plugin(createContext("C:\\project-a"));

    for (const [sessionID, directory] of [
      ["ses_a", "C:\\project-a"],
      ["ses_b", "C:\\project-b"],
    ]) {
      await hooks.event({
        event: {
          type: "session.created",
          properties: { sessionID, info: { id: sessionID, directory } },
        },
      });
    }
    await settlePosts();
    assert.strictEqual(plugin.__test._lastSeenSessionId, "ses_b");
    fetchCalls.length = 0;

    // Contract guard: current dispatch updates lastSeen from this permission
    // event before forwarding it, so this documents explicit-id precedence
    // rather than mutation-killing the direct getEventSessionId() call.
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "per_a",
          sessionID: "ses_a",
          permission: "bash",
          metadata: { command: "echo a" },
          patterns: [],
          always: [],
        },
      },
    });
    await settlePosts();
    const permissionPost = fetchCalls.find((call) => call.url.endsWith("/permission"));
    assert.ok(permissionPost);
    assert.strictEqual(permissionPost.body.session_id, "opencode:ses_a");
    assert.strictEqual(permissionPost.body.cwd, "C:\\project-a");

    // A later legacy payload still follows the existing lastSeen contract.
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_b", status: { type: "busy" } },
      },
    });
    await settlePosts();
    fetchCalls.length = 0;
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "per_legacy",
          permission: "bash",
          metadata: { command: "echo legacy" },
          patterns: [],
          always: [],
        },
      },
    });
    await settlePosts();
    const legacyPost = fetchCalls.find((call) => call.url.endsWith("/permission"));
    assert.ok(legacyPost);
    assert.strictEqual(legacyPost.body.session_id, "opencode:ses_b");
    assert.strictEqual(legacyPost.body.cwd, "C:\\project-b");
  });
});
