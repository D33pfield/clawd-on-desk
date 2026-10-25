"use strict";

// Pet mood: four independent, leaky channels (stress, satisfaction, fatigue,
// boredom) that decay toward a baseline. Everything here is a pure function of
// a plain state object and an explicit clock so it can be tested without
// timers. Persistence lives in mood-store.js; the main process wires events in
// and the idle roll in tick.js asks chooseMoment() whether to play a moment.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const MOODS = Object.freeze(["stress", "satisfaction", "fatigue", "boredom"]);

const DEFAULT_CONFIG = Object.freeze({
  stress: Object.freeze({ baseline: 0, halfLifeMs: 15 * MINUTE_MS }),
  satisfaction: Object.freeze({ baseline: 0, halfLifeMs: 20 * MINUTE_MS }),
  // Context-window pressure: the last seen fraction fades like a stale reading.
  context: Object.freeze({ halfLifeMs: 30 * MINUTE_MS, startFraction: 0.6, maxFatigue: 0.6 }),
  // Fatigue follows time awake. A gap this long counts as sleep and re-anchors.
  fatigue: Object.freeze({ wakeGapMs: 5 * HOUR_MS, restMs: 5 * HOUR_MS, fullMs: 14 * HOUR_MS }),
  // Boredom is derived from time since the last agent activity.
  boredom: Object.freeze({ startMs: 3 * MINUTE_MS, fullMs: 20 * MINUTE_MS, maxIdleMs: 3 * HOUR_MS }),
  // Bump sizes: v += k * (1 - v), so repeated events saturate instead of pinning.
  events: Object.freeze({
    "tool-failure": Object.freeze({ stress: 0.10 }),
    "stop-failure": Object.freeze({ stress: 0.35 }),
    "permission-denied": Object.freeze({ stress: 0.10 }),
    "test-fail": Object.freeze({ stress: 0.25 }),
    "stop": Object.freeze({ satisfaction: 0.15 }),
    "test-pass": Object.freeze({ satisfaction: 0.25 }),
  }),
  // A passing test calms stress and adds extra satisfaction scaled by how
  // stressed the pet was (relief).
  testPass: Object.freeze({ stressRelief: 0.5, reliefBonusMax: 0.35 }),
  // Moments should happen a few times over a day, not constantly. Below `floor`
  // nothing plays; at `full` and above the chance is `cap`; in between it rises
  // along t^curve (curve > 1 keeps mild moods rare and strong ones reliable).
  moment: Object.freeze({
    floor: 0.35,
    full: 0.9,
    cap: 0.75,
    curve: 1.5,
    perMoodCooldownMs: 30 * MINUTE_MS,
    globalCooldownMs: 10 * MINUTE_MS,
  }),
});

// Events that only refresh the activity clock (boredom, wake anchor).
const ACTIVITY_EVENTS = new Set(["activity", "session-start", "permission-allowed"]);

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function ramp(value, from, to) {
  if (!(to > from)) return value >= to ? 1 : 0;
  return clamp01((value - from) / (to - from));
}

function createState() {
  return {
    version: 1,
    stress: null,
    satisfaction: null,
    context: null,
    wakeAt: null,
    lastActivityAt: null,
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (!Number.isFinite(entry.value) || !Number.isFinite(entry.updatedAt)) return null;
  return { value: clamp01(entry.value), updatedAt: entry.updatedAt };
}

// Accepts whatever was on disk; anything malformed falls back to a fresh field.
function restoreState(raw) {
  const state = createState();
  if (!raw || typeof raw !== "object" || raw.version !== 1) return state;
  state.stress = normalizeEntry(raw.stress);
  state.satisfaction = normalizeEntry(raw.satisfaction);
  state.context = normalizeEntry(raw.context);
  if (Number.isFinite(raw.wakeAt)) state.wakeAt = raw.wakeAt;
  if (Number.isFinite(raw.lastActivityAt)) state.lastActivityAt = raw.lastActivityAt;
  return state;
}

function decayed(entry, baseline, halfLifeMs, now) {
  if (!entry) return baseline;
  const dt = Math.max(0, now - entry.updatedAt);
  return baseline + (entry.value - baseline) * Math.pow(0.5, dt / halfLifeMs);
}

function bumped(entry, channelConfig, k, now) {
  const value = decayed(entry, channelConfig.baseline, channelConfig.halfLifeMs, now);
  return { value: clamp01(value + k * (1 - value)), updatedAt: now };
}

function touched(state, now, config) {
  const gap = state.lastActivityAt == null ? Infinity : now - state.lastActivityAt;
  const wakeAt = state.wakeAt == null || gap >= config.fatigue.wakeGapMs ? now : state.wakeAt;
  return { ...state, wakeAt, lastActivityAt: now };
}

function applyEvent(state, event, now, config = DEFAULT_CONFIG) {
  const type = event && event.type;
  if (typeof type !== "string") return state;

  if (type === "context") {
    const fraction = Number(event.fraction);
    if (!Number.isFinite(fraction)) return state;
    return { ...state, context: { value: clamp01(fraction), updatedAt: now } };
  }

  let next = touched(state, now, config);
  if (ACTIVITY_EVENTS.has(type)) return next;

  const effects = config.events[type];
  if (!effects) return next;

  if (type === "test-pass") {
    const stressNow = decayed(next.stress, config.stress.baseline, config.stress.halfLifeMs, now);
    const k = Math.min(0.95, effects.satisfaction + config.testPass.reliefBonusMax * stressNow);
    next = {
      ...next,
      satisfaction: bumped(next.satisfaction, config.satisfaction, k, now),
      stress: { value: stressNow * (1 - config.testPass.stressRelief), updatedAt: now },
    };
    return next;
  }

  if (effects.stress) next = { ...next, stress: bumped(next.stress, config.stress, effects.stress, now) };
  if (effects.satisfaction) {
    next = { ...next, satisfaction: bumped(next.satisfaction, config.satisfaction, effects.satisfaction, now) };
  }
  return next;
}

function read(state, now, config = DEFAULT_CONFIG) {
  const stress = decayed(state.stress, config.stress.baseline, config.stress.halfLifeMs, now);
  const satisfaction = decayed(state.satisfaction, config.satisfaction.baseline, config.satisfaction.halfLifeMs, now);

  const idleMs = state.lastActivityAt == null ? 0 : Math.max(0, now - state.lastActivityAt);
  const slept = state.lastActivityAt != null && idleMs >= config.fatigue.wakeGapMs;
  const awakeMs = state.wakeAt == null || slept ? 0 : Math.max(0, now - state.wakeAt);
  const clockFatigue = ramp(awakeMs, config.fatigue.restMs, config.fatigue.fullMs);

  const contextFraction = decayed(state.context, 0, config.context.halfLifeMs, now);
  const contextFatigue = ramp(contextFraction, config.context.startFraction, 1) * config.context.maxFatigue;
  const fatigue = 1 - (1 - clockFatigue) * (1 - contextFatigue);

  const boredom = idleMs >= config.boredom.maxIdleMs
    ? 0
    : ramp(idleMs, config.boredom.startMs, config.boredom.fullMs);

  return { stress: clamp01(stress), satisfaction: clamp01(satisfaction), fatigue: clamp01(fatigue), boredom };
}

// Chance that a channel at `value` plays a moment on an idle roll.
function momentChance(value, moment) {
  if (!(value >= moment.floor)) return 0;
  const t = Math.min(1, (value - moment.floor) / (moment.full - moment.floor));
  return moment.cap * Math.pow(t, moment.curve);
}

// Decide whether an idle period should play a mood moment. `available` lists
// the moods the current theme has animations for; `cooldowns` is
// { last: { [mood]: ms }, lastAny: ms|null }. Returns a mood name or null.
function chooseMoment({ values, available, cooldowns, now, random, config = DEFAULT_CONFIG }) {
  const moment = config.moment;
  if (cooldowns.lastAny != null && now - cooldowns.lastAny < moment.globalCooldownMs) return null;

  let best = null;
  for (const mood of MOODS) {
    if (!available.includes(mood)) continue;
    const last = cooldowns.last[mood];
    if (last != null && now - last < moment.perMoodCooldownMs) continue;
    if (best === null || values[mood] > values[best]) best = mood;
  }
  if (best === null || values[best] < moment.floor) return null;

  const chance = momentChance(values[best], moment);
  const roll = random();
  if (!Number.isFinite(roll) || roll >= chance) return null;
  return best;
}

// Translate what the hook route / permission bubble knows into mood events.
// `failureKind` is set by the Claude hook when a plain Stop actually carried an
// API error, so it counts as a failure rather than a clean finish.
function moodEventsFromHook(input) {
  const { event, testResult, failureKind, contextPercent, permissionDecision } = input || {};
  if (permissionDecision === "deny") return [{ type: "permission-denied" }];
  if (permissionDecision === "allow") return [{ type: "permission-allowed" }];

  const events = [];
  if (Number.isFinite(contextPercent)) events.push({ type: "context", fraction: contextPercent / 100 });
  if (testResult === "fail") events.push({ type: "test-fail" });
  else if (testResult === "pass") events.push({ type: "test-pass" });
  else if (event === "PostToolUseFailure") events.push({ type: "tool-failure" });
  else if (event === "StopFailure" || (event === "Stop" && failureKind === "api_error")) {
    events.push({ type: "stop-failure" });
  } else if (event === "Stop") events.push({ type: "stop" });
  else if (event === "SessionStart") events.push({ type: "session-start" });
  else events.push({ type: "activity" });
  return events;
}

// Decorative like the test reaction: opt-in pref, headless sources ignored,
// and it must never throw into the hook route.
function createMoodEventHandler(options = {}) {
  const tracker = options.tracker;
  const getEnabled = options.getEnabled || (() => false);
  return function handleMoodEvent(input, context = {}) {
    if (getEnabled() !== true || context.headless === true) return false;
    for (const event of moodEventsFromHook(input)) tracker.applyEvent(event);
    return true;
  };
}

// Stateful wrapper used by the main process.
function createMoodTracker(options = {}) {
  const config = options.config || DEFAULT_CONFIG;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const log = typeof options.log === "function" ? options.log : () => {};
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  let state = restoreState(options.initialState);
  const cooldowns = { last: Object.create(null), lastAny: null };

  function format(values) {
    return MOODS.map((mood) => `${mood}=${values[mood].toFixed(2)}`).join(" ");
  }

  return {
    applyEvent(event) {
      const t = now();
      const next = applyEvent(state, event, t, config);
      if (next === state) return;
      state = next;
      // Plain activity and context readings arrive with nearly every hook;
      // logging them would bury the events that actually move a channel.
      if (event.type !== "activity" && event.type !== "context") {
        log(`mood event=${event.type} ${format(read(state, t, config))}`);
      }
      onChange();
    },
    read() {
      return read(state, now(), config);
    },
    chooseMoment(available) {
      const t = now();
      const mood = chooseMoment({
        values: read(state, t, config), available, cooldowns, now: t, random, config,
      });
      if (mood) log(`mood moment chosen=${mood}`);
      return mood;
    },
    markMomentPlayed(mood) {
      const t = now();
      cooldowns.last[mood] = t;
      cooldowns.lastAny = t;
    },
    serialize() {
      return state;
    },
  };
}

module.exports = {
  MOODS,
  DEFAULT_CONFIG,
  createState,
  restoreState,
  applyEvent,
  read,
  chooseMoment,
  momentChance,
  moodEventsFromHook,
  createMoodEventHandler,
  createMoodTracker,
};
