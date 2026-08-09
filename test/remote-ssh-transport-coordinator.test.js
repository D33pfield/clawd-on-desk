"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  TransportUndrainedError,
  createRemoteSshTransportCoordinator,
} = require("../src/remote-ssh-transport-coordinator");

function profile(id = "p1", host = "space") {
  return { id, host, port: 22, sshTransportMode: "auto" };
}

function serializedInspection(p) {
  return Promise.resolve({
    mode: "serialized",
    kind: "codespaces-stdio",
    key: "codespace:fuzzy-space",
    fingerprint: `fp:${p.host}:${p.port || 22}`,
  });
}

function parallelInspection(p) {
  return Promise.resolve({
    mode: "parallel",
    kind: "standard",
    key: `parallel:${p.host}`,
    fingerprint: `fp:${p.host}`,
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { endCalls: 0, end() { this.endCalls += 1; } };
  child.kill = () => {};
  return child;
}

test("serialized spawn is rejected before raw spawn without a live opaque lease", async () => {
  let spawnCalls = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => { spawnCalls += 1; return fakeChild(); },
  });
  assert.throws(() => coordinator.spawnManagedTransportChild({
    reservationToken: {},
    profileId: "p1",
    role: "node-resolve",
    tool: "ssh",
    args: [],
  }), /reservation is no longer active/);
  assert.equal(spawnCalls, 0);
});

test("one serialized lease admits at most one live child until close", async () => {
  const children = [];
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  const acquired = await coordinator.acquireConnection(profile());
  assert.equal(acquired.ok, true);
  const first = acquired.context.spawn({
    attemptToken: acquired.context.attemptToken,
    role: "node-resolve",
    tool: "ssh",
    args: ["space", "node -v"],
  });
  assert.throws(() => acquired.context.spawn({
    attemptToken: acquired.context.attemptToken,
    role: "probe",
    tool: "ssh",
    args: ["space", "probe"],
  }), /already has a live child/);
  first.emit("exit", 0, null);
  assert.throws(() => acquired.context.spawn({
    attemptToken: acquired.context.attemptToken,
    role: "probe",
    tool: "ssh",
    args: ["space", "probe"],
  }), /already has a live child/, "exit must not release admission");
  first.emit("close", 0, null);
  const second = acquired.context.spawn({
    attemptToken: acquired.context.attemptToken,
    role: "probe",
    tool: "ssh",
    args: ["space", "probe"],
  });
  assert.equal(children.length, 2);
  second.emit("close", 0, null);
});

test("same-key non-owner is busy and does not change its intent", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
  });
  const owner = await coordinator.acquireConnection(profile("p1"));
  assert.equal(owner.ok, true);
  const other = await coordinator.acquireConnection(profile("p2", "alias-two"));
  assert.equal(other.ok, false);
  assert.equal(other.code, "serialized_transport_busy");
  assert.deepEqual(coordinator.getIntent("p2"), { desiredConnected: false, intentGeneration: 0 });
});

test("ordinary inspection does not create a serialized slot", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: parallelInspection,
  });
  const result = await coordinator.acquireConnection(profile());
  assert.equal(result.ok, true);
  assert.equal(result.serialized, false);
  assert.equal(coordinator._slots.size, 0);
});

test("owner operation takeover invalidates the old connection lease", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
  });
  const connection = await coordinator.acquireConnection(profile());
  const oldAttempt = connection.context.attemptToken;
  const operation = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(operation.ok, true);
  assert.throws(() => connection.context.spawn({
    attemptToken: oldAttempt,
    role: "stale",
    tool: "ssh",
    args: [],
  }), /no longer active/);
});

test("a second owner operation is busy instead of invalidating the active mutation", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const connection = await coordinator.acquireConnection(profile());
  const first = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(first.ok, true);
  const second = await coordinator.acquireOperation(profile(), "cleanup");
  assert.equal(second.ok, false);
  assert.equal(second.code, "transport_operation_busy");
  first.context.assertActive();
  assert.throws(() => connection.context.assertActive(), /no longer active/);
});

test("drain waits for close, not exit", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
    drainTimeoutMs: 1000,
  });
  const connection = await coordinator.acquireConnection(profile());
  const child = connection.context.spawn({
    attemptToken: connection.context.attemptToken,
    role: "tunnel",
    tool: "ssh",
    args: [],
  });
  const operation = await coordinator.acquireOperation(profile(), "deploy");
  const drain = coordinator.waitForDrain(operation.context, (owned) => owned.stdin.end());
  let settled = false;
  drain.then(() => { settled = true; });
  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(child.stdin.endCalls, 1);
  child.emit("close", 0, null);
  assert.deepEqual(await drain, { ok: true, drainVerified: true });
});

test("never-closing drain quarantines and keeps child tracked", async () => {
  const timers = [];
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
    setTimeout: (fn) => { timers.push(fn); return fn; },
    clearTimeout: () => {},
  });
  const connection = await coordinator.acquireConnection(profile());
  const child = connection.context.spawn({
    attemptToken: connection.context.attemptToken,
    role: "tunnel",
    tool: "ssh",
    args: [],
  });
  const operation = await coordinator.acquireOperation(profile(), "deploy");
  const drain = coordinator.waitForDrain(operation.context, () => {});
  timers.shift()();
  await assert.rejects(drain, (err) => {
    assert.ok(err instanceof TransportUndrainedError);
    assert.equal(err.drainVerified, false);
    return true;
  });
  const slot = coordinator._slots.get("codespace:fuzzy-space");
  assert.equal(slot.phase, "quarantined");
  assert.equal(slot.trackedChildren.size, 1);
  child.emit("close", null, "SIGTERM");
  assert.equal(slot.phase, "failed");
  assert.equal(slot.trackedChildren.size, 0);
  assert.throws(() => operation.context.assertActive(), /no longer active/);
});

test("sticky serialized evidence is used only after a fresh inspection failure", async () => {
  let calls = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async (p) => {
      calls += 1;
      if (calls === 1) return serializedInspection(p);
      return { mode: "unknown", kind: "inspection-failed", key: null, message: "boom" };
    },
  });
  const first = await coordinator.inspect(profile());
  assert.equal(first.mode, "serialized");
  const second = await coordinator.inspect(profile());
  assert.equal(second.mode, "serialized");
  assert.equal(second.stickyFallback, true);
  assert.equal(calls, 2, "sticky safety must not skip reinspection");
});

test("disconnect intent increments independently of operation attempts", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: parallelInspection,
  });
  await coordinator.acquireConnection(profile());
  assert.deepEqual(coordinator.getIntent("p1"), { desiredConnected: true, intentGeneration: 1 });
  coordinator.recordDisconnectIntent("p1");
  assert.deepEqual(coordinator.getIntent("p1"), { desiredConnected: false, intentGeneration: 2 });
});

test("one profile cannot acquire a second transport key while its original slot is live", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async (p) => ({
      mode: "serialized",
      kind: "explicit-serialized",
      key: `target:${p.host}`,
    }),
  });
  const first = await coordinator.acquireConnection(profile("p1", "old-host"));
  assert.equal(first.ok, true);
  const changed = await coordinator.acquireOperation(profile("p1", "new-host"), "deploy");
  assert.equal(changed.ok, false);
  assert.equal(changed.code, "profile_changed");
  assert.equal(coordinator._slots.size, 1);
});

test("interactive SSH is blocked for every non-idle serialized phase", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const idle = await coordinator.checkInteractive(profile());
  assert.equal(idle.ok, true);
  await coordinator.acquireConnection(profile());
  const busy = await coordinator.checkInteractive(profile("p2", "alias-two"));
  assert.equal(busy.ok, false);
  assert.equal(busy.code, "serialized_transport_busy");
  assert.equal(busy.ownerProfileId, "p1");
});

test("verified timeout before lock acquisition releases admission but invalidates the old callback", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const acquired = await coordinator.acquireOperation(profile(), "deploy");
  const outcome = coordinator.abortAfterVerifiedClose(acquired.context, "operation_timeout");
  assert.equal(outcome.recoveryCode, null);
  assert.throws(() => acquired.context.assertActive(), /no longer active/);
  const retry = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(retry.ok, true);
});

test("verified timeout after lock acquisition fails closed for manual inspection", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const acquired = await coordinator.acquireOperation(profile(), "deploy");
  acquired.context.setLockStage("lock-owned");
  const outcome = coordinator.abortAfterVerifiedClose(acquired.context, "operation_timeout");
  assert.equal(outcome.recoveryCode, "manual_lock_inspection_required");
  const retry = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "manual_lock_inspection_required");
});

test("app shutdown sends EOF to the exact persistent tunnel and admits no new work", async () => {
  const child = fakeChild();
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => child,
    drainTimeoutMs: 1000,
  });
  const acquired = await coordinator.acquireConnection(profile());
  acquired.context.spawn({
    attemptToken: acquired.context.attemptToken,
    role: "persistent-tunnel-readiness",
    tool: "ssh",
    args: [],
  });
  const draining = coordinator.shutdown(1000);
  assert.equal(child.stdin.endCalls, 1);
  assert.equal(child.killCalls, 0);
  const rejected = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "transport_shutdown");
  child.emit("close", 0, null);
  assert.deepEqual(await draining, { ok: true, drainVerified: true, remaining: 0 });
});
