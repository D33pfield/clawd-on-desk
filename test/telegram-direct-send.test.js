"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTelegramDirectSend,
  normalizePromptText,
} = require("../src/telegram-direct-send");

function localTerminalEntry(overrides = {}) {
  return {
    id: "sess-local-1",
    agentId: "claude-code",
    state: "idle",
    badge: "done",
    sourcePid: 1234,
    host: null,
    headless: false,
    hiddenFromHud: false,
    platform: null,
    ...overrides,
  };
}

test("direct send maps a completion notification reply to the exact local session and focuses only", async () => {
  const focused = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: (sessionId, options) => {
      focused.push({ sessionId, options });
      return true;
    },
    osPlatform: "win32",
  });

  assert.equal(direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" }), true);
  const res = await direct.handleTextMessage({
    text: "continue please",
    replyToMessageId: 42,
    messageId: 99,
    fromId: "777",
    chatId: "123",
  });

  assert.equal(res.status, "focused");
  assert.equal(res.sessionId, "sess-local-1");
  assert.match(res.text, /focus-only dogfood mode/);
  assert.doesNotMatch(res.text, /continue please/);
  assert.deepEqual(focused, [{
    sessionId: "sess-local-1",
    options: {
      requestSource: "telegram-direct-send",
      fallbackEntry: localTerminalEntry(),
    },
  }]);
});

test("direct send ignores normal text while the feature flag is disabled", async () => {
  const direct = createTelegramDirectSend({
    isEnabled: () => false,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => { throw new Error("must not focus"); },
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  assert.equal(await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 }), null);
});

test("direct send asks for a reply target when no completion mapping exists", async () => {
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => { throw new Error("must not focus"); },
  });

  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 404 });
  assert.equal(res.status, "unmapped");
  assert.match(res.text, /Reply to a Clawd completion notification/);
});

test("direct send falls back when the mapped session is no longer live", async () => {
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [] }),
    focusSession: () => { throw new Error("must not focus"); },
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });
  assert.equal(res.status, "session_not_live");
});

test("direct send never focuses remote, headless, sleeping, or permission-pending sessions", async () => {
  const blocked = [
    localTerminalEntry({ id: "remote", host: "server" }),
    localTerminalEntry({ id: "headless", headless: true }),
    localTerminalEntry({ id: "sleeping", state: "sleeping" }),
    localTerminalEntry({ id: "permission", state: "notification" }),
  ];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: blocked }),
    focusSession: () => { throw new Error("must not focus"); },
    osPlatform: "win32",
  });

  for (const entry of blocked) {
    direct.registerCompletionNotification({ messageId: entry.id.length + 100, sessionId: entry.id });
    const res = await direct.handleTextMessage({
      text: "continue",
      replyToMessageId: entry.id.length + 100,
    });
    assert.notEqual(res.status, "focused");
  }
});

test("direct send rejects sessions with an authoritative interactive pending permission", async () => {
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    getPendingPermissions: () => [{ sessionId: "sess-local-1", agentId: "claude-code" }],
    focusSession: () => { throw new Error("must not focus"); },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });

  assert.equal(res.status, "permission_pending");
});

test("direct send does not treat passive notify or hardware test entries as pending permissions", async () => {
  const focused = [];
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    getPendingPermissions: () => [
      { sessionId: "sess-local-1", isCodexNotify: true },
      { sessionId: "sess-local-1", isKimiNotify: true },
      { sessionId: "sess-local-1", isHardwareBuddyTest: true },
    ],
    focusSession: (sessionId) => {
      focused.push(sessionId);
      return true;
    },
    osPlatform: "win32",
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });

  assert.equal(res.status, "focused");
  assert.deepEqual(focused, ["sess-local-1"]);
});

test("direct send expires notification mappings", async () => {
  let ts = 1000;
  const direct = createTelegramDirectSend({
    isEnabled: () => true,
    now: () => ts,
    mappingTtlMs: 10,
    getSessionSnapshot: () => ({ sessions: [localTerminalEntry()] }),
    focusSession: () => { throw new Error("must not focus"); },
  });

  direct.registerCompletionNotification({ messageId: 42, sessionId: "sess-local-1" });
  ts += 11;
  const res = await direct.handleTextMessage({ text: "continue", replyToMessageId: 42 });
  assert.equal(res.status, "unmapped");
});

test("normalizePromptText keeps newlines but removes control characters", () => {
  assert.equal(normalizePromptText("  hi\r\nthere\u0007  "), "hi\nthere");
});
