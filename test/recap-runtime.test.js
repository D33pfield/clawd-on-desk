"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecapJournal } = require("../src/recap-journal");
const { createRecapRuntime, MAX_FUTURE_SKEW_MS, rangeForPeriod } = require("../src/recap-runtime");
const { createRecapStore } = require("../src/recap-store");

function fixture(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-runtime-"));
  if (!options.root) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = options.now || Date.UTC(2026, 7, 29, 10);
  let enabled = options.enabled !== false;
  const runtime = createRecapRuntime({
    root,
    now: () => clock,
    getEnabled: () => enabled,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  return {
    root,
    runtime,
    setClock(value) { clock = value; },
    setPreference(value) { enabled = value; },
  };
}

test("runtime writes journal before aggregate, dedupes, and exposes no HMAC identity", (t) => {
  const f = fixture(t);
  f.runtime.start();
  const event = {
    occurredAt: Date.UTC(2026, 7, 29, 10, 5),
    agentId: "codex",
    scope: "remote",
    metrics: ["activity", "tool-call"],
  };
  const identity = { scopeId: "private-server", sessionId: "private-session", dedupeId: "call-1" };
  assert.equal(f.runtime.record(event, identity), true);
  assert.equal(f.runtime.record(event, identity), false);
  const view = f.runtime.query("today");
  assert.equal(view.days[0].rows.length, 1);
  assert.deepEqual(view.days[0].rows[0].metrics, {
    sessionsStarted: null,
    turnsCompleted: 0,
    toolCalls: 1,
    activityEvents: 1,
  });
  assert.equal(view.days[0].rows[0].scopeInstance, "remote-1");
  assert.equal(JSON.stringify(view).includes("hmac:"), false);
  assert.equal(JSON.stringify(view).includes("private-server"), false);
});

test("runtime rebuilds retained aggregates from journal without double count", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = fixture(t, { root });
  first.runtime.start();
  first.runtime.record({
    occurredAt: Date.UTC(2026, 7, 29, 9),
    agentId: "claude-code",
    scope: "local",
    metrics: ["activity", "turn-complete"],
  }, { sessionId: "s", dedupeId: "turn" });
  first.runtime.dispose();

  const second = fixture(t, { root });
  second.runtime.start();
  const row = second.runtime.query("today").days[0].rows[0];
  assert.equal(row.metrics.turnsCompleted, 1);
  assert.equal(row.metrics.activityEvents, 1);
  second.runtime.dispose();
});

test("disable closes coverage and rejects events; clear rotates all local recap data", (t) => {
  const f = fixture(t);
  f.runtime.start();
  const event = {
    occurredAt: Date.UTC(2026, 7, 29, 10),
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  };
  assert.equal(f.runtime.record(event), true);
  assert.equal(f.runtime.setEnabled(false), true);
  assert.equal(f.runtime.record({ ...event, occurredAt: event.occurredAt + 1 }), false);
  assert.equal(f.runtime.query("today").recordingEnabled, false);
  f.runtime.clear();
  assert.equal(f.runtime.query("today").days[0].rows.length, 0);
  f.runtime.setEnabled(true);
  assert.equal(f.runtime.record({ ...event, occurredAt: event.occurredAt + 2 }), true);
});

test("period ranges are bounded to current civil period", () => {
  assert.deepEqual(rangeForPeriod("today", "2026-08-30"), {
    startDate: "2026-08-30", endDate: "2026-08-30",
  });
  assert.deepEqual(rangeForPeriod("week", "2026-08-30"), {
    startDate: "2026-08-24", endDate: "2026-08-30",
  });
  assert.deepEqual(rangeForPeriod("month", "2026-08-30"), {
    startDate: "2026-08-01", endDate: "2026-08-30",
  });
  assert.deepEqual(rangeForPeriod("year", "2026-08-30"), {
    startDate: "2026-01-01", endDate: "2026-08-30",
  });
});

test("runtime fails quiet when optional storage is unavailable and can recover by explicit clear", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-unavailable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "meta.json"), "{broken");
  const f = fixture(t, { root });
  assert.doesNotThrow(() => f.runtime.start());
  assert.equal(f.runtime.query("today").status, "unavailable");
  assert.equal(f.runtime.record({
    occurredAt: Date.UTC(2026, 7, 29, 10),
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  }), false);
  assert.equal(f.runtime.clear(), true);
  assert.equal(f.runtime.query("today").status, "ready");
  assert.equal(f.runtime.query("today").recordingEnabled, true);
});

test("runtime rejects same-day events beyond the bounded clock-skew allowance", (t) => {
  const f = fixture(t);
  f.runtime.start();
  const tooFar = Date.UTC(2026, 7, 29, 10) + MAX_FUTURE_SKEW_MS + 1;
  assert.equal(f.runtime.record({
    occurredAt: tooFar,
    agentId: "codex",
    scope: "local",
    metrics: ["activity"],
  }), false);
});

test("a non-directory recap root cannot interrupt the rest of application startup", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-root-file-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "recap-v1");
  fs.writeFileSync(root, "not-a-directory");
  const runtime = createRecapRuntime({
    root,
    now: () => Date.UTC(2026, 7, 29, 10),
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  assert.doesNotThrow(() => runtime.start());
  assert.equal(runtime.query("today").status, "unavailable");
});

test("journal-frozen metric support survives a real restart rebuild", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-policy-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  const journal = createRecapJournal({ store, getTimeZone: () => "UTC" });
  const historical = journal.buildRecord({
    occurredAt: Date.UTC(2026, 7, 29, 8),
    agentId: "antigravity-cli",
    scope: "local",
    metrics: ["activity", "tool-call"],
  });
  // Simulate a ticket written by an older policy that had a reliable tool
  // boundary. The current policy says unsupported, but restart must preserve
  // the historical support contract frozen on the ticket.
  historical.support.toolCalls = true;
  assert.equal(journal.append(historical), true);

  const runtime = createRecapRuntime({
    root,
    now: () => Date.UTC(2026, 7, 29, 10),
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  runtime.start();
  const row = runtime.query("today").days[0].rows[0];
  assert.equal(row.metrics.toolCalls, 1);
  assert.equal(row.metrics.activityEvents, 1);
});
