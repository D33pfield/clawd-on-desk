"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecapAggregate, normalizeDay } = require("../src/recap-aggregate");
const { createRecapJournal } = require("../src/recap-journal");
const { createRecapStore } = require("../src/recap-store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-aggregate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  const journal = createRecapJournal({ store, getTimeZone: () => "UTC" });
  const aggregate = createRecapAggregate({ store, flushDelayMs: 100000 });
  aggregate.load();
  return { aggregate, journal, store };
}

function record(journal, agentId, metrics, hour, identity = {}) {
  return journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 29, hour),
    agentId,
    scope: identity.scope || "local",
    metrics,
  }, identity);
}

test("aggregate preserves unsupported null separately from supported zero", (t) => {
  const { aggregate, journal } = fixture(t);
  aggregate.apply(record(journal, "codex", ["activity", "tool-call"], 4));
  aggregate.apply(record(journal, "antigravity-cli", ["activity", "turn-complete"], 4));
  const day = aggregate.query("2026-08-29", "2026-08-29")[0];
  const rows = day.rows;
  assert.deepEqual(day.timeZones, [{ id: "UTC", utcOffsetMinutes: 0 }]);
  const codex = rows.find((row) => row.agentId === "codex");
  const agy = rows.find((row) => row.agentId === "antigravity-cli");
  assert.equal(codex.metrics.toolCalls, 1);
  assert.equal(codex.metrics.turnsCompleted, 0);
  assert.equal(codex.metrics.sessionsStarted, null);
  assert.equal(agy.metrics.toolCalls, null);
  assert.equal(agy.metrics.turnsCompleted, 1);
  assert.equal(agy.hours[4], 1);
});

test("aggregate keeps same agent scopes separate and marks reusable session starts partial", (t) => {
  const { aggregate, journal } = fixture(t);
  aggregate.apply(record(journal, "claude-code", ["activity"], 1, {
    sessionId: "default",
    sessionStartPartial: true,
  }));
  aggregate.apply(record(journal, "claude-code", ["activity", "session-start"], 2, {
    scope: "remote",
    scopeId: "server-one",
    sessionId: "fresh",
  }));
  const rows = aggregate.query("2026-08-29", "2026-08-29")[0].rows;
  assert.equal(rows.length, 2);
  const local = rows.find((row) => row.scope === "local");
  const remote = rows.find((row) => row.scope === "remote");
  assert.equal(local.sessionsStartedPartial, true);
  assert.equal(local.metrics.sessionsStarted, 0);
  assert.equal(remote.sessionsStartedPartial, false);
  assert.equal(remote.metrics.sessionsStarted, 1);
});

test("retained journal dates rebuild monthly cache after an interrupted flush", (t) => {
  const { aggregate, journal, store } = fixture(t);
  const item = record(journal, "codex", ["activity", "tool-call"], 8, {
    sessionId: "s",
    dedupeId: "tool",
  });
  journal.append(item);
  aggregate.replaceDates(journal.retainedDates("2026-08-29"), journal.loadRetained("2026-08-29"));
  aggregate.flush();

  const restored = createRecapAggregate({ store, flushDelayMs: 100000 });
  restored.load();
  const row = restored.query("2026-08-29", "2026-08-29")[0].rows[0];
  assert.equal(row.metrics.toolCalls, 1);
  assert.equal(row.hours[8], 1);
});

test("daily rows freeze their historical metric support instead of following current policy", () => {
  const hash = `hmac:${"a".repeat(43)}`;
  const day = normalizeDay("2026-08-29", {
    rows: {
      old: {
        agentId: "antigravity-cli",
        scope: "local",
        scopeKeyHash: hash,
        support: { sessionsStarted: false, turnsCompleted: true, toolCalls: true },
        metrics: { sessionsStarted: null, turnsCompleted: 2, toolCalls: 7, activityEvents: 9 },
        sessionsStartedPartial: true,
        hours: Array(24).fill(0),
      },
    },
  });
  assert.ok(day);
  const row = Object.values(day.rows)[0];
  assert.equal(row.metrics.activityEvents, 9);
  assert.equal(row.metrics.toolCalls, 7);
  assert.equal(row.support.toolCalls, true);
});

test("a day with mixed supported and unsupported policy segments stays honestly null", (t) => {
  const { aggregate, journal } = fixture(t);
  const historical = record(journal, "antigravity-cli", ["activity", "tool-call"], 8);
  historical.support.toolCalls = true;
  aggregate.apply(historical);
  aggregate.apply(record(journal, "antigravity-cli", ["activity"], 9));
  const row = aggregate.query("2026-08-29", "2026-08-29")[0].rows[0];
  assert.equal(row.metrics.toolCalls, null);
  assert.equal(row.metrics.activityEvents, 2);
  assert.equal(row.hours[8], 1);
  assert.equal(row.hours[9], 1);
});

test("invalid managed monthly files are recoverably quarantined", (t) => {
  const { store } = fixture(t);
  const filePath = store.childPath("daily-2020-01.json");
  fs.writeFileSync(filePath, "{broken");
  const aggregate = createRecapAggregate({ store, flushDelayMs: 100000 });
  aggregate.load();
  assert.equal(fs.existsSync(filePath), false);
  assert.ok(fs.readdirSync(store.childPath("quarantine")).some((name) => name.startsWith("daily-2020-01.json.")));
});
