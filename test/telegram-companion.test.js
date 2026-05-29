"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTelegramCompanion,
  formatNotification,
} = require("../src/telegram-companion");

function tick() {
  // Flush the fire-and-forget microtask chain in onSnapshot.
  return new Promise((resolve) => setImmediate(resolve));
}

function doneEntry(overrides = {}) {
  return {
    id: "sess-aaaaaa1",
    agentId: "claude",
    displayTitle: "fix the bug",
    cwd: "/home/me/proj",
    host: null,
    badge: "done",
    lastEvent: { rawEvent: "Stop", at: 1000 },
    ...overrides,
  };
}

function makeClient() {
  const sent = [];
  return {
    sent,
    client: {
      sendNotification: async (text) => { sent.push(text); return { ok: true }; },
    },
  };
}

function makeCompanion({ enabled = true, client } = {}) {
  const sink = client || makeClient();
  const comp = createTelegramCompanion({
    getClient: () => sink.client,
    isEnabled: () => enabled,
  });
  return { comp, sent: sink.sent };
}

test("first snapshot primes dedupe without notifying", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sent, [], "backlog of already-finished sessions must not re-ping on start");
});

test("notifies a fresh completion after priming", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [] }); // prime empty
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /fix the bug/);
  assert.match(sent[0], /done/);
});

test("dedupes repeated broadcasts of the same completion", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  // Same id + rawEvent + at — re-broadcast from ack / stale-cleanup.
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.equal(sent.length, 1, "must not re-notify the same completion");
});

test("a later completion on the same session (new at) notifies again", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  comp.onSnapshot({ sessions: [doneEntry({ lastEvent: { rawEvent: "Stop", at: 2000 } })] });
  await tick();
  assert.equal(sent.length, 2);
});

test("disabled: advances dedupe but sends nothing, and never backfills", async () => {
  const sink = makeClient();
  let enabled = false;
  const comp = createTelegramCompanion({
    getClient: () => sink.client,
    isEnabled: () => enabled,
  });
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sink.sent, [], "no sends while disabled");
  // Flip on — the already-seen completion must not retroactively fire.
  enabled = true;
  comp.onSnapshot({ sessions: [doneEntry()] });
  await tick();
  assert.deepEqual(sink.sent, [], "flipping the toggle on must not backfill old completions");
});

test("notifies each completing session with identity fields", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [
      doneEntry({ id: "sess-aaaaaa1", displayTitle: "task A", cwd: "/a/projA" }),
      doneEntry({ id: "sess-bbbbbb2", displayTitle: "task B", cwd: "C:\\work\\projB", host: "laptop" }),
    ],
  });
  await tick();
  assert.equal(sent.length, 2);
  const joined = sent.join("\n---\n");
  assert.match(joined, /task A/);
  assert.match(joined, /projA/);
  assert.match(joined, /task B/);
  assert.match(joined, /projB/); // Windows cwd basename
  assert.match(joined, /laptop/); // host
});

test("ignores non-completion badges and events", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [
      doneEntry({ id: "r1", badge: "running", lastEvent: { rawEvent: "PreToolUse", at: 1 } }),
      doneEntry({ id: "i1", badge: "idle", lastEvent: { rawEvent: "Notification", at: 1 } }),
      // done badge but a non-completion rawEvent should not fire.
      doneEntry({ id: "d1", badge: "done", lastEvent: { rawEvent: "PostCompact", at: 1 } }),
    ],
  });
  await tick();
  assert.deepEqual(sent, []);
});

test("interrupted badge uses the warning marker", async () => {
  const { comp, sent } = makeCompanion();
  comp.onSnapshot({ sessions: [] });
  comp.onSnapshot({
    sessions: [doneEntry({ badge: "interrupted", lastEvent: { rawEvent: "ApiError", at: 5 } })],
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /interrupted/);
});

test("forgets sessions that drop out of the snapshot", async () => {
  const { comp } = makeCompanion();
  comp.onSnapshot({ sessions: [doneEntry()] }); // prime + record key
  comp.onSnapshot({ sessions: [] }); // session gone -> key dropped
  assert.equal(comp._lastNotified.size, 0);
});

test("formatNotification falls back to short id when title missing", () => {
  const text = formatNotification({
    id: "sess-zzzzzz9", badge: "done", lastEvent: { rawEvent: "Stop", at: 1 },
  });
  assert.match(text, /sess-z/);
  assert.match(text, /#sess-z/);
});
