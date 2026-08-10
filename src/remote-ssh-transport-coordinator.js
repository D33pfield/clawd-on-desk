"use strict";

const childProcess = require("child_process");
const { localTargetFingerprint } = require("./remote-ssh-transport");

const DEFAULT_DRAIN_TIMEOUT_MS = 10000;

class TransportUndrainedError extends Error {
  constructor(message = "Remote SSH transport did not close before the drain deadline", details = {}) {
    super(message);
    this.name = "TransportUndrainedError";
    this.code = "transport_drain_timeout";
    this.timedOut = true;
    this.drainVerified = false;
    Object.assign(this, details);
  }
}

function errorResult(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function createRemoteSshTransportCoordinator(deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  const inspectTransport = deps.inspectEffectiveTransport;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const drainTimeoutMs = Number.isFinite(deps.drainTimeoutMs)
    ? deps.drainTimeoutMs
    : DEFAULT_DRAIN_TIMEOUT_MS;
  if (typeof inspectTransport !== "function") {
    throw new Error("createRemoteSshTransportCoordinator: inspectEffectiveTransport required");
  }

  const slots = new Map();
  const leases = new WeakMap();
  const sticky = new Map();
  const inspectionInFlight = new Map();
  const lastFingerprintByProfile = new Map();
  const intents = new Map();
  let leaseGeneration = 0;
  let attemptGeneration = 0;
  let closing = false;

  function getIntent(profileId) {
    return intents.get(profileId) || { desiredConnected: false, intentGeneration: 0 };
  }

  function recordIntent(profileId, desiredConnected) {
    const previous = getIntent(profileId);
    const next = {
      desiredConnected: desiredConnected === true,
      intentGeneration: previous.intentGeneration + 1,
    };
    intents.set(profileId, next);
    return { ...next };
  }

  function recordDisconnectIntent(profileId) {
    return recordIntent(profileId, false);
  }

  function forgetProfile(profileId) {
    const fingerprint = lastFingerprintByProfile.get(profileId);
    if (fingerprint) sticky.delete(fingerprint);
    lastFingerprintByProfile.delete(profileId);
    intents.delete(profileId);
  }

  function rememberProfileFingerprint(profile) {
    const fingerprint = localTargetFingerprint(profile);
    const previous = lastFingerprintByProfile.get(profile.id);
    if (previous && previous !== fingerprint) sticky.delete(previous);
    lastFingerprintByProfile.set(profile.id, fingerprint);
    return fingerprint;
  }

  async function inspect(profile) {
    const fingerprint = rememberProfileFingerprint(profile);
    let pending = inspectionInFlight.get(fingerprint);
    if (!pending) {
      pending = Promise.resolve(inspectTransport(profile)).finally(() => {
        if (inspectionInFlight.get(fingerprint) === pending) inspectionInFlight.delete(fingerprint);
      });
      inspectionInFlight.set(fingerprint, pending);
    }
    const result = await pending;
    if (result && result.mode === "serialized" && result.key) {
      sticky.set(fingerprint, {
        lastKnownMode: "serialized",
        key: result.key,
        evidenceKind: result.kind,
        fingerprintVersion: 1,
      });
      return result;
    }
    if (result && result.mode === "parallel") {
      sticky.delete(fingerprint);
      return result;
    }
    const previous = sticky.get(fingerprint);
    if (previous && previous.lastKnownMode === "serialized") {
      return {
        ...result,
        mode: "serialized",
        kind: previous.evidenceKind,
        key: previous.key,
        fingerprint,
        warning: "Effective SSH inspection failed; retaining the last known serialized safety mode.",
        stickyFallback: true,
      };
    }
    const hint = profile && profile.sshTransportHint;
    if (hint && hint.version === 1 && hint.mode === "serialized" && typeof hint.keyId === "string") {
      return {
        ...result,
        mode: "serialized",
        kind: hint.kind,
        key: hint.keyId,
        fingerprint,
        warning: "Effective SSH inspection failed; using the trusted historical serialized hint.",
        historicalHintFallback: true,
      };
    }
    return result;
  }

  function createLease(slot, profileId, operation) {
    const lease = Object.freeze({});
    const internal = {
      slot,
      profileId,
      operation,
      leaseGeneration: ++leaseGeneration,
      attemptGeneration: ++attemptGeneration,
      attemptToken: Object.freeze({}),
      active: true,
      invalidReason: null,
      lockStage: "before-acquire",
    };
    leases.set(lease, internal);
    slot.activeLease = lease;
    slot.operationName = operation;
    return lease;
  }

  function validateLease(lease, { attemptToken } = {}) {
    const internal = leases.get(lease);
    if (!internal || !internal.active || internal.slot.activeLease !== lease) {
      throw Object.assign(new Error("Remote SSH transport reservation is no longer active"), {
        code: "transport_operation_inactive",
      });
    }
    if (attemptToken && internal.attemptToken !== attemptToken) {
      throw Object.assign(new Error("Remote SSH transport attempt is stale"), {
        code: "transport_attempt_stale",
      });
    }
    return internal;
  }

  function makeContext(lease) {
    return Object.freeze({
      reservationToken: lease,
      get attemptToken() {
        const internal = validateLease(lease);
        return internal.attemptToken;
      },
      get profileId() { return validateLease(lease).profileId; },
      get transportKey() { return validateLease(lease).slot.transportKey; },
      assertActive() { validateLease(lease); },
      nextAttempt() {
        const internal = validateLease(lease);
        internal.attemptGeneration = ++attemptGeneration;
        internal.attemptToken = Object.freeze({});
        return internal.attemptToken;
      },
      setLockStage(stage) {
        const internal = validateLease(lease);
        if (!["before-acquire", "acquire-attempted", "lock-owned"].includes(stage)) {
          throw new Error("invalid remote transport lock stage");
        }
        internal.lockStage = stage;
      },
      getRecoveryCode() {
        const internal = validateLease(lease);
        return internal.lockStage === "before-acquire"
          ? null
          : "manual_lock_inspection_required";
      },
      transitionToConnection() {
        const internal = validateLease(lease);
        if (internal.slot.trackedChildren.size > 0) {
          throw new TransportUndrainedError("Cannot resume a connection while an operation child is still live", {
            profileId: internal.profileId,
            operation: internal.operation,
          });
        }
        internal.operation = "connect";
        internal.lockStage = "before-acquire";
        internal.slot.operationName = "connect";
        internal.slot.phase = "preparing";
      },
      spawn(spec) {
        return spawnManagedTransportChild({ ...spec, reservationToken: lease });
      },
    });
  }

  async function acquire(profile, operation, options = {}) {
    if (closing) {
      return errorResult("transport_shutdown", "Remote SSH transport is shutting down");
    }
    if (!profile || typeof profile.id !== "string") {
      return errorResult("invalid_profile", "Remote SSH profile id is required");
    }
    const inspection = await inspect(profile);
    if (!inspection || inspection.mode === "unknown") {
      return errorResult(
        "transport_inspection_failed",
        (inspection && inspection.message) || "Unable to inspect effective SSH transport",
        { profileId: profile.id },
      );
    }
    if (inspection.mode !== "serialized") {
      return { ok: true, serialized: false, inspection, context: null };
    }

    // A live connection/operation is bound to the immutable transport key
    // that admitted it.  A settings edit must not let the same profile create
    // a second slot while the old ProxyCommand chain is still alive.
    for (const existing of slots.values()) {
      if (existing.ownerProfileId === profile.id
        && existing.transportKey !== inspection.key
        && existing.phase !== "idle") {
        return errorResult(
          "profile_changed",
          "The effective SSH transport changed; Disconnect before using the updated profile",
          { profileId: profile.id, operation: existing.operationName || undefined },
        );
      }
    }

    let slot = slots.get(inspection.key);
    if (!slot) {
      slot = {
        transportKey: inspection.key,
        inspection,
        ownerProfileId: null,
        phase: "idle",
        operationName: null,
        activeLease: null,
        trackedChildren: new Map(),
        quarantine: null,
      };
      slots.set(inspection.key, slot);
    } else {
      slot.inspection = inspection;
    }
    if (slot.phase !== "idle") {
      if (slot.phase === "failed" || slot.phase === "quarantined") {
        return errorResult(
          slot.quarantine && slot.quarantine.lockStage !== "before-acquire"
            ? "manual_lock_inspection_required"
            : "transport_drain_timeout",
          "The serialized SSH transport is quarantined and requires explicit recovery",
          {
            profileId: profile.id,
            ownerProfileId: slot.ownerProfileId || undefined,
            operation: slot.operationName || (slot.quarantine && slot.quarantine.operation) || undefined,
          },
        );
      }
      const sameOwner = slot.ownerProfileId === profile.id;
      if (!(sameOwner && options.takeoverOwner === true)) {
        return errorResult(
          sameOwner ? "transport_operation_busy" : "serialized_transport_busy",
          sameOwner
            ? "Another Remote SSH operation is already active for this profile"
            : "Another profile already owns this serialized SSH transport",
          {
            profileId: profile.id,
            ownerProfileId: slot.ownerProfileId || undefined,
            operation: slot.operationName || undefined,
          },
        );
      }
      if (slot.operationName && slot.operationName !== "connect") {
        return errorResult(
          "transport_operation_busy",
          "Another Remote SSH operation is already active for this profile",
          {
            profileId: profile.id,
            ownerProfileId: slot.ownerProfileId || undefined,
            operation: slot.operationName,
          },
        );
      }
      const previous = leases.get(slot.activeLease);
      if (previous) {
        previous.active = false;
        previous.invalidReason = "owner_takeover";
      }
      slot.phase = "suspending";
    } else {
      slot.ownerProfileId = profile.id;
      slot.phase = options.phase || "preparing";
    }
    const lease = createLease(slot, profile.id, operation);
    return {
      ok: true,
      serialized: true,
      inspection,
      context: makeContext(lease),
    };
  }

  async function acquireConnection(profile, options = {}) {
    const result = await acquire(profile, "connect", { phase: "preparing" });
    if (result.ok && result.serialized) {
      result.intent = recordIntent(profile.id, true);
    } else if (result.ok && !result.serialized) {
      result.intent = recordIntent(profile.id, true);
    }
    return result;
  }

  async function acquireOperation(profile, operation) {
    return acquire(profile, operation, { takeoverOwner: true, phase: "operation" });
  }

  async function acquireOwnedOperation(profile, operation) {
    if (!profile || typeof profile.id !== "string") {
      return errorResult("invalid_profile", "Remote SSH profile id is required");
    }
    const owned = Array.from(slots.values()).filter((slot) =>
      slot.ownerProfileId === profile.id && slot.phase !== "idle"
    );
    if (owned.length === 0) return acquireOperation(profile, operation);
    if (owned.length !== 1) {
      return errorResult(
        "serialized_transport_busy",
        "The profile owns more than one active serialized SSH transport",
        { profileId: profile.id },
      );
    }
    const slot = owned[0];
    if (slot.phase === "failed" || slot.phase === "quarantined") {
      return errorResult(
        slot.quarantine && slot.quarantine.lockStage !== "before-acquire"
          ? "manual_lock_inspection_required"
          : "transport_drain_timeout",
        "The serialized SSH transport is quarantined and requires explicit recovery",
        {
          profileId: profile.id,
          ownerProfileId: slot.ownerProfileId || undefined,
          operation: (slot.quarantine && slot.quarantine.operation) || undefined,
        },
      );
    }
    if (slot.operationName && slot.operationName !== "connect") {
      return errorResult(
        "transport_operation_busy",
        "Another Remote SSH operation is already active for this profile",
        {
          profileId: profile.id,
          ownerProfileId: slot.ownerProfileId || undefined,
          operation: slot.operationName,
        },
      );
    }
    const previous = leases.get(slot.activeLease);
    if (previous) {
      previous.active = false;
      previous.invalidReason = "owner_takeover";
    }
    slot.phase = "suspending";
    const lease = createLease(slot, profile.id, operation);
    return {
      ok: true,
      serialized: true,
      inspection: slot.inspection || {
        mode: "serialized",
        kind: "retained-owner",
        key: slot.transportKey,
      },
      context: makeContext(lease),
      retainedOwner: true,
    };
  }

  function trackChild(internal, child, metadata) {
    let closeResolve;
    const closePromise = new Promise((resolve) => { closeResolve = resolve; });
    const record = {
      profileId: internal.profileId,
      transportKey: internal.slot.transportKey,
      role: metadata.role,
      tool: metadata.tool,
      attemptToken: internal.attemptToken,
      closePromise,
      closed: false,
    };
    internal.slot.trackedChildren.set(child, record);
    child.once("close", (code, signal) => {
      if (record.closed) return;
      record.closed = true;
      internal.slot.trackedChildren.delete(child);
      closeResolve({ code, signal });
      if (internal.slot.phase === "quarantined" && internal.slot.trackedChildren.size === 0) {
        internal.slot.phase = "failed";
        internal.slot.activeLease = null;
      }
    });
    return record;
  }

  function spawnManagedTransportChild(spec = {}) {
    const internal = validateLease(spec.reservationToken, { attemptToken: spec.attemptToken });
    if (!spec.role || !spec.tool || !Array.isArray(spec.args)) {
      throw new Error("spawnManagedTransportChild requires role, tool, and args");
    }
    if (internal.slot.trackedChildren.size > 0) {
      throw Object.assign(new Error("Serialized SSH transport already has a live child"), {
        code: "serialized_transport_busy",
      });
    }
    const child = spawn(spec.tool, spec.args, spec.options || {});
    trackChild(internal, child, spec);
    return child;
  }

  function setPhase(context, phase) {
    const internal = validateLease(context && context.reservationToken);
    internal.slot.phase = phase;
  }

  function waitForDrain(context, requestStop, timeoutOverride) {
    const internal = validateLease(context && context.reservationToken);
    internal.slot.phase = "suspending";
    const records = Array.from(internal.slot.trackedChildren.entries());
    for (const [child, record] of records) {
      try { requestStop(child, record); } catch {}
    }
    if (records.length === 0) return Promise.resolve({ ok: true, drainVerified: true });
    const deadline = Number.isFinite(timeoutOverride) ? timeoutOverride : drainTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeoutFn(timer);
        fn(value);
      };
      Promise.all(records.map(([, record]) => record.closePromise)).then(() => {
        finish(resolve, { ok: true, drainVerified: true });
      });
      timer = setTimeoutFn(() => {
        internal.active = false;
        internal.invalidReason = "transport_drain_timeout";
        internal.slot.phase = "quarantined";
        internal.slot.quarantine = {
          lockStage: internal.lockStage,
          operation: internal.operation,
          childCount: internal.slot.trackedChildren.size,
        };
        finish(reject, new TransportUndrainedError(undefined, {
          profileId: internal.profileId,
          operation: internal.operation,
          recoveryCode: internal.lockStage === "before-acquire"
            ? undefined
            : "manual_lock_inspection_required",
        }));
      }, deadline);
    });
  }

  function invalidate(context, reason = "operation_invalidated") {
    const internal = validateLease(context && context.reservationToken);
    internal.active = false;
    internal.invalidReason = reason;
    internal.slot.phase = "quarantined";
    internal.slot.quarantine = {
      lockStage: internal.lockStage,
      operation: internal.operation,
      childCount: internal.slot.trackedChildren.size,
    };
  }

  function abortAfterVerifiedClose(context, reason = "operation_timeout") {
    const internal = validateLease(context && context.reservationToken);
    if (internal.slot.trackedChildren.size > 0) {
      throw new TransportUndrainedError("Cannot abort while the transport child is still live", {
        profileId: internal.profileId,
        operation: internal.operation,
      });
    }
    const recoveryCode = internal.lockStage === "before-acquire"
      ? null
      : "manual_lock_inspection_required";
    internal.active = false;
    internal.invalidReason = reason;
    internal.slot.activeLease = null;
    internal.slot.operationName = null;
    internal.slot.quarantine = recoveryCode ? {
      lockStage: internal.lockStage,
      operation: internal.operation,
      childCount: 0,
    } : null;
    if (recoveryCode) {
      internal.slot.phase = "failed";
    } else {
      internal.slot.phase = "idle";
      internal.slot.ownerProfileId = null;
    }
    return { recoveryCode };
  }

  function release(context, options = {}) {
    const internal = validateLease(context && context.reservationToken);
    if (internal.slot.trackedChildren.size > 0) {
      throw new TransportUndrainedError("Cannot release a transport with a live child", {
        profileId: internal.profileId,
        operation: internal.operation,
      });
    }
    internal.active = false;
    internal.invalidReason = "released";
    internal.slot.activeLease = null;
    internal.slot.operationName = null;
    if (options.keepOwner === true) {
      internal.slot.phase = options.phase || "tunnel";
    } else {
      internal.slot.phase = options.phase || "idle";
      internal.slot.ownerProfileId = null;
    }
  }

  function snapshotForProfile(profileId) {
    const intent = getIntent(profileId);
    for (const slot of slots.values()) {
      if (slot.ownerProfileId !== profileId) continue;
      return {
        transportPhase: slot.phase,
        transportOwnerProfileId: slot.ownerProfileId,
        transportDesiredConnected: intent.desiredConnected,
      };
    }
    return {
      transportPhase: "idle",
      transportOwnerProfileId: null,
      transportDesiredConnected: intent.desiredConnected,
    };
  }

  function getActiveOwnerOperation(profileId) {
    for (const slot of slots.values()) {
      if (slot.ownerProfileId !== profileId || slot.phase === "idle") continue;
      return {
        phase: slot.phase,
        operation: slot.operationName,
        quarantined: slot.phase === "failed" || slot.phase === "quarantined",
      };
    }
    return null;
  }

  function listSnapshots() {
    return Array.from(slots.values()).map((slot) => ({
      transportPhase: slot.phase,
      transportOwnerProfileId: slot.ownerProfileId,
    }));
  }

  async function checkInteractive(profile) {
    if (closing) return errorResult("transport_shutdown", "Remote SSH transport is shutting down");
    const inspection = await inspect(profile);
    if (!inspection || inspection.mode === "unknown") {
      return errorResult(
        "transport_inspection_failed",
        (inspection && inspection.message) || "Unable to inspect effective SSH transport",
        { profileId: profile && profile.id },
      );
    }
    if (inspection.mode !== "serialized") {
      return { ok: true, serialized: false, inspection };
    }
    const slot = slots.get(inspection.key);
    if (slot && slot.phase !== "idle") {
      return errorResult(
        "serialized_transport_busy",
        "Disconnect the managed Remote SSH session before opening an interactive terminal",
        {
          profileId: profile.id,
          ownerProfileId: slot.ownerProfileId || undefined,
          operation: slot.operationName || undefined,
        },
      );
    }
    return { ok: true, serialized: true, inspection };
  }

  function shutdown(timeoutOverride) {
    closing = true;
    const records = [];
    for (const slot of slots.values()) {
      slot.phase = "stopping";
      const internal = leases.get(slot.activeLease);
      if (internal) {
        internal.active = false;
        internal.invalidReason = "transport_shutdown";
      }
      for (const [child, record] of slot.trackedChildren.entries()) {
        records.push([child, record]);
        if (record.role === "persistent-tunnel-readiness" && child.stdin) {
          try { child.stdin.end(); } catch {}
        } else {
          // Final app shutdown may terminate the exact top-level child that
          // Clawd owns. No later transport work is admitted in this process.
          try { child.kill(); } catch {}
        }
      }
    }
    if (records.length === 0) {
      return Promise.resolve({ ok: true, drainVerified: true, remaining: 0 });
    }
    const deadline = Number.isFinite(timeoutOverride) ? timeoutOverride : drainTimeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeoutFn(timer);
        resolve(result);
      };
      Promise.all(records.map(([, record]) => record.closePromise)).then(() => {
        finish({ ok: true, drainVerified: true, remaining: 0 });
      });
      timer = setTimeoutFn(() => {
        let remaining = 0;
        for (const [child, record] of records) {
          if (record.closed) continue;
          remaining += 1;
          try { child.kill(); } catch {}
        }
        finish({ ok: false, drainVerified: false, remaining });
      }, deadline);
    });
  }

  return {
    inspect,
    acquire,
    acquireConnection,
    acquireOperation,
    acquireOwnedOperation,
    recordDisconnectIntent,
    getIntent,
    forgetProfile,
    spawnManagedTransportChild,
    waitForDrain,
    setPhase,
    invalidate,
    abortAfterVerifiedClose,
    release,
    snapshotForProfile,
    getActiveOwnerOperation,
    listSnapshots,
    checkInteractive,
    shutdown,
    isClosing: () => closing,
    _slots: slots,
    _sticky: sticky,
  };
}

module.exports = {
  DEFAULT_DRAIN_TIMEOUT_MS,
  TransportUndrainedError,
  createRemoteSshTransportCoordinator,
};
