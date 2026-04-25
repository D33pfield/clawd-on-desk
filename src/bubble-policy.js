"use strict";

const BUBBLE_KINDS = Object.freeze(["permission", "notification", "update"]);
const BUBBLE_KIND_SET = new Set(BUBBLE_KINDS);
const NOTIFICATION_DEFAULT_SECONDS = 3;
const UPDATE_DEFAULT_SECONDS = 9;
const MAX_AUTO_CLOSE_SECONDS = 3600;

function isValidBubbleKind(kind) {
  return BUBBLE_KIND_SET.has(kind);
}

function normalizeAutoCloseSeconds(value, defaultValue) {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
  const n = Math.trunc(value);
  if (n < 0) return defaultValue;
  if (n > MAX_AUTO_CLOSE_SECONDS) return MAX_AUTO_CLOSE_SECONDS;
  return n;
}

function isAllBubblesHidden(snapshot = {}) {
  if (snapshot.hideBubbles === true) return true;
  const permissionEnabled = snapshot.permissionBubblesEnabled !== false;
  const notificationSeconds = normalizeAutoCloseSeconds(
    snapshot.notificationBubbleAutoCloseSeconds,
    NOTIFICATION_DEFAULT_SECONDS
  );
  const updateSeconds = normalizeAutoCloseSeconds(
    snapshot.updateBubbleAutoCloseSeconds,
    UPDATE_DEFAULT_SECONDS
  );
  return !permissionEnabled && notificationSeconds === 0 && updateSeconds === 0;
}

function getBubblePolicy(snapshot = {}, kind) {
  if (!isValidBubbleKind(kind)) {
    throw new Error(`Unknown bubble policy kind: ${kind}`);
  }

  if (snapshot.hideBubbles === true) {
    return { enabled: false, autoCloseMs: kind === "permission" ? null : 0 };
  }

  if (kind === "permission") {
    const enabled = snapshot.permissionBubblesEnabled !== false;
    return { enabled, autoCloseMs: null };
  }

  if (kind === "notification") {
    const seconds = normalizeAutoCloseSeconds(
      snapshot.notificationBubbleAutoCloseSeconds,
      NOTIFICATION_DEFAULT_SECONDS
    );
    return {
      enabled: seconds > 0,
      autoCloseMs: seconds > 0 ? seconds * 1000 : 0,
    };
  }

  const seconds = normalizeAutoCloseSeconds(
    snapshot.updateBubbleAutoCloseSeconds,
    UPDATE_DEFAULT_SECONDS
  );
  return {
    enabled: seconds > 0,
    autoCloseMs: seconds > 0 ? seconds * 1000 : 0,
  };
}

function buildAggregateHideCommit(hidden, snapshot = {}) {
  if (hidden) return { hideBubbles: true };

  const permissionEnabled = snapshot.permissionBubblesEnabled !== false;
  const notificationSeconds = normalizeAutoCloseSeconds(
    snapshot.notificationBubbleAutoCloseSeconds,
    NOTIFICATION_DEFAULT_SECONDS
  );
  const updateSeconds = normalizeAutoCloseSeconds(
    snapshot.updateBubbleAutoCloseSeconds,
    UPDATE_DEFAULT_SECONDS
  );
  const commit = { hideBubbles: false };

  if (!permissionEnabled && notificationSeconds === 0 && updateSeconds === 0) {
    commit.permissionBubblesEnabled = true;
    commit.notificationBubbleAutoCloseSeconds = NOTIFICATION_DEFAULT_SECONDS;
    commit.updateBubbleAutoCloseSeconds = UPDATE_DEFAULT_SECONDS;
  }

  return commit;
}

function buildCategoryEnabledCommit(snapshot = {}, category, enabled) {
  if (!isValidBubbleKind(category)) {
    return { error: `setBubbleCategoryEnabled.category must be one of: ${BUBBLE_KINDS.join(", ")}` };
  }
  if (typeof enabled !== "boolean") {
    return { error: "setBubbleCategoryEnabled.enabled must be a boolean" };
  }

  const next = {
    permissionBubblesEnabled: snapshot.permissionBubblesEnabled !== false,
    notificationBubbleAutoCloseSeconds: normalizeAutoCloseSeconds(
      snapshot.notificationBubbleAutoCloseSeconds,
      NOTIFICATION_DEFAULT_SECONDS
    ),
    updateBubbleAutoCloseSeconds: normalizeAutoCloseSeconds(
      snapshot.updateBubbleAutoCloseSeconds,
      UPDATE_DEFAULT_SECONDS
    ),
  };

  if (category === "permission") {
    next.permissionBubblesEnabled = enabled;
  } else if (category === "notification") {
    next.notificationBubbleAutoCloseSeconds = enabled
      ? (next.notificationBubbleAutoCloseSeconds > 0
          ? next.notificationBubbleAutoCloseSeconds
          : NOTIFICATION_DEFAULT_SECONDS)
      : 0;
  } else {
    next.updateBubbleAutoCloseSeconds = enabled
      ? (next.updateBubbleAutoCloseSeconds > 0
          ? next.updateBubbleAutoCloseSeconds
          : UPDATE_DEFAULT_SECONDS)
      : 0;
  }

  next.hideBubbles = isAllBubblesHidden(next);
  return { commit: next };
}

module.exports = {
  BUBBLE_KINDS,
  NOTIFICATION_DEFAULT_SECONDS,
  UPDATE_DEFAULT_SECONDS,
  MAX_AUTO_CLOSE_SECONDS,
  getBubblePolicy,
  isAllBubblesHidden,
  buildAggregateHideCommit,
  buildCategoryEnabledCommit,
  normalizeAutoCloseSeconds,
};
