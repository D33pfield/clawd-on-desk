"use strict";

const {
  getSessionFocusTarget,
  isFocusableLocalHudSession,
} = require("./session-focus");

const DEFAULT_MAPPING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REPLY_TEXT = 3800;

function normalizeMessageId(value) {
  if (value == null) return "";
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? trimmed : "";
  }
  return "";
}

function normalizeSessionId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizePromptText(value) {
  if (typeof value !== "string") return "";
  let text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .trim();
  if (text.length > MAX_REPLY_TEXT) text = text.slice(0, MAX_REPLY_TEXT);
  return text;
}

function shortSessionId(sessionId) {
  const id = String(sessionId || "");
  return id.length > 12 ? `${id.slice(0, 12)}...` : id;
}

function findSession(snapshot, sessionId) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  return sessions.find((entry) => entry && entry.id === sessionId) || null;
}

function isInteractivePermissionEntryForSession(permEntry, sessionId) {
  return !!permEntry
    && String(permEntry.sessionId || "") === String(sessionId || "")
    && permEntry.isCodexNotify !== true
    && permEntry.isKimiNotify !== true
    && permEntry.isHardwareBuddyTest !== true;
}

function hasInteractivePermissionPending(entry, getPendingPermissions) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof getPendingPermissions === "function") {
    let pending;
    try {
      pending = getPendingPermissions();
    } catch {
      return true;
    }
    const list = Array.isArray(pending) ? pending : [];
    return list.some((permEntry) => isInteractivePermissionEntryForSession(permEntry, entry.id));
  }
  return entry.state === "notification";
}

function createTelegramDirectSend({
  getSessionSnapshot,
  getPendingPermissions,
  focusSession,
  isEnabled = () => false,
  now = () => Date.now(),
  mappingTtlMs = DEFAULT_MAPPING_TTL_MS,
  osPlatform = process.platform,
  log = () => {},
} = {}) {
  const mappings = new Map(); // Telegram completion message id -> { sessionId, expiresAt }

  function safeLog(level, message, meta) {
    try { log(level, message, meta); } catch {}
  }

  function pruneExpired() {
    const ts = now();
    for (const [messageId, mapping] of mappings) {
      if (!mapping || mapping.expiresAt <= ts) mappings.delete(messageId);
    }
  }

  function registerCompletionNotification({ messageId, sessionId } = {}) {
    const key = normalizeMessageId(messageId);
    const id = normalizeSessionId(sessionId);
    if (!key || !id) return false;
    pruneExpired();
    mappings.set(key, {
      sessionId: id,
      expiresAt: now() + Math.max(1, mappingTtlMs),
    });
    safeLog("debug", "direct-send mapping registered", { messageId: key, sessionId: id });
    return true;
  }

  function resolveMapping(messageId) {
    pruneExpired();
    const key = normalizeMessageId(messageId);
    if (!key) return null;
    const mapping = mappings.get(key);
    if (!mapping) return null;
    if (mapping.expiresAt <= now()) {
      mappings.delete(key);
      return null;
    }
    return mapping;
  }

  async function handleTextMessage(payload = {}) {
    if (typeof isEnabled === "function" && !isEnabled()) return null;
    // Slice 3a consumes the text only for empty-message filtering. Slice 3b is
    // where sanitized prompt text will matter for delivery.
    const promptText = normalizePromptText(payload.text);
    if (!promptText) {
      return {
        status: "empty",
        text: "Send text as a reply to a Clawd completion notification.",
      };
    }

    const mapping = resolveMapping(payload.replyToMessageId);
    if (!mapping) {
      return {
        status: "unmapped",
        text: "Reply to a Clawd completion notification to choose the session.",
      };
    }

    const snapshot = typeof getSessionSnapshot === "function" ? getSessionSnapshot() : null;
    const entry = findSession(snapshot, mapping.sessionId);
    if (!entry) {
      safeLog("info", "direct-send fallback: session not live", { sessionId: mapping.sessionId });
      return {
        status: "session_not_live",
        sessionId: mapping.sessionId,
        text: "That session is no longer live on this computer.",
      };
    }

    if (hasInteractivePermissionPending(entry, getPendingPermissions)) {
      safeLog("info", "direct-send rejected: session waiting for permission", { sessionId: entry.id });
      return {
        status: "permission_pending",
        sessionId: entry.id,
        text: "That session appears to be waiting for a permission decision, so I did not focus it for direct send.",
      };
    }

    const focusTarget = getSessionFocusTarget(entry, { osPlatform });
    const localFocusable = isFocusableLocalHudSession(entry, { osPlatform });
    if (!localFocusable || focusTarget.type !== "terminal") {
      safeLog("info", "direct-send fallback: session not local terminal", {
        sessionId: entry.id,
        type: focusTarget.type || "none",
      });
      return {
        status: "not_focusable",
        sessionId: entry.id,
        text: "That session cannot be focused as a local terminal on this computer.",
      };
    }

    let focused = false;
    try {
      focused = typeof focusSession === "function"
        ? focusSession(entry.id, { requestSource: "telegram-direct-send", fallbackEntry: entry }) === true
        : false;
    } catch (err) {
      safeLog("warn", "direct-send focus threw", { sessionId: entry.id, error: err && err.message });
      focused = false;
    }

    if (!focused) {
      safeLog("info", "direct-send fallback: focus not confirmed by caller", { sessionId: entry.id });
      return {
        status: "focus_failed",
        sessionId: entry.id,
        text: "I could not focus that terminal session.",
      };
    }

    safeLog("info", "direct-send focus-only accepted", { sessionId: entry.id });
    return {
      status: "focused",
      sessionId: entry.id,
      text: `Focused session ${shortSessionId(entry.id)} on your computer. Direct Send is in focus-only dogfood mode; no text was pasted.`,
    };
  }

  return {
    registerCompletionNotification,
    handleTextMessage,
    _mappings: mappings,
  };
}

module.exports = {
  DEFAULT_MAPPING_TTL_MS,
  createTelegramDirectSend,
  normalizeMessageId,
  normalizePromptText,
};
