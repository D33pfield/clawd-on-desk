"use strict";

// Main-process owner for the Dashboard keyboard mode.
//
// The rules pinned here are the ones the native probe proved matter: a visible
// ordinary host is parked (never hidden) and restored to its captured opacity
// on every exit path, the quick host borrows the restorable rectangle rather
// than a fullscreen one, and a round's identity gates every renderer call.

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createDashboardQuickMode,
  isSupportedQuickPlatform,
  orderedCandidates,
} = require("../src/dashboard-quick-mode");

class FakeWindow {
  constructor(name) {
    this.name = name;
    this.destroyed = false;
    this.visible = false;
    this.focused = false;
    this.opacity = 1;
    this.opacityCalls = [];
    this.ignoreMouseCalls = [];
    this.boundsCalls = [];
    this.shownCount = 0;
    this.hiddenCount = 0;
    this.destroyCount = 0;
    this.handlers = new Map();
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  show() { this.visible = true; this.shownCount += 1; }
  hide() { this.visible = false; this.hiddenCount += 1; }
  focus() { this.focused = true; }
  destroy() { this.destroyed = true; this.destroyCount += 1; }
  getOpacity() { return this.opacity; }
  setOpacity(value) { this.opacity = value; this.opacityCalls.push(value); }
  setIgnoreMouseEvents(value) { this.ignoreMouseCalls.push(value); }
  setBounds(bounds) { this.boundsCalls.push({ ...bounds }); }
  setMenuBarVisibility() {}
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, ...args) {
    const handler = this.handlers.get(event);
    if (handler) handler(...args);
  }
}

function harness(options = {}) {
  const normal = new FakeWindow("normal");
  normal.visible = options.normalVisible !== false;
  normal.focused = options.normalFocused === true;
  if (Number.isFinite(options.normalOpacity)) normal.opacity = options.normalOpacity;

  const created = [];
  const sent = [];
  const focusCalls = [];
  const attachments = [];
  let ensurePageCalls = 0;

  const webContents = {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };

  const quick = createDashboardQuickMode({
    platform: options.platform || "darwin",
    electron: {
      BaseWindow: class {
        constructor(opts) {
          const win = new FakeWindow("quick");
          win.opts = opts;
          if (options.quickShowThrows) {
            win.show = () => { throw new Error("native show failed"); };
          }
          created.push(win);
          return win;
        }
      },
    },
    t: (key) => key,
    originFocus: options.originFocus || { capture: () => "origin", restore: () => true },
    getBackgroundColor: () => "#000000",
    getSessionSnapshot: () => options.snapshot || { sessions: [], groups: [] },
    focusSession: options.focusSession || (() => ({ reason: "submitted" })),
    getNormalWindow: () => (options.noNormal ? null : normal),
    getWebContents: () => webContents,
    ensurePage: () => { ensurePageCalls += 1; return options.noPage ? null : {}; },
    getQuickHostBounds: options.getQuickHostBounds
      || (() => ({ x: 10, y: 20, width: 480, height: 600 })),
    attachViewTo: (win) => {
      const name = win === normal ? "normal" : "quick";
      attachments.push(name);
      // Re-entrancy: the real re-parent emits native focus/blur while it runs.
      if (options.onAttach) options.onAttach(name, quick);
      // A failing attach only fails the borrow, never the return trip.
      return options.attachFails && name === "quick" ? false : true;
    },
    syncViewBounds: () => {},
    focusPage: () => focusCalls.push("page"),
  });

  return {
    quick,
    normal,
    sent,
    attachments,
    focusCalls,
    quickWindow: () => created[0] || null,
    ensurePageCalls: () => ensurePageCalls,
  };
}

const focusable = (id) => ({ id, canFocus: true, displayTitle: `T ${id}`, agentName: "Codex", badge: "idle" });
const snapshotOf = (...ids) => ({
  sessions: ids.map(focusable),
  groups: [{ host: "local", ids }],
});

test("platform support is limited to darwin and win32", () => {
  assert.equal(isSupportedQuickPlatform("darwin"), true);
  assert.equal(isSupportedQuickPlatform("win32"), true);
  assert.equal(isSupportedQuickPlatform("linux"), false);
  assert.equal(isSupportedQuickPlatform("freebsd"), false);
});

test("linux never offers the mode, creates a host or parks anything", () => {
  const h = harness({ platform: "linux", snapshot: snapshotOf("s1") });

  assert.deepEqual(h.quick.show(), { status: "unsupported" });
  assert.equal(h.quickWindow(), null);
  assert.deepEqual(h.sent, [], "no intent is broadcast to the page");
  assert.equal(h.normal.opacityCalls.length, 0);
  assert.equal(h.normal.ignoreMouseCalls.length, 0);
  assert.deepEqual(h.quick.enter({ revision: 1, busy: false }), { status: "unsupported" });
});

test("candidate freezing takes the first nine focusable ids in snapshot order", () => {
  const snapshot = {
    sessions: [
      ...Array.from({ length: 10 }, (_, i) => focusable(`s${i + 1}`)),
      { id: "blocked", canFocus: false },
    ],
    groups: [{ host: "local", ids: ["s3", "blocked", "s1"] }],
  };
  const ids = orderedCandidates(snapshot).map((entry) => entry.id);
  assert.equal(ids.length, 9);
  assert.deepEqual(ids.slice(0, 3), ["s3", "s1", "s2"]);
  assert.equal(ids.includes("blocked"), false);
});

test("a busy renderer refuses the round and touches no native state", () => {
  const h = harness({ snapshot: snapshotOf("s1", "s2") });
  const started = h.quick.show();

  const result = h.quick.enter({ revision: started.revision, busy: true });

  assert.equal(result.status, "busy");
  assert.equal(h.quick.isActive(), false);
  assert.deepEqual(h.attachments, [], "no host transfer");
  assert.equal(h.normal.opacityCalls.length, 0, "no parking");
  assert.equal(h.normal.ignoreMouseCalls.length, 0);
  // The refused round cannot be resumed later without a fresh shortcut press.
  assert.deepEqual(h.quick.ready({ revision: started.revision }), { status: "stale" });
});

test("an empty candidate set opens a real round that captures no digits", () => {
  const h = harness({ snapshot: { sessions: [], groups: [] } });
  const started = h.quick.show();

  const entered = h.quick.enter({ revision: started.revision, busy: false });
  assert.equal(entered.status, "empty");
  assert.equal(entered.numericCapture, false);
  // The round exists, so the shortcut still opens the Dashboard instead of
  // looking broken...
  assert.equal(h.quick.isActive(), true);
  assert.equal(h.quick.capturesDigits(), false);

  assert.equal(h.quick.ready({ revision: started.revision }).status, "ok");
  assert.equal(h.quick.isShown(), true, "the Dashboard is actually shown");
  h.quickWindow().focused = true;

  // ...but nothing can be activated in it.
  assert.equal(
    h.quick.activate({ sessionId: "s1", revision: started.revision }).reason,
    "no-candidates"
  );

  // And it is bounded by the same lifecycle.
  h.quick.dismissFromRenderer({ revision: started.revision });
  assert.equal(h.quick.isActive(), false);
});

test("a visible background host is parked, borrowed and restored to its captured opacity", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 0.9 });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });

  h.quick.ready({ revision: started.revision });

  assert.deepEqual(h.normal.ignoreMouseCalls, [true]);
  assert.deepEqual(h.normal.opacityCalls, [0], "parked, never hidden");
  assert.equal(h.normal.hiddenCount, 0, "hide() would raise it above the source on return");
  assert.deepEqual(h.attachments, ["quick"]);
  assert.equal(h.quickWindow().shownCount, 1);
  assert.deepEqual(h.quickWindow().boundsCalls, [{ x: 10, y: 20, width: 480, height: 600 }]);

  h.quick.dismissFromRenderer({ revision: started.revision });

  assert.deepEqual(h.attachments, ["quick", "normal"]);
  assert.deepEqual(h.normal.opacityCalls, [0, 0.9], "restores the captured value, not 1");
  assert.deepEqual(h.normal.ignoreMouseCalls, [true, false]);
  assert.equal(h.quickWindow().hiddenCount, 1);
  assert.equal(h.normal.shownCount, 0, "the ordinary host is never shown or raised");
});

test("restoring is idempotent across repeated exits", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 0.8 });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });

  h.quick.dismissFromRenderer({ revision: started.revision });
  h.quick.handlePageGone();
  h.quick.endForOrdinaryOpen();

  assert.deepEqual(h.normal.opacityCalls, [0, 0.8], "no second restore write");
  assert.deepEqual(h.normal.ignoreMouseCalls, [true, false]);
});

test("a hidden ordinary host is borrowed without parking and is never revealed", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalVisible: false });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });

  assert.equal(h.normal.opacityCalls.length, 0);
  assert.equal(h.normal.ignoreMouseCalls.length, 0);
  assert.deepEqual(h.attachments, ["quick"]);

  h.quick.dismissFromRenderer({ revision: started.revision });
  assert.equal(h.normal.shownCount, 0);
  assert.equal(h.normal.visible, false);
});

test("an already focused ordinary host arms the digits in place", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalFocused: true });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });

  const result = h.quick.ready({ revision: started.revision });

  assert.equal(result.inPlace, true);
  assert.equal(h.quick.isShown(), false);
  assert.deepEqual(h.attachments, [], "no borrow");
  assert.equal(h.normal.opacityCalls.length, 0, "no parking");
  assert.equal(h.quick.getActiveHost(), h.normal);
});

test("a failed transfer un-parks instead of leaving an invisible host", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 1, attachFails: true });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });

  const result = h.quick.ready({ revision: started.revision });

  assert.equal(result.status, "error");
  assert.deepEqual(h.normal.opacityCalls, [0, 1]);
  assert.deepEqual(h.normal.ignoreMouseCalls, [true, false]);
  assert.equal(h.quick.isShown(), false);
});

test("activate demands the exact payload shape", () => {
  const h = harness({ snapshot: snapshotOf("s1") });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });
  h.quickWindow().focused = true;

  for (const payload of [
    null,
    { sessionId: "s1" },
    { revision: started.revision },
    { sessionId: "s1", revision: "1" },
    { sessionId: "", revision: started.revision },
    { sessionId: "s1", revision: started.revision, extra: true },
  ]) {
    assert.equal(h.quick.activate(payload).reason, "invalid-payload", JSON.stringify(payload));
  }
});

test("a stale revision can neither activate nor cancel the live round", () => {
  const h = harness({ snapshot: snapshotOf("s1") });
  const first = h.quick.show();
  h.quick.enter({ revision: first.revision, busy: false });
  h.quick.ready({ revision: first.revision });
  h.quickWindow().focused = true;

  const second = h.quick.show();
  assert.notEqual(second.revision, first.revision);
  h.quick.enter({ revision: second.revision, busy: false });
  h.quick.ready({ revision: second.revision });
  h.quickWindow().focused = true;

  assert.equal(
    h.quick.activate({ sessionId: "s1", revision: first.revision }).reason,
    "stale-revision"
  );
  assert.deepEqual(h.quick.dismissFromRenderer({ revision: first.revision }), { status: "stale" });
  assert.equal(h.quick.isActive(), true, "the live round survived the stale cancel");
});

test("a background host cannot submit a jump", () => {
  const h = harness({ snapshot: snapshotOf("s1") });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });
  h.quickWindow().focused = false;

  assert.equal(
    h.quick.activate({ sessionId: "s1", revision: started.revision }).reason,
    "host-not-focused"
  );
});

test("submitted is handed off once and never hides the quick host early", () => {
  const calls = [];
  const h = harness({
    snapshot: snapshotOf("s1"),
    focusSession: (id, opts) => { calls.push([id, opts.requestSource]); return true; },
  });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });
  h.quickWindow().focused = true;

  assert.deepEqual(h.quick.activate({ sessionId: "s1", revision: started.revision }), {
    status: "submitted",
  });
  assert.deepEqual(calls, [["s1", "dashboard-quick"]]);
  assert.equal(h.quickWindow().hiddenCount, 0, "the handoff completes on native blur");
  assert.equal(h.quick.isShown(), true);

  assert.equal(
    h.quick.activate({ sessionId: "s1", revision: started.revision }).reason,
    "dropped-duplicate"
  );
  assert.deepEqual(calls.length, 1);
});

test("a session that left the snapshot keeps its digit but cannot be activated", () => {
  let snapshot = snapshotOf("s1", "s2");
  const h = harness({ snapshot: { get sessions() { return snapshot.sessions; }, get groups() { return snapshot.groups; } } });
  const started = h.quick.show();
  const entered = h.quick.enter({ revision: started.revision, busy: false });
  assert.deepEqual(entered.entries.map((e) => e.id), ["s1", "s2"]);
  h.quick.ready({ revision: started.revision });
  h.quickWindow().focused = true;

  // s1 disappears; a new session appears and must not inherit digit 1.
  snapshot = snapshotOf("s2", "s9");
  h.quick.broadcastSessionSnapshot(snapshot);

  const update = h.sent.filter((m) => m.channel === "dashboard:quick-entries").pop();
  assert.deepEqual(update.payload.entries.map((e) => e.id), ["s1", "s2"]);
  assert.equal(update.payload.entries[0].canFocus, false, "tombstone");
  assert.equal(
    h.quick.activate({ sessionId: "s1", revision: started.revision }).reason,
    "focus-unavailable"
  );
  assert.equal(
    h.quick.activate({ sessionId: "s9", revision: started.revision }).reason,
    "focus-unavailable",
    "a new session is not part of the frozen map"
  );
});

test("an ordinary open ends the round and restores the host first", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 1 });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });

  assert.equal(h.quick.endForOrdinaryOpen(), true);

  assert.deepEqual(h.attachments, ["quick", "normal"]);
  assert.deepEqual(h.normal.opacityCalls, [0, 1]);
  assert.equal(h.quick.isActive(), false);
  assert.equal(h.quick.endForOrdinaryOpen(), false, "nothing left to end");
});

test("dismissed carries the revision of the round that ended", () => {
  const h = harness({ snapshot: snapshotOf("s1") });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });

  h.quick.dismissFromRenderer({ revision: started.revision });

  const dismissed = h.sent.filter((m) => m.channel === "dashboard:quick-dismissed").pop();
  assert.deepEqual(dismissed.payload, { revision: started.revision });
});

test("native blur ends the round but a transfer-induced blur does not", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 1 });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });

  h.quickWindow().emit("blur");

  assert.equal(h.quick.isActive(), false);
  assert.deepEqual(h.normal.opacityCalls, [0, 1]);
});

test("a lost page un-parks the ordinary host", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 0.7 });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });

  h.quick.handlePageGone();

  assert.deepEqual(h.normal.opacityCalls, [0, 0.7]);
  assert.deepEqual(h.normal.ignoreMouseCalls, [true, false]);
  assert.equal(h.quick.isActive(), false);
});

test("dispose restores the host and destroys the quick window", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 1 });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });

  const quickWindow = h.quickWindow();
  h.quick.dispose();

  assert.deepEqual(h.normal.opacityCalls, [0, 1]);
  assert.equal(quickWindow.destroyCount, 1);
});

test("the borrowed foreground is returned on cancel but not after a jump", () => {
  const restores = [];
  const originFocus = {
    capture: () => "origin-hwnd",
    restore: (origin) => { restores.push(origin); return true; },
  };

  const cancel = harness({ snapshot: snapshotOf("s1"), platform: "win32", originFocus });
  let started = cancel.quick.show();
  cancel.quick.enter({ revision: started.revision, busy: false });
  cancel.quick.ready({ revision: started.revision });
  cancel.quick.dismissFromRenderer({ revision: started.revision });
  assert.deepEqual(restores, ["origin-hwnd"], "explicit cancel returns the source");

  restores.length = 0;
  const jumped = harness({ snapshot: snapshotOf("s1"), platform: "win32", originFocus });
  started = jumped.quick.show();
  jumped.quick.enter({ revision: started.revision, busy: false });
  jumped.quick.ready({ revision: started.revision });
  jumped.quickWindow().focused = true;
  jumped.quick.activate({ sessionId: "s1", revision: started.revision });
  jumped.quick.dismissFromRenderer({ revision: started.revision });
  assert.deepEqual(restores, [], "a real handoff owns the foreground");
});

test("a second press supersedes the first offer", () => {
  const h = harness({ snapshot: snapshotOf("s1") });
  const first = h.quick.show();
  const second = h.quick.show();

  assert.equal(second.revision, first.revision + 1);
  assert.equal(h.quick.enter({ revision: first.revision, busy: false }).status, "stale");
  assert.equal(h.quick.enter({ revision: second.revision, busy: false }).status, "ok");
});

test("an accepted round cannot activate before it is ready", () => {
  const h = harness({ snapshot: snapshotOf("s1") });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  // enter() alone leaves the page wherever it was; no host is armed yet.
  assert.equal(h.quick.isReady(), false);

  assert.equal(
    h.quick.activate({ sessionId: "s1", revision: started.revision }).reason,
    "round-not-ready"
  );

  h.quick.ready({ revision: started.revision });
  h.quickWindow().focused = true;
  assert.equal(h.quick.isReady(), true);
  assert.equal(h.quick.activate({ sessionId: "s1", revision: started.revision }).status, "submitted");
});

test("an in-place round must also be ready before it can activate", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalFocused: true });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });

  assert.equal(
    h.quick.activate({ sessionId: "s1", revision: started.revision }).reason,
    "round-not-ready"
  );

  h.quick.ready({ revision: started.revision });
  assert.equal(h.quick.activate({ sessionId: "s1", revision: started.revision }).status, "submitted");
});

test("editing that starts before ready abandons the round without transferring", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 1 });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });

  // The user focused an alias input while the page was painting digits.
  const result = h.quick.ready({ revision: started.revision, busy: true });

  assert.equal(result.status, "busy");
  assert.deepEqual(h.attachments, [], "nothing was transferred");
  assert.equal(h.normal.opacityCalls.length, 0, "nothing was parked");
  assert.equal(h.quick.isActive(), false, "the round is gone, not merely paused");
  assert.deepEqual(h.quick.ready({ revision: started.revision }), { status: "stale" });
});

test("an ordinary open between enter and ready makes the ready reply stale", () => {
  const h = harness({ snapshot: snapshotOf("s1") });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });

  h.quick.endForOrdinaryOpen();

  assert.deepEqual(h.quick.ready({ revision: started.revision }), { status: "stale" });
  assert.deepEqual(h.attachments, [], "the abandoned round never borrowed");
  assert.equal(h.quick.isActive(), false);
});

test("the ordinary host taking real focus returns the borrowed page", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 1 });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });
  assert.equal(h.quick.isShown(), true);

  // The user activated the (parked, empty) ordinary window from the Dock.
  const handled = h.quick.handleNormalHostFocus();

  assert.equal(handled, true);
  assert.deepEqual(h.attachments, ["quick", "normal"], "the page came back first");
  assert.deepEqual(h.normal.opacityCalls, [0, 1]);
  assert.equal(h.quick.isActive(), false);
});

test("a transfer-induced focus change is not read as the user switching", () => {
  const attachSeen = [];
  const h = harness({
    snapshot: snapshotOf("s1"),
    normalOpacity: 1,
    onAttach: (name, quick) => {
      // Simulate the native focus/blur that the re-parent itself emits.
      attachSeen.push(name);
      quick.handleNormalHostFocus();
      quick.handleNormalHostBlur();
    },
  });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });
  h.quick.ready({ revision: started.revision });

  assert.ok(attachSeen.includes("quick"));
  assert.equal(h.quick.isShown(), true, "the borrow survived its own focus events");
  assert.equal(h.quick.isActive(), true);
});

test("the ordinary host blurring ends an in-place round only", () => {
  const inPlace = harness({ snapshot: snapshotOf("s1"), normalFocused: true });
  let started = inPlace.quick.show();
  inPlace.quick.enter({ revision: started.revision, busy: false });
  inPlace.quick.ready({ revision: started.revision });

  assert.equal(inPlace.quick.handleNormalHostBlur(), true);
  assert.equal(inPlace.quick.isActive(), false);

  // A borrowed round lives on the quick host; the parked window blurring is
  // expected and must not end it.
  const borrowed = harness({ snapshot: snapshotOf("s1") });
  started = borrowed.quick.show();
  borrowed.quick.enter({ revision: started.revision, busy: false });
  borrowed.quick.ready({ revision: started.revision });

  assert.equal(borrowed.quick.handleNormalHostBlur(), false);
  assert.equal(borrowed.quick.isActive(), true);
});

test("navigation, load failure and page loss all invalidate the round", () => {
  for (const reason of ["navigation", "load-failed", "destroyed"]) {
    const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 1 });
    const started = h.quick.show();
    h.quick.enter({ revision: started.revision, busy: false });
    h.quick.ready({ revision: started.revision });

    assert.equal(h.quick.invalidateRound(reason), true, reason);
    assert.equal(h.quick.isActive(), false, reason);
    assert.deepEqual(h.attachments, ["quick", "normal"], reason);
    assert.deepEqual(h.normal.opacityCalls, [0, 1], reason);
    // A late reply from the dead document cannot revive it.
    assert.deepEqual(h.quick.ready({ revision: started.revision }), { status: "stale" }, reason);
    assert.equal(
      h.quick.activate({ sessionId: "s1", revision: started.revision }).reason,
      "stale-revision",
      reason
    );
  }
});

test("a failed attach rolls the attachment back to the ordinary host", () => {
  const h = harness({ snapshot: snapshotOf("s1"), normalOpacity: 1, attachFails: true });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });

  const result = h.quick.ready({ revision: started.revision });

  assert.equal(result.status, "error");
  assert.deepEqual(
    h.attachments.at(-1),
    "normal",
    "the page is re-parented, not left orphaned"
  );
  assert.deepEqual(h.normal.opacityCalls, [0, 1]);
  assert.deepEqual(h.normal.ignoreMouseCalls, [true, false]);
  assert.equal(h.quick.isShown(), false);
  assert.equal(h.quick.isActive(), false, "the round is rolled back too");
});

test("a quick host that cannot be raised rolls the whole borrow back", () => {
  const h = harness({
    snapshot: snapshotOf("s1"),
    normalOpacity: 1,
    quickShowThrows: true,
  });
  const started = h.quick.show();
  h.quick.enter({ revision: started.revision, busy: false });

  const result = h.quick.ready({ revision: started.revision });

  assert.equal(result.status, "error");
  assert.deepEqual(h.attachments.at(-1), "normal");
  assert.deepEqual(h.normal.opacityCalls, [0, 1]);
  assert.equal(h.quick.isShown(), false);
  assert.equal(h.quick.isActive(), false);
});

test("a page that loads late can pick up the pending round", () => {
  const h = harness({ snapshot: snapshotOf("s1") });
  const started = h.quick.show();
  assert.equal(h.quick.getPendingRevision(), started.revision);

  h.quick.enter({ revision: started.revision, busy: false });
  assert.equal(h.quick.getPendingRevision(), 0, "consumed exactly once");
});
