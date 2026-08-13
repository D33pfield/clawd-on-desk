// DeepSeek Harness monitor
// Polls the durable JSON side of the DeepSeek Harness web UI and derives Clawd
// state events. Zero external dependencies (node built-ins only).
//
// Data sources under $DSH_HOME (default ~/.dsh), both atomically rewritten by
// DSH (tmp + rename), so a reader never observes a torn file:
//   - storages/workspace.json           — workspace → sessionIds membership,
//                                         plus the global archivedSessionIds list
//   - storages/session_projcache.json   — per-session projection cache rows:
//                                         sessionStats (openStep + pendingCalls =
//                                         "the agent is doing work right now"),
//                                         sessionListMetadata.lastPromptAt (a fresh
//                                         value = the user just submitted a prompt),
//                                         title, and identity.cwd
//
// DSH writes the projection cache on a throttle (web profile: 200 events or
// 5 s since the first dirty event) plus mandatory turn/end and session-dispose
// checkpoints, so the monitor is sampling-based with seconds-level latency,
// never event-exact. A working state may take up to pollInterval + throttle to
// appear and the follow-up completion a similar time to clear.
//
// Failure behavior is fail-open: an unreadable or malformed file skips the
// poll round (previous per-session state is retained, nothing is ended); only
// a successfully parsed workspace listing that no longer contains a session
// ends it. When DSH is not installed or not running (no files), the monitor
// stays silent — no sessions, no transitions.
//
// Replay protection: sessions already present on the first poll are announced
// with SessionStart but their historical lastPromptAt is seeded, so an old
// prompt never replays as a fresh UserPromptSubmit.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_POLL_INTERVAL_MS = 1500;
const MAX_TRACKED_SESSIONS = 32;
const WORKSPACE_FILE = "workspace.json";
const PROJCACHE_FILE = "session_projcache.json";
// A cached openStep/pendingCalls older than this is treated as stale: DSH
// writes the projection cache at least once every writeIntervalMs (5 s in the
// web profile) while a step or tool call is in flight, so a cache that has not
// moved for this long proves the work signal is a leftover, not live work.
const WORKING_STALENESS_MS = 30 * 1000;

// ── pure helpers (exported for tests) ───────────────────────────────────────

function resolveDshHome(env = process.env) {
  const override = env && typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (override) return override;
  return path.join(os.homedir(), ".dsh");
}

function normalizeSessionId(value) {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (!id || id.length > 256 || /[\0\r\n]/.test(id)) return "";
  return id;
}

// workspace.json → { active: Set, archived: Set, sessionPaths: Map }
// Any structural problem returns an empty-but-valid document; callers treat an
// empty doc as "DSH offline" only when the file itself is unreadable, not when
// parsing yields nothing.
function parseWorkspaceFile(text) {
  const out = { active: new Set(), archived: new Set(), sessionPaths: new Map() };
  if (typeof text !== "string" || !text.trim()) return out;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  if (!doc || typeof doc !== "object") return out;
  const globalDoc = doc.global && typeof doc.global === "object" ? doc.global : null;
  const archived = globalDoc && Array.isArray(globalDoc.archivedSessionIds)
    ? globalDoc.archivedSessionIds
    : [];
  for (const id of archived) {
    const clean = normalizeSessionId(id);
    if (clean) out.archived.add(clean);
  }
  const tables = doc.tables && typeof doc.tables === "object" ? doc.tables : null;
  const workspaces = tables && typeof tables.workspaces === "object" ? tables.workspaces : null;
  if (!workspaces) return out;
  for (const key of Object.keys(workspaces)) {
    const workspace = workspaces[key];
    if (!workspace || typeof workspace !== "object") continue;
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
    const workspacePath = typeof workspace.path === "string" ? workspace.path : "";
    for (const rawId of sessionIds) {
      const id = normalizeSessionId(rawId);
      if (!id || out.archived.has(id)) continue;
      out.active.add(id);
      if (workspacePath && !out.sessionPaths.has(id)) out.sessionPaths.set(id, workspacePath);
    }
  }
  return out;
}

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTitleText(value) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text : null;
}

// session_projcache.json → Map<sessionId, entry> where entry is
//   { cwd, title, openStep, pendingCallCount, lastPromptAt, seq }
function parseProjcacheFile(text) {
  const out = new Map();
  if (typeof text !== "string" || !text.trim()) return out;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  if (!doc || typeof doc !== "object") return out;
  const tables = doc.tables && typeof doc.tables === "object" ? doc.tables : null;
  const sessions = tables && typeof tables.sessions === "object" ? tables.sessions : null;
  if (!sessions) return out;
  for (const rawId of Object.keys(sessions)) {
    const id = normalizeSessionId(rawId);
    if (!id) continue;
    const record = sessions[rawId];
    if (!record || typeof record !== "object") continue;
    const identity = record.identity && typeof record.identity === "object" ? record.identity : null;
    const rows = record.rows && typeof record.rows === "object" ? record.rows : null;
    if (!rows) continue;
    const entry = {
      cwd: identity && typeof identity.cwd === "string" ? identity.cwd : "",
      title: null,
      openStep: false,
      pendingCallCount: 0,
      lastPromptAt: 0,
      seq: 0,
    };
    const stats = rows.sessionStats && typeof rows.sessionStats === "object"
      ? rows.sessionStats.val
      : null;
    if (stats && typeof stats === "object") {
      entry.openStep = stats.openStep !== null && stats.openStep !== undefined;
      if (stats.pendingCalls && typeof stats.pendingCalls === "object") {
        entry.pendingCallCount = Object.keys(stats.pendingCalls).length;
      }
      entry.seq = toFiniteNumber(stats.seq) ?? 0;
    }
    const listMeta = rows.sessionListMetadata && typeof rows.sessionListMetadata === "object"
      ? rows.sessionListMetadata.val
      : null;
    if (listMeta && typeof listMeta === "object") {
      entry.lastPromptAt = toPositiveNumber(listMeta.lastPromptAt) ?? 0;
    }
    const titleRow = rows.title && typeof rows.title === "object" ? rows.title.val : null;
    entry.title = normalizeTitleText(titleRow);
    out.set(id, entry);
  }
  return out;
}

function createEmptyMonitorState() {
  return {
    known: new Set(),
    lastPromptAt: new Map(),
    lastState: new Map(),
    lastTitle: new Map(),
    lastCwd: new Map(),
  };
}

// Derive the transitions between one poll snapshot and the previous one.
// workspaceDoc / projcacheDoc are the RAW FILE TEXTS (parsing happens here so
// callers and tests exercise the same path). Returns { transitions, next }.
// A transition is { sessionId, kind: "start"|"end"|"update", state, event, title, cwd }.
function deriveTransitions(workspaceText, projcacheText, previous, options = {}) {
  const maxSessions = Number.isFinite(Number(options.maxSessions))
    ? Math.max(1, Math.floor(Number(options.maxSessions)))
    : MAX_TRACKED_SESSIONS;
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();
  // When the projection cache has not been rewritten recently, its cached
  // openStep/pendingCalls are leftovers (DSH flushed them, or shut down with
  // them pending) and must not keep a session stuck in working.
  const workFresh = !Number.isFinite(Number(options.projcacheMtimeMs))
    || nowMs - Number(options.projcacheMtimeMs) <= WORKING_STALENESS_MS;
  const workspace = parseWorkspaceFile(workspaceText);
  const projcache = parseProjcacheFile(projcacheText);
  const prev = previous && typeof previous === "object" ? previous : createEmptyMonitorState();
  const next = {
    known: new Set(prev.known),
    lastPromptAt: new Map(prev.lastPromptAt),
    lastState: new Map(prev.lastState),
    lastTitle: new Map(prev.lastTitle),
    lastCwd: new Map(prev.lastCwd),
  };
  const transitions = [];
  const previousKnown = new Set(prev.known);

  // 1. Ended sessions: present in the previous listing, absent now. Only a
  //    successfully parsed listing may end sessions — the caller skips the
  //    whole round when the workspace file is unreadable.
  for (const id of previousKnown) {
    if (workspace.active.has(id)) continue;
    transitions.push({
      sessionId: id,
      kind: "end",
      state: "idle",
      event: "SessionEnd",
      title: next.lastTitle.get(id) || null,
      cwd: next.lastCwd.get(id) || "",
    });
    next.known.delete(id);
    next.lastPromptAt.delete(id);
    next.lastState.delete(id);
    next.lastTitle.delete(id);
    next.lastCwd.delete(id);
  }

  // 2. New sessions: announce idle, seed the prompt watermark so historical
  //    prompts never replay as fresh submissions.
  for (const id of workspace.active) {
    if (previousKnown.has(id)) continue;
    if (next.known.size >= maxSessions) continue;
    const entry = projcache.get(id);
    const cwd = (entry && entry.cwd) || workspace.sessionPaths.get(id) || "";
    next.known.add(id);
    next.lastPromptAt.set(id, (entry && entry.lastPromptAt) || 0);
    next.lastState.set(id, "idle");
    next.lastTitle.set(id, (entry && entry.title) || null);
    next.lastCwd.set(id, cwd);
    transitions.push({
      sessionId: id,
      kind: "start",
      state: "idle",
      event: "SessionStart",
      title: (entry && entry.title) || null,
      cwd,
    });
  }

  // 3. State updates for sessions tracked in a PREVIOUS round (a session
  //    announced in this round was seeded above and must not also replay its
  //    historical prompt as a fresh submission).
  for (const id of workspace.active) {
    if (!previousKnown.has(id) || !next.known.has(id)) continue;
    const entry = projcache.get(id);
    if (!entry) continue; // projection not written yet — keep previous state
    const previousPromptAt = prev.lastPromptAt.get(id) || 0;
    const previousState = prev.lastState.get(id) || "idle";
    const cwd = entry.cwd || next.lastCwd.get(id) || "";
    const title = entry.title;

    let state = null;
    let event = null;
    if (entry.lastPromptAt > previousPromptAt) {
      // A fresh lastPromptAt is the durable "user just submitted a prompt"
      // watermark (DSH bumps it on human input, never on agent-internal work).
      state = "thinking";
      event = "UserPromptSubmit";
    } else if (workFresh && (entry.openStep || entry.pendingCallCount > 0)) {
      // An open LLM step or an unresolved tool call = the agent is working —
      // but only while the projection cache is demonstrably being written.
      state = "working";
      event = "PreToolUse";
    } else if (previousState === "thinking" || previousState === "working") {
      // Work stopped and no new prompt arrived: the turn completed.
      state = "attention";
      event = "Stop";
    }

    next.lastPromptAt.set(id, entry.lastPromptAt);
    next.lastCwd.set(id, cwd);
    if (title !== null) next.lastTitle.set(id, title);
    if (state !== null) {
      next.lastState.set(id, state);
      transitions.push({
        sessionId: id,
        kind: "update",
        state,
        event,
        title: title !== null ? title : next.lastTitle.get(id) || null,
        cwd,
      });
    }
  }

  return { transitions, next };
}

// ── monitor class ───────────────────────────────────────────────────────────

class DeepSeekHarnessMonitor {
  /**
   * @param {object} agentConfig - deepseek-harness.js config
   * @param {function} onStateChange - (sessionId, state, event, extra) => void
   * @param {object} options - { pollIntervalMs, dshHome, fsImpl, now, derive, maxSessions }
   */
  constructor(agentConfig, onStateChange, options = {}) {
    this._config = agentConfig;
    this._onStateChange = typeof onStateChange === "function" ? onStateChange : () => {};
    this._pollIntervalMs = Number.isFinite(Number(options.pollIntervalMs))
      && Number(options.pollIntervalMs) > 0
      ? Number(options.pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS;
    this._dshHome = typeof options.dshHome === "string" && options.dshHome
      ? options.dshHome
      : resolveDshHome();
    this._fs = options.fsImpl || fs;
    this._now = typeof options.now === "function" ? options.now : Date.now;
    this._derive = typeof options.derive === "function" ? options.derive : deriveTransitions;
    this._maxSessions = options.maxSessions;
    this._interval = null;
    this._state = createEmptyMonitorState();
    this._startedAtMs = null;
  }

  get dshHome() {
    return this._dshHome;
  }

  _storagesDir() {
    return path.join(this._dshHome, "storages");
  }

  _readFile(name) {
    try {
      const text = this._fs.readFileSync(path.join(this._storagesDir(), name), "utf8");
      return typeof text === "string" ? text : "";
    } catch {
      return null;
    }
  }

  _fileMtimeMs(name) {
    try {
      const stat = this._fs.statSync(path.join(this._storagesDir(), name));
      return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
    } catch {
      return null;
    }
  }

  start() {
    if (this._interval) return;
    this._startedAtMs = this._now();
    this._poll();
    this._interval = setInterval(() => this._poll(), this._pollIntervalMs);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._state = createEmptyMonitorState();
  }

  // One poll round. Workspace unreadable/malformed → skip the whole round
  // (nothing ends, nothing starts). Projcache problems degrade per-session:
  // a session without a cached projection keeps its previous state.
  _poll() {
    const workspaceText = this._readFile(WORKSPACE_FILE);
    if (workspaceText === null) return; // DSH offline / not installed yet
    const projcacheText = this._readFile(PROJCACHE_FILE);
    const { transitions, next } = this._derive(
      workspaceText,
      projcacheText === null ? "" : projcacheText,
      this._state,
      {
        maxSessions: this._maxSessions,
        projcacheMtimeMs: this._fileMtimeMs(PROJCACHE_FILE),
        now: this._now,
      }
    );
    this._state = next;
    for (const transition of transitions) {
      this._emit(transition);
    }
  }

  _emit(transition) {
    const extra = {
      agentId: this._config.id,
      platform: "webui",
    };
    if (transition.title) extra.sessionTitle = transition.title;
    if (transition.cwd) extra.cwd = transition.cwd;
    this._onStateChange(transition.sessionId, transition.state, transition.event, extra);
  }
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  MAX_TRACKED_SESSIONS,
  PROJCACHE_FILE,
  WORKING_STALENESS_MS,
  WORKSPACE_FILE,
  DeepSeekHarnessMonitor,
  createEmptyMonitorState,
  deriveTransitions,
  normalizeSessionId,
  normalizeTitleText,
  parseProjcacheFile,
  parseWorkspaceFile,
  resolveDshHome,
};
