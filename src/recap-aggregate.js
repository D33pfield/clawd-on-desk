"use strict";

const fs = require("fs");
const { AGENT_METRIC_POLICIES } = require("./recap-metrics");
const {
  addLocalDays,
  compareLocalDates,
  describeLocalDay,
  parseLocalDate,
} = require("./recap-time");
const { DAILY_RETENTION_DAYS } = require("./recap-store");

function monthOf(localDate) {
  parseLocalDate(localDate);
  return localDate.slice(0, 7);
}

function rowKey(record) {
  return `${record.agentId}\0${record.scope}\0${record.scopeKeyHash}`;
}

function emptyCount(supported) {
  return supported ? 0 : null;
}

function createRow(record) {
  const support = { ...record.support };
  return {
    agentId: record.agentId,
    scope: record.scope,
    scopeKeyHash: record.scopeKeyHash,
    metrics: {
      sessionsStarted: emptyCount(support.sessionsStarted),
      turnsCompleted: emptyCount(support.turnsCompleted),
      toolCalls: emptyCount(support.toolCalls),
      activityEvents: 0,
    },
    support,
    sessionsStartedPartial: !support.sessionsStarted,
    hours: Array(24).fill(0),
  };
}

function validCount(value, nullable = false) {
  return (nullable && value === null) || (Number.isSafeInteger(value) && value >= 0);
}

function normalizeRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!AGENT_METRIC_POLICIES[value.agentId]) return null;
  if (!["local", "wsl", "remote"].includes(value.scope)) return null;
  if (typeof value.scopeKeyHash !== "string" || !value.scopeKeyHash.startsWith("hmac:")) return null;
  const metrics = value.metrics || {};
  const support = value.support;
  if (
    !support
    || typeof support !== "object"
    || typeof support.sessionsStarted !== "boolean"
    || typeof support.turnsCompleted !== "boolean"
    || typeof support.toolCalls !== "boolean"
  ) return null;
  const sessionsSupported = support.sessionsStarted;
  const turnsSupported = support.turnsCompleted;
  const toolsSupported = support.toolCalls;
  if (
    !validCount(metrics.sessionsStarted, !sessionsSupported)
    || (sessionsSupported && metrics.sessionsStarted === null)
    || (!sessionsSupported && metrics.sessionsStarted !== null)
    || !validCount(metrics.turnsCompleted, !turnsSupported)
    || (turnsSupported && metrics.turnsCompleted === null)
    || (!turnsSupported && metrics.turnsCompleted !== null)
    || !validCount(metrics.toolCalls, !toolsSupported)
    || (toolsSupported && metrics.toolCalls === null)
    || (!toolsSupported && metrics.toolCalls !== null)
    || !validCount(metrics.activityEvents)
    || !Array.isArray(value.hours)
    || value.hours.length !== 24
    || !value.hours.every((count) => validCount(count))
  ) return null;
  return {
    agentId: value.agentId,
    scope: value.scope,
    scopeKeyHash: value.scopeKeyHash,
    metrics: {
      sessionsStarted: metrics.sessionsStarted,
      turnsCompleted: metrics.turnsCompleted,
      toolCalls: metrics.toolCalls,
      activityEvents: metrics.activityEvents,
    },
    support: { ...support },
    sessionsStartedPartial: !sessionsSupported || value.sessionsStartedPartial === true,
    hours: value.hours.slice(),
  };
}

function normalizeDay(localDate, value) {
  try { parseLocalDate(localDate); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rows = {};
  for (const candidate of Object.values(value.rows || {})) {
    const row = normalizeRow(candidate);
    if (row) rows[rowKey(row)] = row;
  }
  const timeZones = {};
  for (const [zone, kinds] of Object.entries(value.hourKindsByTimeZone || {})) {
    if (
      typeof zone === "string"
      && Array.isArray(kinds)
      && kinds.length === 24
      && kinds.every((kind) => ["normal", "gap", "fold"].includes(kind))
    ) timeZones[zone] = kinds.slice();
  }
  const timeZoneOffsets = [];
  for (const entry of Array.isArray(value.timeZones) ? value.timeZones : []) {
    if (
      entry
      && typeof entry.id === "string"
      && Object.hasOwn(timeZones, entry.id)
      && Number.isInteger(entry.utcOffsetMinutes)
      && entry.utcOffsetMinutes >= -24 * 60
      && entry.utcOffsetMinutes <= 24 * 60
      && !timeZoneOffsets.some((known) =>
        known.id === entry.id && known.utcOffsetMinutes === entry.utcOffsetMinutes)
    ) timeZoneOffsets.push({ id: entry.id, utcOffsetMinutes: entry.utcOffsetMinutes });
  }
  timeZoneOffsets.sort((left, right) =>
    left.id.localeCompare(right.id) || left.utcOffsetMinutes - right.utcOffsetMinutes);
  return { rows, hourKindsByTimeZone: timeZones, timeZones: timeZoneOffsets };
}

function createRecapAggregate(options = {}) {
  if (!options.store) throw new Error("createRecapAggregate requires store");
  const store = options.store;
  const flushDelayMs = Number.isFinite(options.flushDelayMs) ? options.flushDelayMs : 2000;
  const logWarn = options.logWarn || console.warn;
  const months = new Map();
  const dirtyMonths = new Set();
  let flushTimer = null;

  function warn(message, err) {
    try {
      const detail = err && err.message ? err.message : err;
      if (detail === undefined) logWarn(message);
      else logWarn(message, detail);
    } catch {}
  }

  function filePath(month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new TypeError("invalid recap month");
    return store.childPath(`daily-${month}.json`);
  }

  function ensureMonth(month) {
    if (!months.has(month)) months.set(month, { schemaVersion: 1, month, days: {} });
    return months.get(month);
  }

  function load() {
    months.clear();
    let names = [];
    try { names = fs.readdirSync(store.root); } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    for (const name of names) {
      const match = /^daily-(\d{4}-\d{2})\.json$/.exec(name);
      if (!match) continue;
      const parsed = store.readJson(store.childPath(name));
      if (!parsed || parsed.schemaVersion !== 1 || parsed.month !== match[1]) {
        try {
          store.quarantine(store.childPath(name), "invalid-daily");
          warn("Clawd: quarantined invalid recap daily aggregate");
        } catch (err) {
          throw new Error(`recap daily aggregate could not be quarantined: ${err && err.message}`);
        }
        continue;
      }
      const month = { schemaVersion: 1, month: match[1], days: {} };
      for (const [localDate, candidate] of Object.entries(parsed.days || {})) {
        if (!localDate.startsWith(`${match[1]}-`)) continue;
        const day = normalizeDay(localDate, candidate);
        if (day) month.days[localDate] = day;
      }
      months.set(match[1], month);
      // Rewrite through the allowlist on the normal initialize flush. This
      // strips invalid rows/fields rather than carrying them indefinitely.
      dirtyMonths.add(match[1]);
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try { flush(); } catch (err) { warn("Clawd: recap aggregate flush failed", err); }
    }, flushDelayMs);
    if (flushTimer && typeof flushTimer.unref === "function") flushTimer.unref();
  }

  function markDirty(month) {
    dirtyMonths.add(month);
    scheduleFlush();
  }

  function ensureDay(record) {
    const month = ensureMonth(monthOf(record.localDate));
    let day = month.days[record.localDate];
    if (!day) day = month.days[record.localDate] = {
      rows: {},
      hourKindsByTimeZone: {},
      timeZones: [],
    };
    if (!day.hourKindsByTimeZone[record.timeZoneId]) {
      day.hourKindsByTimeZone[record.timeZoneId] = describeLocalDay(
        record.localDate,
        record.timeZoneId
      ).map((cell) => cell.kind);
    }
    if (!day.timeZones.some((entry) =>
      entry.id === record.timeZoneId && entry.utcOffsetMinutes === record.utcOffsetMinutes
    )) {
      day.timeZones.push({ id: record.timeZoneId, utcOffsetMinutes: record.utcOffsetMinutes });
      day.timeZones.sort((left, right) =>
        left.id.localeCompare(right.id) || left.utcOffsetMinutes - right.utcOffsetMinutes);
    }
    return { month, day };
  }

  function apply(record, options = {}) {
    const { month, day } = ensureDay(record);
    const key = rowKey(record);
    const row = day.rows[key] || (day.rows[key] = createRow(record));
    for (const metric of ["sessionsStarted", "turnsCompleted", "toolCalls"]) {
      if (row.support[metric] !== true || record.support[metric] !== true) {
        row.support[metric] = false;
        row.metrics[metric] = null;
      }
    }
    if (!row.support.sessionsStarted) row.sessionsStartedPartial = true;
    row.metrics.activityEvents += 1;
    row.hours[record.localHour] += 1;
    if (record.metrics.includes("session-start") && row.metrics.sessionsStarted !== null) {
      row.metrics.sessionsStarted += 1;
    }
    if (record.metrics.includes("turn-complete") && row.metrics.turnsCompleted !== null) {
      row.metrics.turnsCompleted += 1;
    }
    if (record.metrics.includes("tool-call") && row.metrics.toolCalls !== null) {
      row.metrics.toolCalls += 1;
    }
    if (record.sessionStartPartial === true) row.sessionsStartedPartial = true;
    markDirty(month.month);
    if (options.flush === true) flush();
    return row;
  }

  function replaceDates(localDates, records) {
    const changed = new Set();
    for (const localDate of localDates) {
      const monthName = monthOf(localDate);
      const month = ensureMonth(monthName);
      if (month.days[localDate]) delete month.days[localDate];
      changed.add(monthName);
    }
    for (const record of records) apply(record);
    for (const month of changed) markDirty(month);
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
      if (changed) markDirty(monthName);
    }
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const monthName of [...dirtyMonths]) {
      const month = ensureMonth(monthName);
      if (Object.keys(month.days).length === 0) {
        try { fs.unlinkSync(filePath(monthName)); } catch (err) {
          if (!err || err.code !== "ENOENT") throw err;
        }
      } else {
        store.writeJsonAtomic(filePath(monthName), month);
      }
      dirtyMonths.delete(monthName);
    }
  }

  function query(startDate, endDate) {
    parseLocalDate(startDate);
    parseLocalDate(endDate);
    if (compareLocalDates(startDate, endDate) > 0) throw new RangeError("recap query range is reversed");
    const days = [];
    for (let date = startDate; compareLocalDates(date, endDate) <= 0; date = addLocalDays(date, 1)) {
      const day = months.get(monthOf(date));
      const value = day && day.days[date];
      days.push({
        localDate: date,
        hourKindsByTimeZone: value
          ? Object.fromEntries(Object.entries(value.hourKindsByTimeZone).map(([zone, kinds]) => [zone, kinds.slice()]))
          : {},
        timeZones: value ? value.timeZones.map((entry) => ({ ...entry })) : [],
        rows: value ? Object.values(value.rows).map((row) => ({
          ...row,
          metrics: { ...row.metrics },
          support: { ...row.support },
          hours: row.hours.slice(),
        })) : [],
      });
    }
    return days;
  }

  function resetMemory() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    months.clear();
    dirtyMonths.clear();
  }

  return Object.freeze({ apply, flush, load, prune, query, replaceDates, resetMemory });
}

module.exports = { createRecapAggregate, normalizeDay };
