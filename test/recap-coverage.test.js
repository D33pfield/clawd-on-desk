"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  MAX_LEGACY_INTERVALS_PER_DAY,
  MAX_LEGACY_TIME_ZONES_PER_DAY,
  createRecapCoverage,
} = require("../src/recap-coverage");
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
  const staleOpen = {
    schemaVersion: 1, // legacy close order could leave this behind
    startedAt: base,
    lastHeartbeatAt: base + 5 * 60000,
    timeZoneId: "UTC",
  };
  coverage.stop(base + 10 * 60000);
  // Crash window: closed S→Q reached disk, but stale S→H deletion did not.
  fs.writeFileSync(store.childPath("coverage-open.json"), JSON.stringify(staleOpen));
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

test("legacy open heartbeat is exactly unioned with disjoint same-hour intervals", (t) => {
  const { store } = fixture(t);
  const base = Date.UTC(2026, 7, 29, 10);
  fs.writeFileSync(store.childPath("coverage-2026-08.json"), JSON.stringify({
    schemaVersion: 1,
    month: "2026-08",
    days: {
      "2026-08-29": {
        intervals: [{
          startedAt: base + 20 * 60000,
          endedAt: base + 30 * 60000,
          timeZoneId: "UTC",
          startedOffsetMinutes: 0,
          endedOffsetMinutes: 0,
        }],
        hourKindsByTimeZone: { UTC: Array(24).fill("normal") },
      },
    },
  }));
  fs.writeFileSync(store.childPath("coverage-open.json"), JSON.stringify({
    schemaVersion: 1,
    startedAt: base,
    lastHeartbeatAt: base + 10 * 60000,
    timeZoneId: "UTC",
  }));

  const restored = createRecapCoverage({
    store,
    now: () => base + 60 * 60000,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  restored.load();
  assert.equal(restored.query("2026-08-29", "2026-08-29")[0].coverageMinutes[10], 20);
  assert.equal(fs.existsSync(store.childPath("coverage-open.json")), false);
});

test("a current heartbeat after earlier same-hour coverage is never mistaken for a duplicate", (t) => {
  const { coverage, store } = fixture(t);
  const base = Date.UTC(2026, 7, 29, 10);
  coverage.start(base);
  coverage.stop(base + 5 * 60000);
  coverage.start(base + 10 * 60000);
  coverage.tick(base + 15 * 60000);
  coverage.resetMemory(); // current v2 heartbeat remains after process loss

  const restored = createRecapCoverage({
    store,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  restored.load();
  const day = restored.query("2026-08-29", "2026-08-29", base + 15 * 60000)[0];
  assert.equal(day.coverageMinutes[10], 10);
});

test("heartbeats checkpoint coarse minutes and retain only the sub-minute crash tail", (t) => {
  const { coverage, store } = fixture(t);
  const base = Date.UTC(2026, 7, 29, 10);
  coverage.start(base);
  coverage.tick(base + 5 * 60000 + 30 * 1000);
  const open = JSON.parse(fs.readFileSync(store.childPath("coverage-open.json"), "utf8"));
  assert.equal(open.schemaVersion, 2);
  assert.equal(open.startedAt, base + 5 * 60000);
  assert.equal(open.lastHeartbeatAt, base + 5 * 60000 + 30 * 1000);
  assert.equal(coverage.query(
    "2026-08-29",
    "2026-08-29",
    base + 5 * 60000 + 30 * 1000
  )[0].coverageMinutes[10], 6);
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

test("coverage rejects bounded-size legacy interval fan-out before projection", (t) => {
  const { store } = fixture(t);
  const filePath = store.childPath("coverage-2026-08.json");
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    month: "2026-08",
    days: {
      "2026-08-29": {
        intervals: Array(MAX_LEGACY_INTERVALS_PER_DAY + 1).fill(null),
        hourKindsByTimeZone: {},
      },
    },
  }));
  const coverage = createRecapCoverage({
    store,
    now: () => Date.UTC(2026, 7, 29, 10),
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    logWarn: () => {},
  });
  const started = performance.now();
  coverage.load();
  assert.ok(performance.now() - started < 500);
  assert.equal(fs.existsSync(filePath), false);
  assert.ok(fs.readdirSync(store.childPath("quarantine")).some((name) => name.startsWith("coverage-2026-08.json.")));

  const zoneFilePath = store.childPath("coverage-2026-09.json");
  fs.writeFileSync(zoneFilePath, JSON.stringify({
    schemaVersion: 1,
    month: "2026-09",
    days: {
      "2026-09-01": {
        intervals: Array.from({ length: MAX_LEGACY_TIME_ZONES_PER_DAY + 1 }, (_, index) => ({
          timeZoneId: `hostile-zone-${index}`,
        })),
        hourKindsByTimeZone: {},
      },
    },
  }));
  coverage.load();
  assert.equal(fs.existsSync(zoneFilePath), false);
});

test("invalid open-heartbeat files self-heal before recording restarts", (t) => {
  for (const variant of ["corrupt", "oversized", "directory"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `clawd-recap-open-${variant}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createRecapStore({ root });
    store.initialize();
    const filePath = store.childPath("coverage-open.json");
    if (variant === "directory") fs.mkdirSync(filePath);
    else if (variant === "oversized") fs.writeFileSync(filePath, "x".repeat(8 * 1024 * 1024 + 1));
    else fs.writeFileSync(filePath, "{broken");
    const coverage = createRecapCoverage({
      store,
      getTimeZone: () => "UTC",
      setTimeout: () => ({ unref() {} }),
      clearTimeout: () => {},
      logWarn: () => {},
    });
    assert.doesNotThrow(() => coverage.load(), variant);
    assert.doesNotThrow(() => coverage.start(Date.UTC(2026, 7, 29, 10)), variant);
    assert.equal(fs.lstatSync(filePath).isFile(), true, variant);
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, 2, variant);
    coverage.resetMemory();
  }
});

test("tiny hostile open heartbeats are rejected before any historical projection", (t) => {
  const current = Date.UTC(2026, 7, 29, 10);
  const variants = {
    "v2-long": { schemaVersion: 2, startedAt: 0, lastHeartbeatAt: current, timeZoneId: "UTC" },
    "v2-future": {
      schemaVersion: 2,
      startedAt: current + 10 * 60000,
      lastHeartbeatAt: current + 10 * 60000,
      timeZoneId: "UTC",
    },
    "v1-long": {
      schemaVersion: 1,
      startedAt: current - 40 * 3600000,
      lastHeartbeatAt: current,
      timeZoneId: "UTC",
    },
  };
  for (const [name, saved] of Object.entries(variants)) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `clawd-recap-open-bound-${name}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createRecapStore({ root });
    store.initialize();
    fs.writeFileSync(store.childPath("coverage-open.json"), JSON.stringify(saved));
    const coverage = createRecapCoverage({
      store,
      now: () => current,
      getTimeZone: () => "UTC",
      setTimeout: () => ({ unref() {} }),
      clearTimeout: () => {},
      logWarn: () => {},
    });
    const started = performance.now();
    coverage.load();
    assert.ok(performance.now() - started < 500, name);
    assert.equal(fs.existsSync(store.childPath("coverage-open.json")), false, name);
    assert.deepEqual(fs.readdirSync(root).filter((entry) => /^coverage-\d{4}-\d{2}\.json$/.test(entry)), [], name);
    assert.equal(coverage.start(current), true, name);
  }
});

test("legacy exact intervals migrate once to coarse daily minute buckets", (t) => {
  const { store } = fixture(t);
  const filePath = store.childPath("coverage-2026-08.json");
  const startedAt = Date.UTC(2026, 7, 29, 10);
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    month: "2026-08",
    days: {
      "2026-08-29": {
        intervals: [{
          startedAt,
          endedAt: startedAt + 30 * 60000,
          timeZoneId: "UTC",
          startedOffsetMinutes: 0,
          endedOffsetMinutes: 0,
        }],
        hourKindsByTimeZone: { UTC: Array(24).fill("normal") },
      },
    },
  }));
  const restored = createRecapCoverage({
    store,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  restored.load();
  assert.equal(restored.query("2026-08-29", "2026-08-29")[0].coverageMinutes[10], 30);
  const migrated = fs.readFileSync(filePath, "utf8");
  assert.match(migrated, /"schemaVersion":2/);
  for (const forbidden of ["startedAt", "endedAt", "timeZoneId", "intervals"]) {
    assert.equal(migrated.includes(forbidden), false);
  }
});

test("legacy migration rejects impossible multi-year intervals before projection", (t) => {
  const { store } = fixture(t);
  const filePath = store.childPath("coverage-2026-08.json");
  const startedAt = Date.UTC(2026, 7, 29, 10);
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    month: "2026-08",
    days: {
      "2026-08-29": {
        intervals: [{
          startedAt,
          endedAt: Date.UTC(2426, 7, 29, 10),
          timeZoneId: "UTC",
          startedOffsetMinutes: 0,
          endedOffsetMinutes: 0,
        }],
        hourKindsByTimeZone: { UTC: Array(24).fill("normal") },
      },
    },
  }));
  const restored = createRecapCoverage({
    store,
    getTimeZone: () => "UTC",
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  const started = performance.now();
  restored.load();
  assert.ok(performance.now() - started < 500);
  assert.equal(restored.query("2026-08-29", "2026-08-29")[0].coverageMinutes[10], 0);
  assert.equal(fs.existsSync(filePath), false, "invalid-only legacy history is removed after migration");
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
      gap: days.find((day) => day.localDate === "2026-03-08").hourCapacities[2],
      fold: days.find((day) => day.localDate === "2025-11-02").hourCapacities[1],
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
  assert.equal(result.gap, 0);
  assert.equal(result.fold, 120);
  assert.ok(result.elapsedMs < 500, `cold 400-day coverage query took ${result.elapsedMs.toFixed(1)}ms`);
});
