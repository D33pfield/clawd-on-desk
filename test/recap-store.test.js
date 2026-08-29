"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecapStore } = require("../src/recap-store");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-store-"));
}

test("store creates private metadata and stable HMAC without leaking input", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root, now: () => 123, getTimeZone: () => "UTC" });
  const meta = store.initialize();
  assert.equal(meta.schemaVersion, 1);
  assert.deepEqual(meta.createdLocalTime, {
    timeZoneId: "UTC",
    localDate: "1970-01-01",
    localHour: 0,
  });
  assert.equal(meta.retention.eventDays, 14);
  assert.equal(meta.retention.dailyDays, 400);
  const first = store.hmac("session", "secret-session-name");
  assert.equal(first, store.hmac("session", "secret-session-name"));
  assert.doesNotMatch(first, /secret/);
  assert.equal(fs.statSync(path.join(root, "meta.json")).mode & 0o077, 0);
});

test("store path guard rejects escapes and clear only resets recap children", (t) => {
  const parent = tempRoot();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "recap-v1");
  const outside = path.join(parent, "keep.txt");
  fs.writeFileSync(outside, "keep");
  const store = createRecapStore({ root });
  store.initialize();
  assert.throws(() => store.childPath("..", "keep.txt"), /escaped/);
  fs.writeFileSync(store.childPath("events", "2026-01-01.jsonl"), "x");
  const before = store.hmac("x", "same");
  store.clear();
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.equal(fs.existsSync(store.childPath("events", "2026-01-01.jsonl")), false);
  assert.notEqual(store.hmac("x", "same"), before);
});

test("missing or invalid identity metadata never mixes old data with a new salt", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  const oldEvent = store.childPath("events", "2026-08-29.jsonl");
  fs.writeFileSync(oldEvent, "old-ticket\n");
  fs.unlinkSync(path.join(root, "meta.json"));

  const reopened = createRecapStore({ root });
  assert.throws(() => reopened.initialize(), /identity metadata is unavailable/);
  assert.equal(fs.readFileSync(oldEvent, "utf8"), "old-ticket\n");

  fs.writeFileSync(path.join(root, "meta.json"), "{broken");
  assert.throws(() => createRecapStore({ root }).initialize(), /identity metadata is invalid/);
});

test("explicit clear recovers exact managed directory corruption and crash temp files", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  fs.rmSync(path.join(root, "meta.json"));
  fs.mkdirSync(path.join(root, "meta.json"));
  fs.mkdirSync(path.join(root, "daily-2026-08.json"));
  fs.mkdirSync(path.join(root, "coverage-open.json"));
  const managedTemp = ".daily-2026-08.json.1234.abcdefabcdef.tmp";
  fs.writeFileSync(path.join(root, managedTemp), "partial");
  fs.writeFileSync(path.join(root, "keep-user-file.txt"), "keep");

  assert.doesNotThrow(() => store.clear());
  assert.equal(fs.statSync(path.join(root, "meta.json")).isFile(), true);
  assert.equal(fs.existsSync(path.join(root, "daily-2026-08.json")), false);
  assert.equal(fs.existsSync(path.join(root, "coverage-open.json")), false);
  assert.equal(fs.existsSync(path.join(root, managedTemp)), false);
  assert.equal(fs.readFileSync(path.join(root, "keep-user-file.txt"), "utf8"), "keep");
});
