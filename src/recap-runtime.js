"use strict";

const { createRecapAggregate } = require("./recap-aggregate");
const { createRecapCoverage } = require("./recap-coverage");
const { createCanonicalRecapEvent } = require("./recap-event");
const { createRecapJournal } = require("./recap-journal");
const { createRecapStore, DEFAULT_ROOT } = require("./recap-store");
const {
  addLocalDays,
  compareLocalDates,
  freezeLocalTime,
  getSystemTimeZone,
  parseLocalDate,
} = require("./recap-time");

const PERIODS = new Set(["today", "week", "month", "year"]);
const MAX_FUTURE_SKEW_MS = 5 * 60000;

function rangeForPeriod(period, anchorDate) {
  if (!PERIODS.has(period)) throw new TypeError("unsupported recap period");
  const parts = parseLocalDate(anchorDate);
  if (period === "today") return { startDate: anchorDate, endDate: anchorDate };
  if (period === "week") {
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    const daysSinceMonday = (weekday + 6) % 7;
    return { startDate: addLocalDays(anchorDate, -daysSinceMonday), endDate: anchorDate };
  }
  if (period === "month") {
    return {
      startDate: `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-01`,
      endDate: anchorDate,
    };
  }
  return { startDate: `${String(parts.year).padStart(4, "0")}-01-01`, endDate: anchorDate };
}

function nextLocalMidnightDelay(nowMs, timeZone) {
  const current = freezeLocalTime(nowMs, timeZone).localDate;
  // Search forward coarsely, then binary-search the first epoch assigned to a
  // later civil date in this zone. This works for DST and non-hour offsets.
  let low = nowMs;
  let high = nowMs + 36 * 3600000;
  while (freezeLocalTime(high, timeZone).localDate === current) high += 12 * 3600000;
  while (high - low > 1000) {
    const mid = Math.floor((low + high) / 2);
    if (freezeLocalTime(mid, timeZone).localDate === current) low = mid;
    else high = mid;
  }
  return Math.max(1000, high - nowMs + 1000);
}

function createRecapRuntime(options = {}) {
  const now = options.now || Date.now;
  const getEnabled = options.getEnabled || (() => true);
  const getTimeZone = options.getTimeZone || getSystemTimeZone;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const logWarn = options.logWarn || console.warn;
  const store = options.store || createRecapStore({
    root: options.root || DEFAULT_ROOT,
    now,
    getTimeZone,
    logWarn,
  });
  const journal = options.journal || createRecapJournal({ store, now, getTimeZone, logWarn });
  const aggregate = options.aggregate || createRecapAggregate({ store, logWarn });
  const coverage = options.coverage || createRecapCoverage({
    store,
    now,
    getTimeZone,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    logWarn,
  });
  const powerMonitor = options.powerMonitor || null;
  let initialized = false;
  let started = false;
  let enabled = false;
  let suspended = false;
  let midnightTimer = null;
  let unavailable = false;
  let unavailableCode = null;

  function warn(message, err) {
    try {
      const detail = err && err.message ? err.message : err;
      if (detail === undefined) logWarn(message);
      else logWarn(message, detail);
    } catch {}
  }

  function currentLocalDate() {
    return freezeLocalTime(now(), getTimeZone()).localDate;
  }

  function prune() {
    const date = currentLocalDate();
    journal.prune(date);
    aggregate.prune(date);
    coverage.prune(date);
  }

  function initialize() {
    if (initialized) return true;
    if (unavailable) return false;
    try {
      store.initialize();
      aggregate.load();
      coverage.load();
      const date = currentLocalDate();
      const records = journal.loadRetained(date);
      aggregate.replaceDates(journal.retainedDates(date), records);
      prune();
      aggregate.flush();
      initialized = true;
      return true;
    } catch (err) {
      unavailable = true;
      unavailableCode = err && typeof err.code === "string" ? err.code : "storage-error";
      enabled = false;
      try { aggregate.resetMemory(); } catch {}
      try { coverage.resetMemory(); } catch {}
      warn("Clawd: local recap storage is unavailable; recording is paused", unavailableCode);
      return false;
    }
  }

  function scheduleMidnight() {
    if (!started) return;
    if (midnightTimer) clearTimer(midnightTimer);
    midnightTimer = setTimer(() => {
      midnightTimer = null;
      try {
        if (enabled && !suspended) coverage.tick(now());
        prune();
      } catch (err) {
        warn("Clawd: recap midnight rollover failed", err);
      }
      scheduleMidnight();
    }, nextLocalMidnightDelay(now(), getTimeZone()));
    if (midnightTimer && typeof midnightTimer.unref === "function") midnightTimer.unref();
  }

  function start() {
    if (started) return false;
    started = true;
    if (!initialize()) return false;
    enabled = getEnabled() !== false;
    if (enabled && !suspended) coverage.start(now());
    if (powerMonitor && typeof powerMonitor.on === "function") {
      powerMonitor.on("suspend", handleSuspend);
      powerMonitor.on("resume", handleResume);
      powerMonitor.on("unlock-screen", handleResume);
    }
    scheduleMidnight();
    return true;
  }

  function handleSuspend() {
    if (suspended) return;
    suspended = true;
    if (enabled) coverage.stop(now());
  }

  function handleResume() {
    const wasSuspended = suspended;
    suspended = false;
    if (enabled && wasSuspended) coverage.start(now());
    if (enabled) coverage.tick(now());
    prune();
    scheduleMidnight();
  }

  function setEnabled(next) {
    if (!initialize()) return false;
    const value = next !== false;
    if (value === enabled) return false;
    enabled = value;
    if (started && !suspended) {
      if (enabled) coverage.start(now());
      else coverage.stop(now());
    }
    return true;
  }

  function record(event, identity = {}) {
    if (!started || !enabled || !initialize()) return false;
    const canonical = createCanonicalRecapEvent(event);
    if (canonical.occurredAt > now() + MAX_FUTURE_SKEW_MS) return false;
    const recordValue = journal.buildRecord(canonical, identity);
    const anchorDate = currentLocalDate();
    const oldestAcceptedDate = addLocalDays(anchorDate, -13);
    if (
      compareLocalDates(recordValue.localDate, oldestAcceptedDate) < 0
      || compareLocalDates(recordValue.localDate, anchorDate) > 0
    ) return false;
    // Journal first: a process loss can be rebuilt. Updating the monthly cache
    // without a durable event would permanently overcount after restart.
    if (!journal.append(recordValue)) return false;
    aggregate.apply(recordValue);
    coverage.tick(now());
    return true;
  }

  function query(period = "today", optionsValue = {}) {
    const queryTime = freezeLocalTime(now(), getTimeZone());
    const anchorDate = optionsValue.anchorDate || queryTime.localDate;
    const { startDate, endDate } = rangeForPeriod(period, anchorDate);
    if (compareLocalDates(startDate, endDate) > 0) throw new RangeError("invalid recap range");
    if (!initialize()) {
      return {
        schemaVersion: 1,
        status: "unavailable",
        reason: unavailableCode || "storage-error",
        period,
        anchorDate,
        startDate,
        endDate,
        recordingEnabled: false,
        days: [],
      };
    }
    const aggregateDays = aggregate.query(startDate, endDate);
    const coverageDays = coverage.query(startDate, endDate, now());
    const scopeOrdinals = new Map();
    const scopeCounts = { local: 0, wsl: 0, remote: 0 };
    function presentationScope(row) {
      const key = `${row.scope}\0${row.scopeKeyHash}`;
      if (!scopeOrdinals.has(key)) {
        scopeCounts[row.scope] += 1;
        scopeOrdinals.set(key, `${row.scope}-${scopeCounts[row.scope]}`);
      }
      return scopeOrdinals.get(key);
    }
    const coverageByDate = new Map(coverageDays.map((day) => [day.localDate, day]));
    const meta = store.getMeta();
    const recordingStarted = meta.createdLocalTime || null;
    const days = aggregateDays.map((day) => ({
      localDate: day.localDate,
      coverage: coverageByDate.get(day.localDate) || {
        localDate: day.localDate,
        coverageMinutes: Array(24).fill(0),
        hourKindsByTimeZone: {},
      },
      hourKindsByTimeZone: day.hourKindsByTimeZone,
      timeZones: day.timeZones,
      rows: day.rows.map((row) => ({
        agentId: row.agentId,
        scope: row.scope,
        scopeInstance: presentationScope(row),
        metrics: row.metrics,
        sessionsStartedPartial: row.sessionsStartedPartial,
        hours: row.hours,
      })),
    }));
    return {
      schemaVersion: 1,
      status: "ready",
      period,
      anchorDate,
      startDate,
      endDate,
      currentLocalHour: queryTime.localHour,
      recordingStartedDate: recordingStarted ? recordingStarted.localDate : null,
      recordingStartedLocalHour: recordingStarted ? recordingStarted.localHour : null,
      recordingEnabled: enabled,
      days,
    };
  }

  function clear() {
    // Clear is an explicit user recovery action and is allowed to reset an
    // unavailable/corrupt recap generation. No other path rotates its salt.
    if (initialized) {
      try { coverage.stop(now()); } catch {}
      try { aggregate.flush(); } catch {}
    }
    try { coverage.resetMemory(); } catch {}
    try { aggregate.resetMemory(); } catch {}
    initialized = false;
    unavailable = false;
    unavailableCode = null;
    try { store.clear(); } catch (err) {
      unavailable = true;
      unavailableCode = err && err.code ? err.code : "storage-error";
      enabled = false;
      warn("Clawd: local recap clear failed", unavailableCode);
      return false;
    }
    if (!initialize()) return false;
    enabled = getEnabled() !== false;
    if (started && enabled && !suspended) coverage.start(now());
    return true;
  }

  function flush() {
    if (!initialized || unavailable) return;
    if (started && enabled && !suspended) coverage.tick(now());
    aggregate.flush();
  }

  function dispose() {
    if (midnightTimer) clearTimer(midnightTimer);
    midnightTimer = null;
    if (powerMonitor && typeof powerMonitor.removeListener === "function") {
      powerMonitor.removeListener("suspend", handleSuspend);
      powerMonitor.removeListener("resume", handleResume);
      powerMonitor.removeListener("unlock-screen", handleResume);
    }
    if (initialized) {
      try {
        if (started && enabled && !suspended) coverage.stop(now());
        aggregate.flush();
      } catch (err) {
        warn("Clawd: local recap shutdown flush failed", err && err.code ? err.code : "storage-error");
      }
      try { coverage.resetMemory(); } catch {}
    }
    started = false;
  }

  return Object.freeze({
    clear,
    dispose,
    flush,
    query,
    record,
    setEnabled,
    start,
  });
}

module.exports = {
  MAX_FUTURE_SKEW_MS,
  PERIODS,
  createRecapRuntime,
  nextLocalMidnightDelay,
  rangeForPeriod,
};
