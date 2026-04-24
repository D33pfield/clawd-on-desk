"use strict";

const AGENT_LABELS = {
  "claude-code": "CC",
  codex: "Codex",
  "copilot-cli": "Copilot",
  "cursor-agent": "Cursor",
  "gemini-cli": "Gemini",
  "kiro-cli": "Kiro",
  "kimi-cli": "Kimi",
  opencode: "opencode",
  codebuddy: "CodeBuddy",
};

let snapshot = { sessions: [], orderedIds: [], hudTotalNonIdle: 0, hudLastTitle: null };
let i18nPayload = { lang: "en", translations: {} };

const dotEl = document.getElementById("dot");
const textEl = document.getElementById("text");

function t(key) {
  const dict = i18nPayload && i18nPayload.translations ? i18nPayload.translations : {};
  return dict[key] || key;
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return t("sessionJustNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sessionMinAgo").replace("{n}", min);
  const hr = Math.floor(min / 60);
  return t("sessionHrAgo").replace("{n}", hr);
}

function agentLabel(agentId) {
  return AGENT_LABELS[agentId] || agentId || t("dashboardUnknownAgent");
}

function titleFor(session) {
  return session.displayTitle || session.sessionTitle || session.id || "";
}

function orderedHudSessions(currentSnapshot) {
  const sessions = Array.isArray(currentSnapshot.sessions) ? currentSnapshot.sessions : [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const ids = Array.isArray(currentSnapshot.orderedIds)
    ? currentSnapshot.orderedIds
    : sessions.map((session) => session.id);
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const orderedIds = new Set(ordered.map((session) => session.id));
  const missing = sessions.filter((session) => !orderedIds.has(session.id));
  return ordered.concat(missing).filter((session) => session && !session.headless);
}

function setDot(badge) {
  dotEl.className = `dot dot-${badge || "idle"}`;
}

function render() {
  const sessions = orderedHudSessions(snapshot);
  if (!sessions.length) {
    setDot("idle");
    textEl.textContent = "";
    return;
  }

  if (sessions.length === 1) {
    const session = sessions[0];
    setDot(session.badge || "idle");
    textEl.textContent = [
      agentLabel(session.agentId),
      titleFor(session),
      formatElapsed(Date.now() - (Number(session.updatedAt) || Date.now())),
    ].filter(Boolean).join(" · ");
    return;
  }

  const activeCount = Number.isFinite(Number(snapshot.hudTotalNonIdle))
    ? Number(snapshot.hudTotalNonIdle)
    : sessions.filter((session) => session.state !== "idle" && session.state !== "sleeping").length;
  const latestTitle = snapshot.hudLastTitle || titleFor(sessions[0]);
  setDot(activeCount > 0 ? "running" : "idle");
  textEl.textContent = `${activeCount} · ${t("sessionHudLast")}: ${latestTitle}`;
}

async function init() {
  window.sessionHudAPI.onLangChange((payload) => {
    i18nPayload = payload || i18nPayload;
    render();
  });
  window.sessionHudAPI.onSessionSnapshot((nextSnapshot) => {
    snapshot = nextSnapshot || snapshot;
    render();
  });

  i18nPayload = await window.sessionHudAPI.getI18n() || i18nPayload;
  render();
  setInterval(render, 1000);
}

init().catch((err) => {
  textEl.textContent = err && err.message ? err.message : String(err);
});
