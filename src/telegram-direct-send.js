"use strict";

const { execFile: defaultExecFile } = require("child_process");
const {
  getSessionFocusTarget,
  isFocusableLocalHudSession,
} = require("./session-focus");

const DEFAULT_MAPPING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REPLY_TEXT = 3800;
const DEFAULT_MAX_DELIVERIES = 100;
const WINDOWS_PASTE_RESTORE_DELAY_MS = 800;
const WINDOWS_PASTE_TIMEOUT_MS = 1500;
const DELIVERY_STATUSES = new Set([
  "focus_only",
  "sent_with_enter",
  "pasted_without_enter",
  "fallback_copied",
  "failed",
]);

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

function normalizeFocusGateResult(value) {
  if (value && typeof value === "object") {
    return {
      reason: typeof value.reason === "string" && value.reason ? value.reason : "unknown",
      token: typeof value.token === "string" && value.token ? value.token : null,
      targetHwnd: value.targetHwnd || null,
      foregroundHwnd: value.foregroundHwnd || null,
      confirmed: value.confirmed === true,
      status: value.confirmed === true ? "confirmed" : "unconfirmed",
    };
  }
  return {
    reason: value === true ? "legacy-focus-without-result" : "focus-not-submitted",
    token: null,
    targetHwnd: null,
    foregroundHwnd: null,
    confirmed: false,
    status: "unconfirmed",
  };
}

function createFocusOnlyDeliveryAdapter() {
  return {
    deliver: async () => ({
      status: "focus_only",
      delivered: false,
      errorClass: "delivery_not_implemented",
    }),
  };
}

function buildWindowsPasteShortcutScript() {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ClawdPasteKeys {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[ClawdPasteKeys]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[ClawdPasteKeys]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
[ClawdPasteKeys]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
[ClawdPasteKeys]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
`;
}

function execFileAsync(execFile, command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function createWindowsPasteOnlyDeliveryAdapter({
  clipboard,
  execFile = defaultExecFile,
  osPlatform = process.platform,
  restoreDelayMs = WINDOWS_PASTE_RESTORE_DELAY_MS,
  timeoutMs = WINDOWS_PASTE_TIMEOUT_MS,
  delay = defaultDelay,
} = {}) {
  return {
    async deliver(payload = {}) {
      const promptText = typeof payload.promptText === "string" ? payload.promptText : "";
      if (osPlatform !== "win32") {
        return { status: "failed", delivered: false, errorClass: "platform_unsupported" };
      }
      if (!payload.focusResult || payload.focusResult.confirmed !== true) {
        return { status: "failed", delivered: false, errorClass: "focus_unconfirmed" };
      }
      if (!promptText) {
        return { status: "failed", delivered: false, errorClass: "empty_prompt" };
      }
      if (promptText.includes("\n")) {
        return { status: "failed", delivered: false, errorClass: "multiline_unsupported" };
      }
      if (!clipboard || typeof clipboard.writeText !== "function") {
        return { status: "failed", delivered: false, errorClass: "clipboard_unavailable" };
      }

      let previousText = null;
      let canRestore = false;
      if (typeof clipboard.readText === "function") {
        try {
          previousText = clipboard.readText();
          canRestore = typeof previousText === "string";
        } catch {}
      }

      try {
        clipboard.writeText(promptText);
      } catch {
        return { status: "failed", delivered: false, errorClass: "clipboard_write_failed" };
      }

      try {
        await execFileAsync(execFile, "powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          buildWindowsPasteShortcutScript(),
        ], {
          windowsHide: true,
          timeout: timeoutMs,
          encoding: "utf8",
        });
      } catch {
        if (canRestore) {
          try { clipboard.writeText(previousText); } catch {}
        }
        return { status: "failed", delivered: false, errorClass: "paste_shortcut_failed" };
      }

      let errorClass = null;
      if (canRestore) {
        try {
          await delay(restoreDelayMs);
          clipboard.writeText(previousText);
        } catch {
          errorClass = "clipboard_restore_failed";
        }
      }

      return {
        status: "pasted_without_enter",
        delivered: true,
        autoEnter: false,
        errorClass,
      };
    },
  };
}

function normalizeDeliveryStatus(value) {
  const status = typeof value === "string" ? value : "";
  return DELIVERY_STATUSES.has(status) ? status : "failed";
}

function normalizeDeliveryResult(value) {
  if (value && typeof value === "object") {
    const status = normalizeDeliveryStatus(value.status);
    return {
      status,
      delivered: value.delivered === true || status === "sent_with_enter" || status === "pasted_without_enter",
      autoEnter: value.autoEnter === true,
      errorClass: typeof value.errorClass === "string" && value.errorClass
        ? value.errorClass.replace(/[\r\n\t]+/g, " ").slice(0, 80)
        : null,
    };
  }
  return {
    status: "failed",
    delivered: false,
    autoEnter: false,
    errorClass: "invalid_delivery_result",
  };
}

async function invokeDeliveryAdapter(deliveryAdapter, payload) {
  const adapter = deliveryAdapter || createFocusOnlyDeliveryAdapter();
  if (typeof adapter === "function") return adapter(payload);
  if (adapter && typeof adapter.deliver === "function") return adapter.deliver(payload);
  return { status: "failed", delivered: false, errorClass: "delivery_adapter_missing" };
}

function formatDeliveryAck(status, entry, deliveryResult) {
  const shortId = shortSessionId(entry && entry.id);
  switch (status) {
    case "sent_with_enter":
      return `Sent to terminal for session ${shortId}.`;
    case "pasted_without_enter":
      return `Pasted text into session ${shortId}; press Enter locally to send it.`;
    case "fallback_copied":
      return `Direct Send fell back for session ${shortId}. Use the local fallback to finish sending.`;
    case "failed":
      return "Direct Send failed after focus confirmation. No text was pasted.";
    case "focus_only":
    default:
      if (deliveryResult && deliveryResult.errorClass === "delivery_not_implemented") {
        return `Focused session ${shortId} on your computer. Direct Send is in focus-only dogfood mode; no text was pasted.`;
      }
      return `Focused session ${shortId} on your computer. Direct Send did not send text.`;
  }
}

function createTelegramDirectSend({
  getSessionSnapshot,
  getPendingPermissions,
  focusSession,
  deliveryAdapter = createFocusOnlyDeliveryAdapter(),
  isEnabled = () => false,
  now = () => Date.now(),
  mappingTtlMs = DEFAULT_MAPPING_TTL_MS,
  maxDeliveries = DEFAULT_MAX_DELIVERIES,
  osPlatform = process.platform,
  log = () => {},
} = {}) {
  const mappings = new Map(); // Telegram completion message id -> { sessionId, expiresAt }
  const deliveries = new Map(); // delivery id -> in-memory prompt delivery entry
  let deliverySeq = 0;

  function safeLog(level, message, meta) {
    try { log(level, message, meta); } catch {}
  }

  function nextDeliveryId() {
    deliverySeq += 1;
    return `tds-${now().toString(36)}-${deliverySeq.toString(36)}`;
  }

  function pruneDeliveries() {
    const limit = Math.max(1, Number.isFinite(maxDeliveries) ? Math.floor(maxDeliveries) : DEFAULT_MAX_DELIVERIES);
    while (deliveries.size > limit) {
      const firstKey = deliveries.keys().next().value;
      if (!firstKey) break;
      deliveries.delete(firstKey);
    }
  }

  function createDeliveryEntry(payload, promptText) {
    const ts = now();
    const entry = {
      id: nextDeliveryId(),
      promptText,
      chatId: payload.chatId != null ? String(payload.chatId) : null,
      fromId: payload.fromId != null ? String(payload.fromId) : null,
      telegramMessageId: normalizeMessageId(payload.messageId) || null,
      replyToMessageId: normalizeMessageId(payload.replyToMessageId) || null,
      sessionId: null,
      agentId: null,
      status: "received",
      errorClass: null,
      focusResult: null,
      deliveryResult: null,
      createdAt: ts,
      updatedAt: ts,
      statusHistory: [{ status: "received", at: ts }],
    };
    deliveries.set(entry.id, entry);
    pruneDeliveries();
    return entry;
  }

  function updateDeliveryEntry(deliveryEntry, status, patch = {}) {
    if (!deliveryEntry) return null;
    const nextStatus = typeof status === "string" && status ? status : deliveryEntry.status;
    deliveryEntry.status = nextStatus;
    deliveryEntry.updatedAt = now();
    deliveryEntry.statusHistory.push({ status: nextStatus, at: deliveryEntry.updatedAt });
    Object.assign(deliveryEntry, patch);
    return deliveryEntry;
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
    const promptText = normalizePromptText(payload.text);
    if (!promptText) {
      return {
        status: "empty",
        text: "Send text as a reply to a Clawd completion notification.",
      };
    }

    const deliveryEntry = createDeliveryEntry(payload, promptText);

    const mapping = resolveMapping(payload.replyToMessageId);
    if (!mapping) {
      updateDeliveryEntry(deliveryEntry, "unmapped", { errorClass: "completion_mapping_missing" });
      return {
        status: "unmapped",
        deliveryId: deliveryEntry.id,
        text: "Reply to a Clawd completion notification to choose the session.",
      };
    }

    const snapshot = typeof getSessionSnapshot === "function" ? getSessionSnapshot() : null;
    const entry = findSession(snapshot, mapping.sessionId);
    if (!entry) {
      safeLog("info", "direct-send fallback: session not live", { sessionId: mapping.sessionId });
      updateDeliveryEntry(deliveryEntry, "session_not_live", {
        sessionId: mapping.sessionId,
        errorClass: "session_not_live",
      });
      return {
        status: "session_not_live",
        sessionId: mapping.sessionId,
        deliveryId: deliveryEntry.id,
        text: "That session is no longer live on this computer.",
      };
    }

    updateDeliveryEntry(deliveryEntry, "target_resolved", {
      sessionId: entry.id,
      agentId: entry.agentId || null,
    });

    if (hasInteractivePermissionPending(entry, getPendingPermissions)) {
      safeLog("info", "direct-send rejected: session waiting for permission", { sessionId: entry.id });
      updateDeliveryEntry(deliveryEntry, "permission_pending", { errorClass: "permission_pending" });
      return {
        status: "permission_pending",
        sessionId: entry.id,
        deliveryId: deliveryEntry.id,
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
      updateDeliveryEntry(deliveryEntry, "not_focusable", {
        errorClass: "not_focusable_terminal",
      });
      return {
        status: "not_focusable",
        sessionId: entry.id,
        deliveryId: deliveryEntry.id,
        text: "That session cannot be focused as a local terminal on this computer.",
      };
    }

    let focusResult;
    try {
      updateDeliveryEntry(deliveryEntry, "focus_requested");
      const rawFocusResult = typeof focusSession === "function"
        ? await focusSession(entry.id, { requestSource: "telegram-direct-send", fallbackEntry: entry })
        : false;
      focusResult = normalizeFocusGateResult(rawFocusResult);
    } catch (err) {
      safeLog("warn", "direct-send focus threw", { sessionId: entry.id, error: err && err.message });
      focusResult = normalizeFocusGateResult({ reason: "focus-threw", confirmed: false });
    }

    if (!focusResult.confirmed) {
      safeLog("info", "direct-send fallback: focus result unconfirmed", {
        sessionId: entry.id,
        reason: focusResult.reason,
      });
      updateDeliveryEntry(deliveryEntry, "focus_unconfirmed", {
        focusResult,
        errorClass: "focus_unconfirmed",
      });
      return {
        status: "focus_unconfirmed",
        sessionId: entry.id,
        deliveryId: deliveryEntry.id,
        focusResult,
        text: "I could not confirm that terminal was foregrounded. Direct Send stayed in focus-only fallback; no text was pasted.",
      };
    }

    updateDeliveryEntry(deliveryEntry, "focus_confirmed", { focusResult });

    let deliveryResult;
    try {
      updateDeliveryEntry(deliveryEntry, "delivery_attempted");
      deliveryResult = normalizeDeliveryResult(await invokeDeliveryAdapter(deliveryAdapter, {
        deliveryId: deliveryEntry.id,
        promptText,
        sessionId: entry.id,
        agentId: entry.agentId || null,
        entry,
        focusResult,
        autoEnter: false,
      }));
    } catch (err) {
      safeLog("warn", "direct-send delivery adapter threw", {
        sessionId: entry.id,
        errorClass: "delivery_adapter_threw",
      });
      deliveryResult = normalizeDeliveryResult({
        status: "failed",
        delivered: false,
        errorClass: "delivery_adapter_threw",
      });
    }

    const resultStatus = deliveryResult.status === "focus_only"
      ? "focused"
      : deliveryResult.status;
    updateDeliveryEntry(deliveryEntry, resultStatus, {
      deliveryResult,
      errorClass: deliveryResult.errorClass,
    });

    safeLog("info", "direct-send delivery result", {
      sessionId: entry.id,
      status: resultStatus,
      reason: focusResult.reason,
      errorClass: deliveryResult.errorClass || undefined,
    });
    return {
      status: resultStatus,
      sessionId: entry.id,
      deliveryId: deliveryEntry.id,
      focusResult,
      deliveryResult,
      text: formatDeliveryAck(deliveryResult.status, entry, deliveryResult),
    };
  }

  return {
    registerCompletionNotification,
    handleTextMessage,
    _mappings: mappings,
    _deliveries: deliveries,
  };
}

module.exports = {
  DEFAULT_MAPPING_TTL_MS,
  DEFAULT_MAX_DELIVERIES,
  createTelegramDirectSend,
  createFocusOnlyDeliveryAdapter,
  createWindowsPasteOnlyDeliveryAdapter,
  buildWindowsPasteShortcutScript,
  normalizeMessageId,
  normalizeDeliveryResult,
  normalizePromptText,
};
