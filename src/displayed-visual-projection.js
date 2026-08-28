"use strict";

const {
  VISUAL_SETTLEMENT_DEADLINE_MS,
} = require("./pet-visual-swap-policy");

const RENDERER_OUTCOMES = new Set([
  "swapped",
  "already-displayed",
  "fallback",
  "failed",
]);
const SAFE_CHANNELS = new Set(["object", "img", "bridge"]);
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const MAX_TERMINAL_HISTORY = 128;

function freezeTuple(value) {
  return Object.freeze({
    displayState: value.displayState,
    file: value.file,
    hitBox: value.hitBox && typeof value.hitBox === "object"
      ? Object.freeze({ ...value.hitBox })
      : value.hitBox || null,
    source: value.source,
    visualGeneration: value.visualGeneration,
  });
}

function createDisplayedVisualProjection(options = {}) {
  const now = options.now || (() => Date.now());
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const deadlineMs = Number.isFinite(options.deadlineMs)
    ? options.deadlineMs
    : VISUAL_SETTLEMENT_DEADLINE_MS;
  const projectActualFile = options.projectActualFile || (() => null);
  const onCommit = options.onCommit || (() => {});
  const onTerminal = options.onTerminal || (() => {});
  const onRendererUnresponsive = options.onRendererUnresponsive || (() => {});

  let themeId = null;
  let logicalState = null;
  let requested = null;
  let committed = null;
  let nextGeneration = 1;
  let pendingTimer = null;
  let recoveryKey = null;
  let recoveryRequests = 0;
  let consecutiveNoAck = 0;
  let rendererReloadUsed = false;
  const terminals = new Map();

  function rememberTerminal(generation, status, detail = null) {
    terminals.set(generation, Object.freeze({ status, detail }));
    while (terminals.size > MAX_TERMINAL_HISTORY) {
      terminals.delete(terminals.keys().next().value);
    }
    onTerminal({ visualGeneration: generation, status, detail });
  }

  function clearPendingTimer() {
    if (pendingTimer) clearTimeoutFn(pendingTimer);
    pendingTimer = null;
  }

  function logicalVisualKey(input) {
    return [input.themeId, input.logicalState, input.file, input.source].join("\u0000");
  }

  function validateRequest(input) {
    return !!(
      input
      && typeof input === "object"
      && (input.themeId === null || typeof input.themeId === "string")
      && typeof input.logicalState === "string"
      && typeof input.displayState === "string"
      && typeof input.file === "string"
      && SAFE_BASENAME.test(input.file)
      && typeof input.source === "string"
      && typeof input.deliver === "function"
    );
  }

  function request(input, internal = {}) {
    if (!validateRequest(input)) return null;
    const key = logicalVisualKey(input);
    if (!internal.preserveRecovery && key !== recoveryKey) {
      recoveryKey = key;
      recoveryRequests = 0;
      consecutiveNoAck = 0;
    }

    if (requested) {
      clearPendingTimer();
      rememberTerminal(requested.visualGeneration, "superseded");
    }

    themeId = input.themeId;
    logicalState = input.logicalState;
    const visualGeneration = nextGeneration++;
    const tuple = freezeTuple({ ...input, visualGeneration });
    requested = Object.freeze({
      ...tuple,
      themeId,
      logicalState,
      requestedAt: now(),
      deliver: input.deliver,
      recoveryInput: Object.freeze({
        themeId: input.themeId,
        logicalState: input.logicalState,
        displayState: input.displayState,
        file: input.file,
        hitBox: input.hitBox || null,
        source: input.source,
        deliver: input.deliver,
      }),
      sawAck: false,
    });

    const payload = Object.freeze({
      themeId,
      logicalState,
      displayState: tuple.displayState,
      file: tuple.file,
      source: tuple.source,
      visualGeneration,
    });
    let delivered = false;
    try {
      delivered = input.deliver(payload) !== false;
    } catch {
      delivered = false;
    }
    if (!delivered) {
      requested = null;
      rememberTerminal(visualGeneration, "failed", "delivery-failed");
      return payload;
    }

    const capturedGeneration = visualGeneration;
    pendingTimer = setTimeoutFn(() => {
      if (!requested || requested.visualGeneration !== capturedGeneration) return;
      const timedOut = requested;
      requested = null;
      pendingTimer = null;
      rememberTerminal(capturedGeneration, "failed", "settlement-timeout");
      consecutiveNoAck++;
      if (recoveryRequests < 1) {
        recoveryRequests++;
        request(timedOut.recoveryInput, { preserveRecovery: true });
        return;
      }
      if (consecutiveNoAck >= 2 && !rendererReloadUsed) {
        rendererReloadUsed = true;
        onRendererUnresponsive({
          themeId: timedOut.themeId,
          logicalState: timedOut.logicalState,
          file: timedOut.file,
        });
      }
    }, deadlineMs);
    if (pendingTimer && typeof pendingTimer.unref === "function") pendingTimer.unref();
    return payload;
  }

  function failCurrent(detail) {
    if (!requested) return false;
    const generation = requested.visualGeneration;
    clearPendingTimer();
    requested = null;
    rememberTerminal(generation, "failed", detail);
    return true;
  }

  function settle(ack) {
    if (!ack || typeof ack !== "object" || !requested) return { accepted: false, reason: "no-pending-request" };
    if (
      ack.visualGeneration !== requested.visualGeneration
      || ack.themeId !== requested.themeId
      || ack.displayState !== requested.displayState
      || ack.requestedFile !== requested.file
    ) {
      return { accepted: false, reason: "request-mismatch" };
    }
    if (!RENDERER_OUTCOMES.has(ack.outcome) || !SAFE_CHANNELS.has(ack.channel)) {
      return { accepted: false, reason: "invalid-outcome" };
    }
    requested = Object.freeze({ ...requested, sawAck: true });
    consecutiveNoAck = 0;

    if (ack.outcome === "failed") {
      failCurrent("renderer-failed");
      return { accepted: true, status: "failed" };
    }
    if (ack.verified !== true || typeof ack.actualFile !== "string" || !SAFE_BASENAME.test(ack.actualFile)) {
      failCurrent("unverified-renderer-result");
      return { accepted: true, status: "failed" };
    }
    if (
      (ack.outcome === "swapped" || ack.outcome === "already-displayed")
      && ack.actualFile !== requested.file
    ) {
      failCurrent("actual-file-mismatch");
      return { accepted: true, status: "failed" };
    }

    let nextTuple = Object.freeze({
      ...freezeTuple(requested),
      themeId: requested.themeId,
      logicalState: requested.logicalState,
    });
    if (ack.actualFile !== requested.file) {
      if (ack.outcome !== "fallback") {
        failCurrent("unexpected-actual-file");
        return { accepted: true, status: "failed" };
      }
      const projected = projectActualFile({
        themeId: requested.themeId,
        logicalState: requested.logicalState,
        requested,
        actualFile: ack.actualFile,
      });
      if (!projected) {
        failCurrent("unprojectable-fallback");
        return { accepted: true, status: "failed" };
      }
      nextTuple = Object.freeze({
        ...freezeTuple({
          displayState: projected.displayState,
          file: ack.actualFile,
          hitBox: projected.hitBox,
          source: requested.source,
          visualGeneration: requested.visualGeneration,
        }),
        themeId: requested.themeId,
        logicalState: requested.logicalState,
      });
    }

    clearPendingTimer();
    requested = null;
    committed = nextTuple;
    recoveryKey = null;
    recoveryRequests = 0;
    rememberTerminal(nextTuple.visualGeneration, "committed", ack.outcome);
    onCommit(committed, ack);
    return { accepted: true, status: "committed", committed };
  }

  function getSnapshot() {
    return Object.freeze({
      themeId,
      logicalState,
      requested,
      committed,
    });
  }

  function getTerminal(generation) {
    return terminals.get(generation) || null;
  }

  function dispose() {
    clearPendingTimer();
    if (requested) rememberTerminal(requested.visualGeneration, "failed", "disposed");
    requested = null;
  }

  return {
    request,
    settle,
    failCurrent,
    getSnapshot,
    getTerminal,
    dispose,
    get rendererReloadUsed() { return rendererReloadUsed; },
  };
}

module.exports = {
  RENDERER_OUTCOMES,
  SAFE_CHANNELS,
  createDisplayedVisualProjection,
};
