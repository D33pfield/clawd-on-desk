"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_CONFIG,
  createState,
  restoreState,
  applyEvent,
  read,
  chooseMoment,
  momentChance,
  createMoodTracker,
} = require("../src/mood");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = 1_000_000_000_000;

function apply(state, type, at, extra = {}) {
  return applyEvent(state, { type, ...extra }, at);
}

describe("mood channels", () => {
  it("starts at rest", () => {
    assert.deepStrictEqual(read(createState(), T0), {
      stress: 0, satisfaction: 0, fatigue: 0, boredom: 0,
    });
  });

  it("bumps stress on a failure and decays by half each half-life", () => {
    const state = apply(createState(), "stop-failure", T0);
    const fresh = read(state, T0).stress;
    assert.ok(Math.abs(fresh - 0.35) < 1e-9);
    const later = read(state, T0 + DEFAULT_CONFIG.stress.halfLifeMs).stress;
    assert.ok(Math.abs(later - 0.175) < 1e-9);
    assert.ok(read(state, T0 + 3 * HOUR).stress < 0.01);
  });

  it("saturates instead of pinning at 1", () => {
    let state = createState();
    for (let i = 0; i < 40; i++) state = apply(state, "stop-failure", T0);
    const stress = read(state, T0).stress;
    assert.ok(stress > 0.99 && stress <= 1);
    let single = apply(createState(), "tool-failure", T0);
    single = apply(single, "tool-failure", T0);
    assert.ok(read(single, T0).stress < 2 * 0.10);
  });

  it("keeps channels independent", () => {
    let state = apply(createState(), "stop-failure", T0);
    state = apply(state, "stop", T0);
    const values = read(state, T0);
    assert.ok(values.stress > 0.3);
    assert.ok(values.satisfaction > 0.1);
  });

  it("a passing test after stress gives relief: more satisfaction, less stress", () => {
    const calm = apply(createState(), "test-pass", T0);
    let stressed = apply(createState(), "stop-failure", T0);
    stressed = apply(stressed, "test-pass", T0);
    assert.ok(read(stressed, T0).satisfaction > read(calm, T0).satisfaction);
    assert.ok(read(stressed, T0).stress < 0.35);
  });

  it("permission denied adds stress, allowed does not", () => {
    assert.ok(read(apply(createState(), "permission-denied", T0), T0).stress > 0.05);
    assert.strictEqual(read(apply(createState(), "permission-allowed", T0), T0).stress, 0);
  });

  it("ignores unknown or malformed events without changing state", () => {
    const state = createState();
    assert.strictEqual(applyEvent(state, null, T0), state);
    assert.strictEqual(applyEvent(state, { type: 7 }, T0), state);
    const unknown = applyEvent(state, { type: "nope" }, T0);
    assert.deepStrictEqual(read(unknown, T0), read(state, T0));
  });
});

// Activity every hour from T0 through `hours`, so no gap ever counts as sleep.
function awakeFor(hours) {
  let state = apply(createState(), "session-start", T0);
  for (let h = 1; h <= hours; h++) state = apply(state, "activity", T0 + h * HOUR);
  return state;
}

describe("fatigue", () => {
  it("rises with time awake from the first activity", () => {
    assert.strictEqual(read(awakeFor(3), T0 + 3 * HOUR).fatigue, 0);
    const mid = read(awakeFor(8), T0 + 8 * HOUR).fatigue;
    assert.ok(mid > 0.4 && mid < 0.6, `mid=${mid}`);
    assert.strictEqual(read(awakeFor(12), T0 + 12 * HOUR).fatigue, 1);
  });

  it("re-anchors the wake time after a long gap", () => {
    let state = awakeFor(17);
    assert.ok(read(state, T0 + 17 * HOUR).fatigue > 0.85);
    // Six hours of nothing is sleep: the next activity starts a new day.
    state = apply(state, "activity", T0 + 23 * HOUR);
    assert.strictEqual(read(state, T0 + 23 * HOUR).fatigue, 0);
  });

  it("reads as rested once the pet has been away long enough to count as sleep", () => {
    const active = awakeFor(16);
    assert.ok(read(active, T0 + 16 * HOUR).fatigue > 0.7);
    assert.ok(read(active, T0 + 16 * HOUR + 4 * HOUR).fatigue > 0.7, "a short break is not sleep");
    assert.strictEqual(read(active, T0 + 16 * HOUR + 6 * HOUR).fatigue, 0);
  });

  it("adds context-window pressure that fades", () => {
    const state = applyEvent(createState(), { type: "context", fraction: 0.95 }, T0);
    const high = read(state, T0).fatigue;
    assert.ok(high > 0.4, `high=${high}`);
    assert.ok(read(state, T0 + 3 * HOUR).fatigue < 0.05);
    const low = applyEvent(createState(), { type: "context", fraction: 0.3 }, T0);
    assert.strictEqual(read(low, T0).fatigue, 0);
  });

  it("context readings are not activity", () => {
    const state = applyEvent(createState(), { type: "context", fraction: 0.5 }, T0);
    assert.strictEqual(state.lastActivityAt, null);
    assert.strictEqual(state.wakeAt, null);
  });
});

describe("boredom", () => {
  it("ramps with idle time after activity", () => {
    const state = apply(createState(), "activity", T0);
    assert.strictEqual(read(state, T0 + 4 * MIN).boredom, 0);
    const mid = read(state, T0 + 20 * MIN).boredom;
    assert.ok(mid > 0.4 && mid < 0.6, `mid=${mid}`);
    assert.strictEqual(read(state, T0 + 40 * MIN).boredom, 1);
  });

  it("goes quiet after a long absence and resets on activity", () => {
    const state = apply(createState(), "activity", T0);
    assert.strictEqual(read(state, T0 + 4 * HOUR).boredom, 0);
    const back = apply(state, "activity", T0 + 40 * MIN);
    assert.strictEqual(read(back, T0 + 40 * MIN).boredom, 0);
  });
});

describe("restoreState", () => {
  it("round-trips through JSON", () => {
    let state = apply(createState(), "stop-failure", T0);
    state = applyEvent(state, { type: "context", fraction: 0.8 }, T0);
    const restored = restoreState(JSON.parse(JSON.stringify(state)));
    assert.deepStrictEqual(read(restored, T0 + MIN), read(state, T0 + MIN));
  });

  it("falls back to a fresh state for malformed input", () => {
    for (const bad of [null, undefined, "x", 3, [], { version: 2 }]) {
      assert.deepStrictEqual(restoreState(bad), createState());
    }
    const partial = restoreState({ version: 1, stress: { value: "high" }, wakeAt: "x", lastActivityAt: T0 });
    assert.strictEqual(partial.stress, null);
    assert.strictEqual(partial.wakeAt, null);
    assert.strictEqual(partial.lastActivityAt, T0);
  });

  it("clamps out-of-range stored values", () => {
    const restored = restoreState({ version: 1, stress: { value: 7, updatedAt: T0 } });
    assert.strictEqual(restored.stress.value, 1);
  });
});

describe("chooseMoment", () => {
  const ALL = ["stress", "satisfaction", "fatigue", "boredom"];
  const quiet = { stress: 0, satisfaction: 0, fatigue: 0, boredom: 0 };
  const fresh = () => ({ last: Object.create(null), lastAny: null });
  const choose = (over) => chooseMoment({
    values: quiet, available: ALL, cooldowns: fresh(), now: T0, random: () => 0, ...over,
  });

  it("does nothing below the floor", () => {
    assert.strictEqual(choose({ values: { ...quiet, stress: 0.34 } }), null);
  });

  it("picks the strongest available mood", () => {
    const values = { stress: 0.5, satisfaction: 0.9, fatigue: 0.6, boredom: 0.1 };
    assert.strictEqual(choose({ values }), "satisfaction");
    assert.strictEqual(choose({ values, available: ["stress", "fatigue"] }), "fatigue");
    assert.strictEqual(choose({ values, available: [] }), null);
  });

  it("rolls against a chance that grows with intensity and is capped", () => {
    const { moment } = DEFAULT_CONFIG;
    const at = (stress, roll) => choose({ values: { ...quiet, stress }, random: () => roll });
    assert.strictEqual(at(1, moment.cap - 0.001), "stress");
    assert.strictEqual(at(1, moment.cap + 0.001), null);
    assert.strictEqual(at(moment.floor, 0), null); // chance is 0 right at the floor
    const mid = momentChance(0.7, moment);
    assert.strictEqual(at(0.7, mid - 0.001), "stress");
    assert.strictEqual(at(0.7, mid + 0.001), null);
  });

  it("momentChance: zero below the floor, capped from `full`, and eased in between", () => {
    const { moment } = DEFAULT_CONFIG;
    assert.strictEqual(momentChance(0, moment), 0);
    assert.strictEqual(momentChance(moment.floor - 0.01, moment), 0);
    assert.strictEqual(momentChance(moment.floor, moment), 0);
    assert.strictEqual(momentChance(moment.full, moment), moment.cap);
    assert.strictEqual(momentChance(1, moment), moment.cap);
    assert.strictEqual(moment.cap, 0.75);

    let previous = 0;
    for (let v = 0.36; v <= 0.9; v += 0.02) {
      const chance = momentChance(v, moment);
      assert.ok(chance >= previous, `monotonic at ${v}`);
      previous = chance;
    }
    // Ease-in: a mid-range value is rarer than a straight ramp would make it.
    const linearMid = moment.cap * (0.7 - moment.floor) / (moment.full - moment.floor);
    assert.ok(momentChance(0.7, moment) < linearMid);
    assert.ok(momentChance(0.5, moment) < 0.15);
    assert.ok(momentChance(0.8, moment) > 0.5);
  });

  it("respects the global and per-mood cooldowns", () => {
    const values = { ...quiet, stress: 1, boredom: 0.9 };
    const cooldowns = { last: { stress: T0 - 5 * MIN }, lastAny: null };
    // stress is cooling down, so the next strongest mood plays instead.
    assert.strictEqual(choose({ values, cooldowns }), "boredom");
    const globalCooling = { last: Object.create(null), lastAny: T0 - 5 * MIN };
    assert.strictEqual(choose({ values, cooldowns: globalCooling }), null);
    const expired = { last: { stress: T0 - 31 * MIN }, lastAny: T0 - 11 * MIN };
    assert.strictEqual(choose({ values, cooldowns: expired }), "stress");
  });

  it("treats a bad random value as no moment", () => {
    assert.strictEqual(choose({ values: { ...quiet, stress: 1 }, random: () => NaN }), null);
  });
});

describe("createMoodTracker", () => {
  it("applies events, reports channels and tracks cooldowns", () => {
    let clock = T0;
    const logs = [];
    let changes = 0;
    const tracker = createMoodTracker({
      now: () => clock,
      random: () => 0,
      log: (line) => logs.push(line),
      onChange: () => { changes++; },
    });

    tracker.applyEvent({ type: "stop-failure" });
    assert.ok(tracker.read().stress > 0.3);
    assert.strictEqual(changes, 1);
    assert.match(logs[0], /^mood event=stop-failure stress=0\.35/);

    tracker.applyEvent({ type: "activity" });
    tracker.applyEvent({ type: "context", fraction: 0.5 });
    assert.strictEqual(changes, 3, "quiet events still count as changes for persistence");
    assert.strictEqual(logs.length, 1, "but plain activity and context readings are not logged");

    clock = T0 + MIN;
    tracker.applyEvent({ type: "stop-failure" });
    tracker.applyEvent({ type: "stop-failure" });
    assert.strictEqual(tracker.chooseMoment(["stress"]), "stress");
    tracker.markMomentPlayed("stress");
    assert.strictEqual(tracker.chooseMoment(["stress"]), null);
    clock += 11 * MIN;
    assert.strictEqual(tracker.chooseMoment(["stress"]), null, "per-mood cooldown still active");

    const restored = createMoodTracker({ now: () => clock, initialState: JSON.parse(JSON.stringify(tracker.serialize())) });
    assert.deepStrictEqual(restored.read(), tracker.read());
  });

  it("ignores malformed events without notifying", () => {
    let changes = 0;
    const tracker = createMoodTracker({ onChange: () => { changes++; } });
    tracker.applyEvent({});
    tracker.applyEvent(null);
    assert.strictEqual(changes, 0);
  });
});

describe("moodEventsFromHook", () => {
  const { moodEventsFromHook, createMoodEventHandler } = require("../src/mood");
  const types = (input) => moodEventsFromHook(input).map((event) => event.type);

  it("maps lifecycle events to mood events", () => {
    assert.deepStrictEqual(types({ event: "PostToolUseFailure" }), ["tool-failure"]);
    assert.deepStrictEqual(types({ event: "StopFailure" }), ["stop-failure"]);
    assert.deepStrictEqual(types({ event: "Stop" }), ["stop"]);
    assert.deepStrictEqual(types({ event: "SessionStart" }), ["session-start"]);
    assert.deepStrictEqual(types({ event: "PreToolUse" }), ["activity"]);
    assert.deepStrictEqual(types({}), ["activity"]);
    assert.deepStrictEqual(types(null), ["activity"]);
  });

  it("counts a Stop that carried an API error as a failure, not a clean finish", () => {
    assert.deepStrictEqual(types({ event: "Stop", failureKind: "api_error" }), ["stop-failure"]);
    assert.deepStrictEqual(types({ event: "Stop", failureKind: "other" }), ["stop"]);
  });

  it("lets a test result win over the tool event it rode on", () => {
    assert.deepStrictEqual(types({ event: "PostToolUseFailure", testResult: "fail" }), ["test-fail"]);
    assert.deepStrictEqual(types({ event: "PostToolUse", testResult: "pass" }), ["test-pass"]);
  });

  it("adds a context reading alongside the lifecycle event", () => {
    assert.deepStrictEqual(moodEventsFromHook({ event: "PreToolUse", contextPercent: 80 }), [
      { type: "context", fraction: 0.8 },
      { type: "activity" },
    ]);
    assert.deepStrictEqual(types({ event: "PreToolUse", contextPercent: undefined }), ["activity"]);
  });

  it("maps bubble decisions", () => {
    assert.deepStrictEqual(types({ permissionDecision: "deny" }), ["permission-denied"]);
    assert.deepStrictEqual(types({ permissionDecision: "allow" }), ["permission-allowed"]);
  });

  it("the handler applies events only when enabled and not headless", () => {
    const applied = [];
    const tracker = { applyEvent: (event) => applied.push(event.type) };
    let enabled = false;
    const handle = createMoodEventHandler({ tracker, getEnabled: () => enabled });

    assert.strictEqual(handle({ event: "Stop" }), false);
    enabled = true;
    assert.strictEqual(handle({ event: "Stop" }, { headless: true }), false);
    assert.deepStrictEqual(applied, []);
    assert.strictEqual(handle({ event: "Stop" }, { headless: false }), true);
    assert.deepStrictEqual(applied, ["stop"]);
  });
});
