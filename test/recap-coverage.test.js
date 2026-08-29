"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRecapCoverage } = require("../src/recap-coverage");
const { createRecapStore } = require("../src/recap-store");

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-coverage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecapStore({ root });
  store.initialize();
  const coverage = createRecapCoverage({
    store,
    getTimeZone: () => options.timeZone || "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    heartbeatMs: 60000,
  });
  coverage.load();
  return { coverage, store };
}

test("coverage separates running intervals around suspend and resume", (t) => {
  const { coverage } = fixture(t);
  const base = Date.UTC(2026, 7, 29, 10);
  coverage.start(base);
  coverage.stop(base + 30 * 60000);
  coverage.start(base + 60 * 60000);
  coverage.stop(base + 90 * 60000);
  const day = coverage.query("2026-08-29", "2026-08-29", base + 90 * 60000)[0];
  assert.equal(day.coverageMinutes[10], 30);
  assert.equal(day.coverageMinutes[11], 30);
});

test("stale open coverage is sealed at its last heartbeat, never at restart", (t) => {
  const { coverage, store } = fixture(t);
  const base = Date.UTC(2026, 7, 29, 10);
  coverage.start(base);
  coverage.tick(base + 5 * 60000);
  coverage.resetMemory(); // simulate process loss: open.json remains

  const restored = createRecapCoverage({
    store,
    getTimeZone: () => "UTC",
    now: () => base + 5 * 3600000,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  restored.load();
  const day = restored.query("2026-08-29", "2026-08-29")[0];
  assert.equal(day.coverageMinutes[10], 5);
  assert.equal(day.coverageMinutes[11], 0);
});

test("coverage crossing local midnight is split and remains visible on both days", (t) => {
  const { coverage } = fixture(t, { timeZone: "America/Los_Angeles" });
  const start = Date.UTC(2026, 7, 30, 6, 50); // Aug 29 23:50 PDT
  coverage.start(start);
  coverage.stop(start + 20 * 60000);
  const days = coverage.query("2026-08-29", "2026-08-30", start + 20 * 60000);
  assert.equal(days[0].coverageMinutes[23], 10);
  assert.equal(days[1].coverageMinutes[0], 10);
});

test("stale heartbeat left after a durable clean stop is unioned, not double counted", (t) => {
  const { coverage, store } = fixture(t);
  const base = Date.UTC(2026, 7, 29, 10);
  coverage.start(base);
  coverage.tick(base + 5 * 60000);
  const staleOpen = fs.readFileSync(store.childPath("coverage-open.json"), "utf8");
  coverage.stop(base + 10 * 60000);
  // Crash window: closed S→Q reached disk, but stale S→H deletion did not.
  fs.writeFileSync(store.childPath("coverage-open.json"), staleOpen);
  coverage.resetMemory();

  const restored = createRecapCoverage({
    store,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  restored.load();
  const day = restored.query("2026-08-29", "2026-08-29", base + 10 * 60000)[0];
  assert.equal(day.coverageMinutes[10], 10);
});

test("invalid managed coverage files are recoverably quarantined", (t) => {
  const { store } = fixture(t);
  const filePath = store.childPath("coverage-2020-01.json");
  fs.writeFileSync(filePath, "{broken");
  const restored = createRecapCoverage({
    store,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  restored.load();
  assert.equal(fs.existsSync(filePath), false);
  assert.ok(fs.readdirSync(store.childPath("quarantine")).some((name) => name.startsWith("coverage-2020-01.json.")));
});

test("coverage projection handles DST gap and fold without minute-by-minute scanning", (t) => {
  const spring = fixture(t, { timeZone: "America/Los_Angeles" }).coverage;
  spring.start(Date.UTC(2026, 2, 8, 9, 30)); // 01:30 PST
  spring.stop(Date.UTC(2026, 2, 8, 10, 30)); // 03:30 PDT
  const springDay = spring.query("2026-03-08", "2026-03-08")[0];
  assert.equal(springDay.coverageMinutes[1], 30);
  assert.equal(springDay.coverageMinutes[2], 0);
  assert.equal(springDay.coverageMinutes[3], 30);

  const fall = fixture(t, { timeZone: "America/Los_Angeles" }).coverage;
  fall.start(Date.UTC(2026, 10, 1, 7, 30)); // 00:30 PDT
  fall.stop(Date.UTC(2026, 10, 1, 10, 30)); // 02:30 PST
  const fallDay = fall.query("2026-11-01", "2026-11-01")[0];
  assert.equal(fallDay.coverageMinutes[0], 30);
  assert.equal(fallDay.coverageMinutes[1], 120);
  assert.equal(fallDay.coverageMinutes[2], 30);
});

test("cold-process 400-day coverage query reuses frozen day shapes", (t) => {
  const { coverage, store } = fixture(t, { timeZone: "America/Los_Angeles" });
  const firstDate = "2025-07-28";
  const firstEpoch = Date.UTC(2025, 6, 28, 19);
  for (let index = 0; index < 400; index += 1) {
    const startedAt = firstEpoch + index * 24 * 3600000;
    coverage.start(startedAt);
    coverage.stop(startedAt + 30 * 60000);
  }
  coverage.resetMemory();

  const childSource = `
    const { createRecapCoverage } = require(${JSON.stringify(path.join(__dirname, "..", "src", "recap-coverage.js"))});
    const { createRecapStore } = require(${JSON.stringify(path.join(__dirname, "..", "src", "recap-store.js"))});
    const store = createRecapStore({ root: process.env.CLAWD_RECAP_TEST_ROOT });
    store.initialize();
    const coverage = createRecapCoverage({
      store,
      getTimeZone: () => "America/Los_Angeles",
      setTimeout: () => ({ unref() {} }),
      clearTimeout: () => {},
    });
    coverage.load();
    const started = process.hrtime.bigint();
    const days = coverage.query("2025-07-28", "2026-08-31");
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    process.stdout.write(JSON.stringify({
      elapsedMs,
      dayCount: days.length,
      gap: days.find((day) => day.localDate === "2026-03-08").hourKindsByTimeZone["America/Los_Angeles"][2],
      fold: days.find((day) => day.localDate === "2025-11-02").hourKindsByTimeZone["America/Los_Angeles"][1],
    }));
  `;
  const child = spawnSync(process.execPath, ["-e", childSource], {
    encoding: "utf8",
    env: { ...process.env, CLAWD_RECAP_TEST_ROOT: store.root },
    timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr || child.error && child.error.message);
  const result = JSON.parse(child.stdout);
  assert.equal(result.dayCount, 400);
  assert.equal(result.gap, "gap");
  assert.equal(result.fold, "fold");
  assert.ok(result.elapsedMs < 500, `cold 400-day coverage query took ${result.elapsedMs.toFixed(1)}ms`);
});
