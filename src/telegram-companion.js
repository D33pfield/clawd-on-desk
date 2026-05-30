"use strict";

// R1a: Telegram "session finished" notifications.
//
// Driven off the session-snapshot fanout (main.js broadcastSessionSnapshot).
// The snapshot is the existing observer stream — single-direction, already
// fanned out to dashboard / HUD / hardware buddy. This module watches it for
// sessions that reach a done/interrupted badge on a completion event and
// pushes one short message per session to Telegram via the native runner.
//
// Design constraints (see docs/connections/audit-telegram-companion-...):
//   - The snapshot carries no `prev`, so dedupe state lives here.
//   - onSnapshot runs inside the synchronous updateSession broadcast path, so
//     it must be sync + fire sends without awaiting + never throw.
//   - The fanout re-broadcasts the same completion (ack, stale-cleanup, remote
//     Codex retention), so dedupe by `id:rawEvent:at` is mandatory.
//   - First snapshot only primes the dedupe map (no backlog re-ping on start).

// Scope limitation (R1a): only the "Stop" naming family is covered. Copilot
// CLI signals completion with `agentStop`, which deriveSessionBadge does NOT
// map to a done badge, so the desktop HUD badge never lights for it either —
// adding it here alone would do nothing (the badge gate below filters first).
// Covering Copilot needs a deriveSessionBadge change (affects desktop), tracked
// as a follow-up. See docs limitations note.
const COMPLETION_EVENTS = new Set([
  "Stop",
  "StopFailure",
  "ApiError",
  "event_msg:task_complete",
]);
const DONE_BADGES = new Set(["done", "interrupted"]);

const NOTIFICATION_LOCALES = Object.freeze({
  en: {
    session: "session",
    done: "done",
    interrupted: "interrupted",
    wrapStatus: (status) => `(${status})`,
  },
  zh: {
    session: "会话",
    done: "已完成",
    interrupted: "已中断",
    wrapStatus: (status) => `（${status}）`,
  },
  "zh-TW": {
    session: "工作階段",
    done: "已完成",
    interrupted: "已中斷",
    wrapStatus: (status) => `（${status}）`,
  },
  ko: {
    session: "세션",
    done: "완료",
    interrupted: "중단됨",
    wrapStatus: (status) => `(${status})`,
  },
  ja: {
    session: "セッション",
    done: "完了",
    interrupted: "中断",
    wrapStatus: (status) => `（${status}）`,
  },
});

function dedupeKey(entry) {
  const le = entry && entry.lastEvent;
  return `${entry.id}:${le ? le.rawEvent : ""}:${le ? le.at : ""}`;
}

function isCompletion(entry) {
  if (!entry || !DONE_BADGES.has(entry.badge)) return false;
  const le = entry.lastEvent;
  return !!(le && COMPLETION_EVENTS.has(le.rawEvent));
}

// cwd may be POSIX or Windows (remote hosts), so split on both separators.
function folderName(cwd) {
  if (!cwd) return "";
  const parts = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function shortId(id) {
  const s = String(id || "");
  return s.length > 6 ? s.slice(0, 6) : s;
}

function getNotificationLocale(lang) {
  return NOTIFICATION_LOCALES[lang] || NOTIFICATION_LOCALES.en;
}

// Privacy note: displayTitle is the same session title shown on the desktop
// HUD / tray (it can derive from the user's prompt first line via
// sessionTitle). R1a intentionally mirrors the desktop surface rather than
// over-restricting — the message carries the title + identity fields, but
// never transcript output. The Telegram carrier itself (screenshots /
// forwarding / server storage) is the only added exposure vs. the desktop.
function formatNotification(entry, options = {}) {
  if (!entry) return "";
  const locale = getNotificationLocale(options.lang);
  const interrupted = entry.badge === "interrupted";
  const icon = interrupted ? "⚠️" : "✅"; // ⚠️ / ✅
  const status = interrupted ? locale.interrupted : locale.done;
  const title = entry.displayTitle || (entry.id ? `${shortId(entry.id)}..` : locale.session);
  const meta = [];
  if (entry.agentId) meta.push(entry.agentId);
  const folder = folderName(entry.cwd);
  if (folder) meta.push(folder);
  if (entry.host) meta.push(entry.host);
  if (entry.id) meta.push(`#${shortId(entry.id)}`);
  const wrapStatus = typeof locale.wrapStatus === "function"
    ? locale.wrapStatus(status)
    : `(${status})`;
  const head = `${icon} ${title} ${wrapStatus}`;
  return meta.length ? `${head}\n${meta.join(" · ")}` : head; // " · "
}

function createTelegramCompanion({
  getClient,
  isEnabled,
  log = () => {},
  getLang = () => "en",
  formatText = null,
} = {}) {
  const lastNotified = new Map(); // id -> last dedupe key
  let primed = false;

  // log ultimately does a synchronous file write that can throw; these calls
  // run on the fire-and-forget async chain (outside the caller's sync
  // try/catch), so a throw here would become an unhandled rejection.
  function safeLog(level, message, meta) {
    try { log(level, message, meta); } catch {}
  }

  function onSnapshot(snapshot) {
    const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const enabled = typeof isEnabled === "function" ? !!isEnabled() : true;
    const priming = !primed;
    const seenIds = new Set();
    const toSend = [];

    for (const entry of sessions) {
      if (!entry || !entry.id) continue;
      seenIds.add(entry.id);
      if (!isCompletion(entry)) continue;
      const key = dedupeKey(entry);
      if (lastNotified.get(entry.id) === key) continue;
      // Record the key even when priming/disabled so toggling on later does
      // not backfill completions the user never asked to be notified about.
      lastNotified.set(entry.id, key);
      if (priming || !enabled) continue;
      toSend.push(entry);
    }

    // Forget sessions that dropped out of the snapshot so the map stays bounded
    // over long runs. A removed-then-reappearing session with an identical
    // event timestamp is the only re-notify edge, and stale-cleanup does not
    // resurrect ended sessions with the same `at`.
    for (const id of Array.from(lastNotified.keys())) {
      if (!seenIds.has(id)) lastNotified.delete(id);
    }

    primed = true;
    if (!toSend.length) return;

    const client = typeof getClient === "function" ? getClient() : null;
    if (!client || typeof client.sendNotification !== "function") return;

    for (const entry of toSend) {
      let lang = "en";
      try {
        const value = typeof getLang === "function" ? getLang() : "";
        if (typeof value === "string" && value) lang = value;
      } catch {}
      const text = typeof formatText === "function"
        ? formatText(entry, { lang })
        : formatNotification(entry, { lang });
      if (!text) continue;
      // Fire-and-forget: do NOT await — we are on the synchronous broadcast
      // path. sendNotification never throws, but guard anyway.
      Promise.resolve()
        .then(() => client.sendNotification(text))
        .then((res) => {
          if (res && res.ok === false) {
            safeLog("warn", "completion notification not delivered", {
              id: entry.id, errorClass: res.errorClass,
            });
          }
        })
        .catch((err) => {
          safeLog("warn", "completion notification threw", {
            id: entry.id, error: err && err.message,
          });
        });
    }
  }

  return {
    onSnapshot,
    _lastNotified: lastNotified,
  };
}

module.exports = {
  createTelegramCompanion,
  formatNotification,
  isCompletion,
  dedupeKey,
  COMPLETION_EVENTS,
};
