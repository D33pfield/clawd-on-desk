"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const {
  resolvePresenceState,
  presenceImageUrl,
  buildPresencePayload,
  pickDominantSession,
  encodeFrame,
  decodeFrames,
  createDiscordPresenceBridge,
  OP,
} = require("../src/discord-presence-rpc");

// Stand-in for a Discord IPC pipe socket: captures writes, driven by emit().
class FakeIpcSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
  }
  write(buf) { this.writes.push(buf); return true; }
  destroy() { this.destroyed = true; }
}

function firstFrame(socket) {
  return decodeFrames(socket.writes[0]).frames[0];
}

const READY_FRAME = encodeFrame(OP.FRAME, { cmd: "DISPATCH", evt: "READY" });

test("resolvePresenceState maps active states and recovers done/error from the badge", () => {
  assert.strictEqual(resolvePresenceState({ state: "thinking" }), "thinking");
  assert.strictEqual(resolvePresenceState({ state: "working" }), "working");
  assert.strictEqual(resolvePresenceState({ state: "juggling" }), "juggling");
  assert.strictEqual(resolvePresenceState({ state: "mini-working" }), "working"); // mini-* shares its base
  // one-shot states (error/attention/notification/...) collapse to idle in the
  // snapshot; the badge is how we recover them
  assert.strictEqual(resolvePresenceState({ state: "idle", badge: "interrupted" }), "error");
  assert.strictEqual(resolvePresenceState({ state: "idle", badge: "done" }), "attention");
  assert.strictEqual(resolvePresenceState({ state: "idle", requiresCompletionAck: true }), "attention");
  assert.strictEqual(resolvePresenceState({ state: "working", requiresCompletionAck: true }), "working"); // busy now wins
  assert.strictEqual(resolvePresenceState({ state: "idle" }), "idle");
  assert.strictEqual(resolvePresenceState(null), "idle");
});

test("buildPresencePayload exposes ONLY agent + coarse state + sprite by default", () => {
  const session = {
    agentId: "claude-code",
    state: "working",
    cwd: "D:\\Repos\\Apps\\secret-project",
    sessionTitle: "fix the thing",
  };
  const out = buildPresencePayload(session, { privacyShowProject: false });
  const blob = JSON.stringify(out);
  assert.strictEqual(blob.includes("secret-project"), false); // cwd / project never leaks by default
  assert.strictEqual(blob.includes("fix the thing"), false);  // session title never leaks
  assert.match(out.state, /working/i);            // coarse state present
  assert.ok(out.details);                         // agent label present
  assert.ok(out.assets && out.assets.large_image); // sprite present
});

test("large_image + label follow the resolved presence state", () => {
  const img = (s) => buildPresencePayload(s, {}).assets.large_image;
  const label = (s) => buildPresencePayload(s, {}).state;
  assert.match(img({ state: "thinking" }), /clawd-thinking\.gif$/);
  assert.match(img({ state: "working" }), /clawd-typing\.gif$/);
  assert.match(img({ state: "juggling" }), /clawd-juggling\.gif$/);
  assert.match(img({ state: "idle", badge: "interrupted" }), /clawd-error\.gif$/);
  assert.match(img({ state: "idle", requiresCompletionAck: true }), /clawd-happy\.gif$/);
  assert.match(img({ state: "idle" }), /clawd-idle\.gif$/);
  assert.strictEqual(label({ state: "idle", requiresCompletionAck: true }), "Waiting for input");
  assert.strictEqual(label({ state: "idle", badge: "interrupted" }), "Error");
  assert.match(presenceImageUrl("totally-unknown"), /clawd-idle\.gif$/); // unknown falls back to idle
});

test("buildPresencePayload keeps custom executable names out of public presence", () => {
  const out = buildPresencePayload({
    agentId: "custom-nova-0123456789ab",
    agentName: "Nova AI",
    state: "working",
  });

  assert.strictEqual(out.details, "Custom agent");
});

test("buildPresencePayload adds the project name ONLY when privacyShowProject is on", () => {
  const session = { agentId: "claude-code", state: "working", cwd: "D:\\Repos\\Apps\\demo" };
  const off = buildPresencePayload(session, { privacyShowProject: false });
  assert.strictEqual(JSON.stringify(off).includes("demo"), false);
  const on = buildPresencePayload(session, { privacyShowProject: true });
  assert.strictEqual(JSON.stringify(on).includes("demo"), true);
});

test("buildPresencePayload publishes ONLY the folder name, never a full path, on any OS", () => {
  // POSIX path.basename can't split a Windows cwd, leaking the whole path; the
  // payload must surface just the folder name regardless of host platform.
  const session = { agentId: "claude-code", state: "working", cwd: "C:\\Users\\alice\\Projects\\secret" };
  const out = buildPresencePayload(session, { privacyShowProject: true });
  assert.match(out.state, /secret/);
  assert.strictEqual(out.state.includes("alice"), false);
  assert.strictEqual(out.state.includes("Projects"), false);
  assert.strictEqual(out.state.includes("C:"), false);
  assert.strictEqual(out.state.includes("\\"), false);
  assert.strictEqual(out.state.includes("/"), false);
});

test("buildPresencePayload truncates state to Discord's 128-char activity limit", () => {
  // Discord rejects the whole SET_ACTIVITY frame when state exceeds 128 chars,
  // so an extra-long folder name must not silently kill presence updates.
  const session = { agentId: "claude-code", state: "working", cwd: `D:\\repos\\${"x".repeat(300)}` };
  const out = buildPresencePayload(session, { privacyShowProject: true });
  assert.ok(Array.from(out.state).length <= 128, `state too long: ${out.state.length}`);
  assert.match(out.state, /^Working · x/); // prefix intact, tail truncated
});

test("pickDominantSession skips headless, sleeping, and hiddenFromHud sessions (HUD-aligned)", () => {
  const snapshot = { sessions: [
    { id: "a", agentId: "codex", state: "working", hiddenFromHud: true },  // superseded -> skip despite high priority
    { id: "b", agentId: "claude-code", state: "sleeping" },                // ended -> skip
    { id: "c", agentId: "claude-code", state: "error", headless: true },   // headless -> skip
    { id: "d", agentId: "claude-code", state: "thinking" },                // visible -> picked
  ] };
  const picked = pickDominantSession(snapshot);
  assert.strictEqual(picked && picked.id, "d");

  const allHidden = { sessions: [
    { id: "x", state: "working", hiddenFromHud: true },
    { id: "y", state: "sleeping" },
    { id: "z", state: "error", headless: true },
  ] };
  assert.strictEqual(pickDominantSession(allHidden), null);
});

test("bridge reconnects with the new client_id when the App ID changes while connected", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111", privacyShowProject: false };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });

  bridge.start();
  assert.strictEqual(sockets.length, 1);
  sockets[0].emit("connect");                       // pipe up -> HANDSHAKE sent
  const hs1 = firstFrame(sockets[0]);
  assert.strictEqual(hs1.op, OP.HANDSHAKE);
  assert.strictEqual(hs1.data.client_id, "111111111111111111");
  sockets[0].emit("data", READY_FRAME);             // READY -> connected

  cfg.applicationId = "222222222222222222";
  bridge.start();                                   // App ID changed while live
  assert.strictEqual(sockets.length, 2);            // forced a fresh dial
  assert.strictEqual(sockets[0].destroyed, true);   // old socket torn down, not leaked
  sockets[1].emit("connect");
  assert.strictEqual(firstFrame(sockets[1]).data.client_id, "222222222222222222");

  bridge.stop();
});

test("bridge does NOT reconnect when start() runs with an unchanged App ID", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });

  bridge.start();
  sockets[0].emit("connect");
  sockets[0].emit("data", READY_FRAME);
  bridge.start();                                   // same config -> no-op
  assert.strictEqual(sockets.length, 1);

  bridge.stop();
});

test("bridge supersedes an in-flight dial when the App ID changes mid-connect (no orphan)", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });

  bridge.start();                       // dial #1 in flight, not yet connected
  assert.strictEqual(sockets.length, 1);

  cfg.applicationId = "222222222222222222";
  bridge.start();                       // App ID changed mid-dial -> supersede
  assert.strictEqual(sockets.length, 2);
  assert.strictEqual(sockets[0].destroyed, true);  // in-flight dial torn down

  // The superseded socket connecting late must NOT adopt or send a handshake.
  sockets[0].emit("connect");
  assert.strictEqual(sockets[0].writes.length, 0);

  sockets[1].emit("connect");
  assert.strictEqual(firstFrame(sockets[1]).data.client_id, "222222222222222222");

  bridge.stop();
});

test("bridge recovers when the dial throws synchronously (e.g. fd exhaustion)", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  let dials = 0;
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { dials += 1; throw new Error("EMFILE"); },
  });

  // Must not throw, and must not wedge `connecting=true` — a later start() can re-dial.
  assert.doesNotThrow(() => bridge.start());
  assert.strictEqual(dials, 1);

  bridge.stop();
});

test("encodeFrame/decodeFrames round-trips opcode + JSON across split chunks", () => {
  const payload = { v: 1, client_id: "123456789012345678" };
  const frame = encodeFrame(OP.HANDSHAKE, payload);
  // header is 8 bytes: int32-LE opcode + int32-LE length
  assert.strictEqual(frame.readInt32LE(0), OP.HANDSHAKE);
  assert.strictEqual(frame.readInt32LE(4), Buffer.byteLength(JSON.stringify(payload)));
  // feed it in two pieces to prove the accumulator reassembles split pipe reads
  const dec = decodeFrames(Buffer.concat([frame.subarray(0, 3), frame.subarray(3)]));
  assert.strictEqual(dec.frames.length, 1);
  assert.strictEqual(dec.frames[0].op, OP.HANDSHAKE);
  assert.deepStrictEqual(dec.frames[0].data, payload);
  assert.strictEqual(dec.rest.length, 0);
});

test("before-quit stops the Discord presence bridge before tearing down session state", () => {
  // Source-text guard: a refactor that
  // drops this cleanup would otherwise silently strand presence on quit again.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const start = source.indexOf('app.on("before-quit"');
  const end = source.indexOf('app.on("window-all-closed"', start);
  const block = source.slice(start, end);
  const bridgeStop = block.indexOf("discordPresenceBridge.stop()");
  const stateCleanup = block.indexOf("_state.cleanup()");
  assert.ok(bridgeStop !== -1, "before-quit should stop the Discord presence bridge");
  assert.ok(stateCleanup !== -1, "before-quit should clean up session state");
  // The bridge consumes the session-snapshot subscription, so stop it before _state.
  assert.ok(bridgeStop < stateCleanup, "presence bridge must stop before _state.cleanup()");
});

test("stop() resets the reconnect backoff so a later start() dials at the base delay", () => {
  // reconnectAttempts is a closure private; the only observable is the delay
  // scheduleReconnect() hands setTimeout, so capture it instead of firing it.
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  const sockets = [];
  const realSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return { unref() {} };
  };
  try {
    const bridge = createDiscordPresenceBridge({
      getConfig: () => cfg,
      ipcPaths: () => ["fake-pipe"], // single candidate -> one error exhausts the list -> backoff
      createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
    });
    // Pre-connect error exhausts the candidate list and schedules a backoff dial.
    const dialAndFail = () => sockets[sockets.length - 1].emit("error");

    bridge.start();
    dialAndFail();
    assert.strictEqual(scheduled.at(-1).delay, 2000, "attempt 1 -> 2s");

    scheduled.at(-1).fn();   // fire reconnect -> re-dial
    dialAndFail();
    assert.strictEqual(scheduled.at(-1).delay, 4000, "attempt 2 -> 4s");

    scheduled.at(-1).fn();
    dialAndFail();
    assert.strictEqual(scheduled.at(-1).delay, 8000, "attempt 3 -> 8s");

    bridge.stop();           // must reset reconnectAttempts to 0
    const before = scheduled.length;
    bridge.start();
    dialAndFail();
    assert.ok(scheduled.length > before, "restart should schedule a fresh reconnect");
    assert.strictEqual(scheduled.at(-1).delay, 2000, "stop() must reset backoff to the base delay (not 16s)");

    bridge.stop();
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

// ── Visual mirroring: presence follows the pet's on-screen animation ──

test("buildPresencePayload mirrors a known on-screen visual (image + label)", () => {
  const img = (visual, session = null) => buildPresencePayload(session, {}, visual).assets.large_image;
  const label = (visual, session = null) => buildPresencePayload(session, {}, visual).state;
  // idle variants keep state "idle" but swap the svg (tick.js idle rotation)
  assert.match(img({ state: "idle", svg: "clawd-idle-bubble.svg" }), /clawd-bubble\.gif$/);
  assert.match(img({ state: "idle", svg: "clawd-idle-reading.svg" }), /clawd-idle-reading\.gif$/);
  assert.strictEqual(label({ state: "idle", svg: "clawd-idle-bubble.svg" }), "Idle");
  // session-count working tiers
  assert.match(img({ state: "working", svg: "clawd-working-building.svg" }), /clawd-building\.gif$/);
  assert.strictEqual(label({ state: "working", svg: "clawd-working-building.svg" }), "Working");
  // sleep chain: dozing shows the sleeping sprite and reads as Sleeping
  assert.match(img({ state: "dozing", svg: "clawd-idle-doze.svg" }), /clawd-sleeping\.gif$/);
  assert.strictEqual(label({ state: "dozing", svg: "clawd-idle-doze.svg" }), "Sleeping");
  // one-shots
  assert.match(img({ state: "notification", svg: "clawd-notification.svg" }), /clawd-notification\.gif$/);
  assert.strictEqual(label({ state: "notification", svg: "clawd-notification.svg" }), "Waiting for input");
  // svgs with no gif of their own fall back to the nearest sprite
  assert.match(img({ state: "dizzy", svg: "clawd-dizzy.svg" }), /clawd-idle\.gif$/);
  assert.match(img({ state: "waking", svg: "clawd-wake.svg" }), /clawd-idle\.gif$/);
  // mini mode
  assert.match(img({ state: "mini-working", svg: "clawd-mini-typing.svg" }), /clawd-typing\.gif$/);
  assert.strictEqual(label({ state: "mini-working", svg: "clawd-mini-typing.svg" }), "Working");
  assert.match(img({ state: "roam", svg: "clawd-mini-crabwalk.svg" }), /clawd-mini-crabwalk\.gif$/);
  assert.strictEqual(label({ state: "roam", svg: "clawd-mini-crabwalk.svg" }), "Idle");
});

test("an unknown visual svg (other themes) falls back to the session-derived sprite", () => {
  const session = { agentId: "claude-code", state: "working" };
  const out = buildPresencePayload(session, {}, { state: "working", svg: "calico-typing.svg" });
  assert.match(out.assets.large_image, /clawd-typing\.gif$/); // no dead links for non-clawd themes
  assert.strictEqual(out.state, "Working");
});

test("a mirrored visual renders even with no active session", () => {
  const out = buildPresencePayload(null, {}, { state: "idle", svg: "clawd-idle-bubble.svg" });
  assert.match(out.assets.large_image, /clawd-bubble\.gif$/);
  assert.strictEqual(out.state, "Idle");
  assert.ok(out.details); // generic agent label still present
});

test("project-name opt-in composes with the mirrored label", () => {
  const session = { agentId: "claude-code", state: "idle", cwd: "D:\\Repos\\Apps\\demo" };
  const out = buildPresencePayload(session, { privacyShowProject: true }, { state: "idle", svg: "clawd-idle-reading.svg" });
  assert.strictEqual(out.state, "Idle · demo");
  assert.match(out.assets.large_image, /clawd-idle-reading\.gif$/);
});

test("onVisual publishes the mirrored sprite over the live IPC socket", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });
  bridge.start();
  sockets[0].emit("connect");
  sockets[0].emit("data", READY_FRAME);

  bridge.onVisual("idle", "clawd-idle-bubble.svg");
  const activities = sockets[0].writes
    .map((b) => decodeFrames(b).frames[0])
    .filter((f) => f.op === OP.FRAME && f.data.cmd === "SET_ACTIVITY");
  assert.ok(activities.length >= 1, "onVisual should publish an activity");
  const last = activities.at(-1).data.args.activity;
  assert.match(last.assets.large_image, /clawd-bubble\.gif$/);
  assert.strictEqual(last.state, "Idle");

  bridge.stop();
});
