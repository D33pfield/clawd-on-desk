"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  QUARANTINE_MAX_BYTES,
  QUARANTINE_MAX_FILES,
  MAX_MANAGED_JSON_BYTES,
  TEMP_FILE_TTL_MS,
  createRecapStore,
} = require("../src/recap-store");

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

test("managed symlinks and junctions fail closed without deleting their targets", (t) => {
  const parent = tempRoot();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const outside = path.join(parent, "outside");
  const linkedRoot = path.join(parent, "linked-root");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "keep");
  fs.symlinkSync(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => createRecapStore({ root: linkedRoot }).initialize(), /links or reparse/);
  assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "keep");

  const root = path.join(parent, "safe-root");
  const store = createRecapStore({ root });
  store.initialize();
  fs.rmSync(path.join(root, "events"), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(root, "events"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => store.clear(), /links or reparse/);
  assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "keep");
});

test("stale atomic temps and quarantine data stay bounded", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root, now: () => Date.now() });
  store.initialize();
  const staleTemp = path.join(root, ".daily-2026-08.json.1234.abcdefabcdef.tmp");
  fs.writeFileSync(staleTemp, "partial");
  const old = new Date(Date.now() - TEMP_FILE_TTL_MS - 1000);
  fs.utimesSync(staleTemp, old, old);

  for (let index = 0; index < QUARANTINE_MAX_FILES + 5; index += 1) {
    const filePath = store.childPath(`daily-2020-${String((index % 9) + 1).padStart(2, "0")}.json.${index}`);
    fs.writeFileSync(filePath, "x".repeat(80000));
    store.quarantine(filePath, "test");
  }
  createRecapStore({ root, now: () => Date.now() }).initialize();
  assert.equal(fs.existsSync(staleTemp), false);
  const quarantine = fs.readdirSync(path.join(root, "quarantine"));
  const bytes = quarantine.reduce((sum, name) => sum + fs.statSync(path.join(root, "quarantine", name)).size, 0);
  assert.ok(quarantine.length <= QUARANTINE_MAX_FILES);
  assert.ok(bytes <= QUARANTINE_MAX_BYTES);
});

test("quarantine rejects nested directories instead of letting them bypass the byte cap", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  const nested = path.join(root, "quarantine", "not-a-flat-entry");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "payload"), Buffer.alloc(QUARANTINE_MAX_BYTES + 1));

  createRecapStore({ root }).initialize();
  assert.equal(fs.existsSync(nested), false);
});

test("managed JSON reads reject oversized files without loading them", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  const filePath = store.childPath("daily-2026-08.json");
  fs.writeFileSync(filePath, "{");
  fs.truncateSync(filePath, MAX_MANAGED_JSON_BYTES + 1);
  assert.equal(store.readJson(filePath, "bounded"), "bounded");
});
