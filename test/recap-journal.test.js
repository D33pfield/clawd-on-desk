"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecapJournal } = require("../src/recap-journal");
const { createRecapStore } = require("../src/recap-store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-journal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  const warnings = [];
  const journal = createRecapJournal({
    store,
    getTimeZone: () => "Asia/Singapore",
    logWarn: (...args) => warnings.push(args),
  });
  return { journal, root, store, warnings };
}

test("journal stores only frozen allowlisted data and irreversible identity keys", (t) => {
  const { journal, store } = fixture(t);
  const occurredAt = Date.UTC(2026, 7, 29, 18, 30);
  const record = journal.buildRecord({
    occurredAt,
    agentId: "codex",
    scope: "remote",
    metrics: ["activity", "tool-call"],
  }, {
    scopeId: "private-profile",
    sessionId: "private-session",
    dedupeId: "private-tool-id",
  });
  assert.equal(journal.append(record), true);
  assert.equal(record.localDate, "2026-08-30");
  assert.equal(record.localHour, 2);
  const disk = fs.readFileSync(store.childPath("events", "2026-08-30.jsonl"), "utf8");
  for (const secret of ["private-profile", "private-session", "private-tool-id"]) {
    assert.doesNotMatch(disk, new RegExp(secret));
  }
  for (const forbidden of ["prompt", "command", "cwd", "toolName", "eventName"]) {
    assert.equal(Object.hasOwn(record, forbidden), false);
  }
});

test("journal dedupes stable upstream identities and survives a corrupt tail", (t) => {
  const { journal, store, warnings } = fixture(t);
  const event = {
    occurredAt: Date.UTC(2026, 7, 30, 1),
    agentId: "claude-code",
    scope: "local",
    metrics: ["activity", "turn-complete"],
  };
  const identity = { sessionId: "s1", dedupeId: "turn-1" };
  const first = journal.buildRecord(event, identity);
  assert.equal(journal.append(first), true);
  assert.equal(journal.append(first), false);

  const filePath = store.childPath("events", first.localDate + ".jsonl");
  fs.appendFileSync(filePath, "{broken-tail");
  const second = journal.buildRecord({ ...event, occurredAt: event.occurredAt + 60000 }, {
    sessionId: "s1",
    dedupeId: "turn-2",
  });
  assert.equal(journal.append(second), true);
  const loaded = journal.readDate(first.localDate);
  assert.equal(loaded.length, 2);
  assert.ok(warnings.length >= 1);
});

test("journal keeps current day plus the previous thirteen local dates", (t) => {
  const { journal, store } = fixture(t);
  for (const date of ["2026-08-15", "2026-08-16", "2026-08-29"]) {
    fs.writeFileSync(store.childPath("events", `${date}.jsonl`), "");
  }
  journal.prune("2026-08-29");
  assert.equal(fs.existsSync(store.childPath("events", "2026-08-15.jsonl")), false);
  assert.equal(fs.existsSync(store.childPath("events", "2026-08-16.jsonl")), true);
  assert.equal(journal.retainedDates("2026-08-29").length, 14);
  assert.equal(journal.retainedDates("2026-08-29")[0], "2026-08-16");
});
