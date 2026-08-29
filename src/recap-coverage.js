"use strict";

const fs = require("fs");
const {
  addLocalDays,
  compareLocalDates,
  describeLocalDay,
  freezeLocalTime,
  getZonedDateTimeParts,
  getSystemTimeZone,
  isValidTimeZone,
  parseLocalDate,
} = require("./recap-time");
const { DAILY_RETENTION_DAYS } = require("./recap-store");

const HEARTBEAT_MS = 60000;

function monthOf(localDate) {
  parseLocalDate(localDate);
  return localDate.slice(0, 7);
}

const HOUR_KINDS = new Set(["normal", "gap", "fold"]);

function describeHourKinds(localDate, timeZoneId) {
  return describeLocalDay(localDate, timeZoneId).map((cell) => cell.kind);
}

function normalizeHourKindsByTimeZone(value, timeZones) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {};
  for (const timeZoneId of timeZones) {
    const kinds = value[timeZoneId];
    if (
      !Array.isArray(kinds)
      || kinds.length !== 24
      || kinds.some((kind) => !HOUR_KINDS.has(kind))
    ) return null;
    normalized[timeZoneId] = kinds.slice();
  }
  return normalized;
}

function normalizeInterval(value, expectedDate = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    !Number.isSafeInteger(value.startedAt)
    || !Number.isSafeInteger(value.endedAt)
    || value.startedAt < 0
    || value.endedAt < value.startedAt
    || !isValidTimeZone(value.timeZoneId)
    || !Number.isInteger(value.startedOffsetMinutes)
    || !Number.isInteger(value.endedOffsetMinutes)
  ) return null;
  const local = freezeLocalTime(value.startedAt, value.timeZoneId);
  const endedLocal = freezeLocalTime(value.endedAt, value.timeZoneId);
  if (expectedDate && local.localDate !== expectedDate) return null;
  if (
    local.utcOffsetMinutes !== value.startedOffsetMinutes
    || endedLocal.utcOffsetMinutes !== value.endedOffsetMinutes
  ) return null;
  return {
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    timeZoneId: value.timeZoneId,
    startedOffsetMinutes: value.startedOffsetMinutes,
    endedOffsetMinutes: value.endedOffsetMinutes,
  };
}

function unionIntervals(intervals) {
  const sorted = intervals
    .map((entry) => ({ ...entry }))
    .sort((left, right) =>
      left.timeZoneId.localeCompare(right.timeZoneId)
      || left.startedAt - right.startedAt
      || left.endedAt - right.endedAt);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && previous.timeZoneId === interval.timeZoneId
      && interval.startedAt <= previous.endedAt
    ) {
      if (interval.endedAt > previous.endedAt) {
        previous.endedAt = interval.endedAt;
        previous.endedOffsetMinutes = interval.endedOffsetMinutes;
      }
      continue;
    }
    merged.push(interval);
  }
  return merged;
}

function createRecapCoverage(options = {}) {
  if (!options.store) throw new Error("createRecapCoverage requires store");
  const store = options.store;
  const now = options.now || Date.now;
  const getTimeZone = options.getTimeZone || getSystemTimeZone;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : HEARTBEAT_MS;
  const logWarn = options.logWarn || console.warn;
  const months = new Map();
  let open = null;
  let heartbeatTimer = null;

  function warn(message, err) {
    try {
      const detail = err && err.message ? err.message : err;
      if (detail === undefined) logWarn(message);
      else logWarn(message, detail);
    } catch {}
  }

  function monthPath(month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new TypeError("invalid coverage month");
    return store.childPath(`coverage-${month}.json`);
  }

  function openPath() {
    return store.childPath("coverage-open.json");
  }

  function load() {
    months.clear();
    let names = [];
    try { names = fs.readdirSync(store.root); } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    for (const name of names) {
      const match = /^coverage-(\d{4}-\d{2})\.json$/.exec(name);
      if (!match) continue;
      const parsed = store.readJson(store.childPath(name));
      if (!parsed || parsed.schemaVersion !== 1 || parsed.month !== match[1]) {
        try {
          store.quarantine(store.childPath(name), "invalid-coverage");
          warn("Clawd: quarantined invalid recap coverage file");
        } catch (err) {
          throw new Error(`recap coverage could not be quarantined: ${err && err.message}`);
        }
        continue;
      }
      const month = { schemaVersion: 1, month: match[1], days: {} };
      for (const [localDate, day] of Object.entries(parsed.days || {})) {
        try { parseLocalDate(localDate); } catch { continue; }
        if (!localDate.startsWith(`${match[1]}-`) || !day || typeof day !== "object") continue;
        const intervals = unionIntervals((Array.isArray(day.intervals) ? day.intervals : [])
          .map((interval) => normalizeInterval(interval, localDate))
          .filter(Boolean));
        const timeZones = [...new Set(intervals.map((interval) => interval.timeZoneId))];
        const hourKindsByTimeZone = normalizeHourKindsByTimeZone(day.hourKindsByTimeZone, timeZones);
        if (timeZones.length > 0 && !hourKindsByTimeZone) continue;
        month.days[localDate] = { intervals, hourKindsByTimeZone: hourKindsByTimeZone || {} };
      }
      months.set(match[1], month);
      // Rewrite through the allowlist so malformed days/intervals cannot stay
      // indefinitely in an otherwise parseable managed file.
      persistMonth(match[1]);
    }
    recoverOpenInterval();
  }

  function ensureMonth(month) {
    if (!months.has(month)) months.set(month, { schemaVersion: 1, month, days: {} });
    return months.get(month);
  }

  function persistMonth(monthName) {
    const month = ensureMonth(monthName);
    if (Object.keys(month.days).length === 0) {
      try { fs.unlinkSync(monthPath(monthName)); } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
      return;
    }
    store.writeJsonAtomic(monthPath(monthName), month);
  }

  function persistOpen() {
    if (!open) {
      try { fs.unlinkSync(openPath()); } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
      return;
    }
    store.writeJsonAtomic(openPath(), {
      schemaVersion: 1,
      startedAt: open.startedAt,
      lastHeartbeatAt: open.lastHeartbeatAt,
      timeZoneId: open.timeZoneId,
    });
  }

  function addClosedInterval(startedAt, endedAt, timeZoneId) {
    if (endedAt <= startedAt) return false;
    // Runtime rollover keeps normal intervals within one local day. Crash
    // recovery can cross midnight, so find each exact civil-date boundary and
    // keep one compact interval per local day (not one row per heartbeat).
    const touched = new Set();
    let cursor = startedAt;
    while (cursor < endedAt) {
      const local = freezeLocalTime(cursor, timeZoneId);
      let next = endedAt;
      const finalLocal = freezeLocalTime(Math.max(cursor, endedAt - 1), timeZoneId);
      if (finalLocal.localDate !== local.localDate) {
        let low = cursor;
        let high = endedAt;
        while (high - low > 1) {
          const mid = Math.floor((low + high) / 2);
          if (freezeLocalTime(mid, timeZoneId).localDate === local.localDate) low = mid;
          else high = mid;
        }
        next = high;
      }
      const nextLocal = freezeLocalTime(next, timeZoneId);
      const monthName = monthOf(local.localDate);
      const month = ensureMonth(monthName);
      const day = month.days[local.localDate] || (month.days[local.localDate] = {
        intervals: [],
        hourKindsByTimeZone: {},
      });
      const interval = {
        startedAt: cursor,
        endedAt: next,
        timeZoneId,
        startedOffsetMinutes: local.utcOffsetMinutes,
        endedOffsetMinutes: nextLocal.utcOffsetMinutes,
      };
      day.intervals = unionIntervals([...day.intervals, interval]);
      if (!day.hourKindsByTimeZone[timeZoneId]) {
        day.hourKindsByTimeZone[timeZoneId] = describeHourKinds(local.localDate, timeZoneId);
      }
      touched.add(monthName);
      cursor = next;
    }
    for (const monthName of touched) persistMonth(monthName);
    return true;
  }

  function recoverOpenInterval() {
    const saved = store.readJson(openPath());
    if (!saved || saved.schemaVersion !== 1) return false;
    if (
      !Number.isSafeInteger(saved.startedAt)
      || !Number.isSafeInteger(saved.lastHeartbeatAt)
      || saved.startedAt < 0
      || saved.lastHeartbeatAt < saved.startedAt
      || !isValidTimeZone(saved.timeZoneId)
    ) {
      warn("Clawd: discarded invalid recap coverage heartbeat");
      try { fs.unlinkSync(openPath()); } catch {}
      return false;
    }
    addClosedInterval(saved.startedAt, saved.lastHeartbeatAt, saved.timeZoneId);
    try { fs.unlinkSync(openPath()); } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    return true;
  }

  function scheduleHeartbeat() {
    if (!open || heartbeatTimer) return;
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null;
      try {
        tick(now());
      } catch (err) {
        warn("Clawd: recap coverage heartbeat failed", err);
      }
      scheduleHeartbeat();
    }, heartbeatMs);
    if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }

  function start(at = now()) {
    if (open) return false;
    const requestedTimeZone = getTimeZone();
    const timeZoneId = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";
    open = { startedAt: at, lastHeartbeatAt: at, timeZoneId };
    persistOpen();
    scheduleHeartbeat();
    return true;
  }

  function stop(at = now()) {
    if (!open) return false;
    if (heartbeatTimer) clearTimer(heartbeatTimer);
    heartbeatTimer = null;
    const endedAt = Math.max(open.startedAt, at);
    const closed = { ...open };
    open = null;
    addClosedInterval(closed.startedAt, endedAt, closed.timeZoneId);
    persistOpen();
    return true;
  }

  function tick(at = now()) {
    if (!open) return false;
    const requestedTimeZone = getTimeZone();
    const zone = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";
    const oldLocal = freezeLocalTime(open.lastHeartbeatAt, open.timeZoneId);
    const newLocal = freezeLocalTime(at, zone);
    if (zone !== open.timeZoneId || oldLocal.localDate !== newLocal.localDate) {
      const previous = { ...open };
      open = null;
      addClosedInterval(previous.startedAt, at, previous.timeZoneId);
      open = { startedAt: at, lastHeartbeatAt: at, timeZoneId: zone };
    } else {
      open.lastHeartbeatAt = Math.max(open.lastHeartbeatAt, at);
    }
    persistOpen();
    return true;
  }

  function prune(anchorDate) {
    const oldest = addLocalDays(anchorDate, -(DAILY_RETENTION_DAYS - 1));
    for (const [monthName, month] of months) {
      let changed = false;
      for (const localDate of Object.keys(month.days)) {
        if (compareLocalDates(localDate, oldest) < 0) {
          delete month.days[localDate];
          changed = true;
        }
      }
      if (changed) persistMonth(monthName);
    }
  }

  function query(startDate, endDate, queryNow = now()) {
    parseLocalDate(startDate);
    parseLocalDate(endDate);
    const result = [];
    for (let date = startDate; compareLocalDates(date, endDate) <= 0; date = addLocalDays(date, 1)) {
      const month = months.get(monthOf(date));
      const stored = month && month.days[date];
      const intervals = stored ? stored.intervals.map((entry) => ({ ...entry })) : [];
      if (open && freezeLocalTime(open.startedAt, open.timeZoneId).localDate === date) {
        intervals.push({
          startedAt: open.startedAt,
          endedAt: Math.max(open.startedAt, queryNow),
          timeZoneId: open.timeZoneId,
          startedOffsetMinutes: freezeLocalTime(open.startedAt, open.timeZoneId).utcOffsetMinutes,
          endedOffsetMinutes: freezeLocalTime(Math.max(open.startedAt, queryNow), open.timeZoneId).utcOffsetMinutes,
        });
      }
      const coverageMinutes = Array(24).fill(0);
      const timeZones = new Set();
      for (const interval of unionIntervals(intervals)) {
        timeZones.add(interval.timeZoneId);
        for (let cursor = interval.startedAt; cursor < interval.endedAt;) {
          const local = getZonedDateTimeParts(cursor, interval.timeZoneId);
          const elapsedInWallHourMs = (
            local.localMinute * 60000
            + local.localSecond * 1000
            + (cursor % 1000)
          );
          const nextWallHour = cursor + Math.max(1, 3600000 - elapsedInWallHourMs);
          const next = Math.min(interval.endedAt, nextWallHour);
          if (local.localDate === date) {
            coverageMinutes[local.localHour] += (next - cursor) / 60000;
          }
          cursor = next;
        }
      }
      const hourKindsByTimeZone = {};
      for (const zone of timeZones) {
        const frozen = stored && stored.hourKindsByTimeZone
          ? stored.hourKindsByTimeZone[zone]
          : null;
        hourKindsByTimeZone[zone] = frozen
          ? frozen.slice()
          : describeHourKinds(date, zone);
      }
      result.push({ localDate: date, coverageMinutes, hourKindsByTimeZone });
    }
    return result;
  }

  function resetMemory() {
    if (heartbeatTimer) clearTimer(heartbeatTimer);
    heartbeatTimer = null;
    open = null;
    months.clear();
  }

  return Object.freeze({
    load,
    prune,
    query,
    resetMemory,
    start,
    stop,
    tick,
  });
}

module.exports = { HEARTBEAT_MS, createRecapCoverage, normalizeInterval, unionIntervals };
