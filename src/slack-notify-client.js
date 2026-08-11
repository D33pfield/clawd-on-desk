"use strict";

// One-way Slack notifier. Unlike the Feishu approval client this holds NO
// persistent connection: Incoming Webhooks (and chat.postMessage) are stateless
// HTTP, so the "client" just reads the current config/secrets on each send.
//
// It plugs into two existing seams:
//   - onSnapshot(snapshot): driven off main.js broadcastSessionSnapshot, same as
//     the Telegram companion — one ping per session that reaches a done/
//     interrupted badge on a completion event (deduped by id:rawEvent:at).
//   - notifyPermissionRequest(payload): a read-only heads-up when a gated tool
//     needs approval. Slack cannot resolve the approval here (that needs Socket
//     Mode); `supportsApproval` is the flag a future interactive client flips.
//
// Every path is best-effort: sends are fire-and-forget on the sync broadcast
// path, never throw, and degrade to { ok: false, errorClass } when unconfigured
// or when the network fails.

const settings = require("./slack-notify-settings");
const {
  buildCompletionMessage,
  buildPermissionMessage,
  buildTestMessage,
} = require("./slack-message-format");

const DONE_BADGES = new Set(["done", "interrupted"]);
const COMPLETION_EVENTS = new Set(["Stop", "StopFailure", "ApiError", "event_msg:task_complete"]);
const CHAT_POST_URL = "https://slack.com/api/chat.postMessage";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_QUEUE = 50;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30000;

// Retry only what can plausibly succeed later. A revoked webhook (404) or a
// rejected token (401/403) will fail identically forever, so retrying it just
// burns requests and delays the queue behind it.
const RETRYABLE_ERROR_CLASSES = new Set(["rate-limited", "network", "timeout", "no-transport"]);

function isRetryableErrorClass(errorClass) {
  if (!errorClass) return false;
  if (RETRYABLE_ERROR_CLASSES.has(errorClass)) return true;
  // http-5xx: the server is having a bad time, not the request.
  const m = /^http-(\d{3})$/.exec(errorClass);
  return !!m && Number(m[1]) >= 500;
}

// Slack sends Retry-After in seconds on 429. Honour it instead of guessing, and
// clamp so a hostile or bogus value cannot park the queue for hours.
function retryAfterMsFrom(headers, maxDelayMs) {
  if (!headers || typeof headers.get !== "function") return 0;
  let raw = null;
  try { raw = headers.get("retry-after"); } catch { return 0; }
  const seconds = Number(String(raw || "").trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds * 1000, maxDelayMs);
}

function dedupeKey(entry) {
  const le = entry && entry.lastEvent;
  return `${entry.id}:${le ? le.rawEvent : ""}:${le ? le.at : ""}`;
}

function isCompletion(entry) {
  if (!entry || !DONE_BADGES.has(entry.badge)) return false;
  const le = entry.lastEvent;
  return !!(le && COMPLETION_EVENTS.has(le.rawEvent));
}

function classifyHttpStatus(status) {
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  return `http-${status}`;
}

// Last line of defence before the payload leaves the process.
//
// The formatter redacts what it renders, but only sendMessage knows the
// *currently configured* credentials, and only here is the complete body
// visible. A webhook URL is a bearer credential for the very channel Clawd is
// posting to, so a value that slipped through an unsanitised field — or a
// future caller that builds its own message — would publish the key to the
// people it protects against. Substring replacement over the serialised body
// catches it wherever it sits, including nested blocks and attachments.
//
// The credential is still used to address/authenticate the request; only the
// body is scrubbed.
function scrubCredentials(body, secrets) {
  const source = secrets && typeof secrets === "object" ? secrets : {};
  // Short values would risk mangling ordinary text; real credentials are long.
  const values = [source.webhookUrl, source.botToken].filter((v) => typeof v === "string" && v.length >= 12);
  if (!values.length) return body;
  let json = JSON.stringify(body);
  if (!json) return body;
  let touched = false;
  for (const value of values) {
    if (!json.includes(value)) continue;
    json = json.split(value).join("<redacted:slack-credential>");
    touched = true;
  }
  if (!touched) return body;
  try { return JSON.parse(json); } catch { return body; }
}

function createSlackNotifyClient({
  getConfig = () => settings.cloneDefaultSlackNotify(),
  getSecrets = () => ({ webhookUrl: "", botToken: "" }),
  getLang = () => "en",
  log = () => {},
  fetchImpl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  // Delivery limits are explicit rather than implied, so the failure mode of a
  // wedged or rate-limited Slack is "bounded and logged", not "unbounded memory
  // and a request storm".
  maxQueue = DEFAULT_MAX_QUEUE,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
  sleepImpl = null,
} = {}) {
  // `lastNotified` means "settled" — delivered, or given up on after bounded
  // retries. `inFlightKeys` is the separate in-flight/pending state: an event
  // that is queued but not yet settled must not be enqueued twice by a repeat
  // snapshot, and must not be recorded as sent if delivery then fails.
  const lastNotified = new Map(); // session id -> last settled dedupe key
  const inFlightKeys = new Set();
  const queue = [];
  let draining = null;
  let primed = false;

  function safeLog(level, message, meta) {
    try { log(level, message, meta); } catch {}
  }

  function readConfig() {
    try { return settings.normalizeSlackNotify(getConfig()); } catch { return settings.cloneDefaultSlackNotify(); }
  }
  function readSecrets() {
    try {
      const value = getSecrets() || {};
      return { webhookUrl: value.webhookUrl || "", botToken: value.botToken || "" };
    } catch {
      return { webhookUrl: "", botToken: "" };
    }
  }
  function readLang() {
    try {
      const value = getLang();
      return typeof value === "string" && value ? value : "en";
    } catch { return "en"; }
  }

  function isEnabled() {
    return readConfig().enabled === true;
  }

  function describeReadiness() {
    return settings.readiness(readConfig(), readSecrets());
  }

  function isReady() {
    return describeReadiness().ready === true;
  }

  function getStatus() {
    const config = readConfig();
    const secrets = readSecrets();
    const ready = settings.readiness(config, secrets);
    return {
      enabled: config.enabled === true,
      configured: !!(secrets.webhookUrl || secrets.botToken),
      ready: ready.ready === true,
      reason: ready.ready ? "ready" : ready.reason,
      transport: ready.transport || null,
      supportsApproval,
    };
  }

  function resolveFetch() {
    if (typeof fetchImpl === "function") return fetchImpl;
    if (typeof fetch === "function") return fetch;
    return null;
  }

  async function postJson(url, headers, bodyObject) {
    const doFetch = resolveFetch();
    if (!doFetch) return { ok: false, errorClass: "no-transport" };
    let controller = null;
    let timer = null;
    if (typeof AbortController === "function" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    }
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", ...headers },
        body: JSON.stringify(bodyObject),
        // The webhook host is pinned to hooks.slack.com, but a redirect would
        // let the response move the request (and, for the bot transport, the
        // Authorization header) to an arbitrary host. Slack never redirects
        // these endpoints, so treat one as a hard failure instead of following.
        redirect: "error",
        signal: controller ? controller.signal : undefined,
      });
      const status = res && typeof res.status === "number" ? res.status : 0;
      let bodyText = "";
      try { bodyText = typeof res.text === "function" ? await res.text() : ""; } catch { bodyText = ""; }
      return {
        ok: !!(res && res.ok),
        status,
        bodyText,
        retryAfterMs: retryAfterMsFrom(res && res.headers, maxRetryDelayMs),
      };
    } catch (err) {
      const aborted = err && (err.name === "AbortError" || err.code === "ABORT_ERR");
      return { ok: false, errorClass: aborted ? "timeout" : "network", error: err && err.message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Send a { text, blocks } message via whichever transport the config resolves
  // to. Returns { ok, errorClass?, messageId? } and never throws.
  async function sendMessage(message) {
    if (!message || (!message.text && !Array.isArray(message.blocks))) {
      return { ok: false, errorClass: "empty-message" };
    }
    const config = readConfig();
    const secrets = readSecrets();
    // Deliberately the transport check, not readiness: readiness also requires
    // the enable switch, and Send Test has to work while you are still setting
    // things up. The automatic senders (onSnapshot, notifyPermissionRequest)
    // each check `enabled` themselves, so the switch still means something.
    const state = settings.describeTransport(config, secrets);
    if (!state.transport) return { ok: false, errorClass: state.reason || "not-configured" };
    const ready = { transport: state.transport };

    // Slack unfurls links by default: its servers fetch every URL a message
    // contains and pull the title/preview back into the channel. Agent output is
    // exactly the LLM-derived URL case Slack's security guidance warns about, so
    // both transports opt out.
    const payload = scrubCredentials(
      { text: message.text, blocks: message.blocks, unfurl_links: false, unfurl_media: false },
      secrets,
    );

    if (ready.transport === "webhook") {
      const res = await postJson(secrets.webhookUrl, {}, payload);
      if (res.errorClass) return { ok: false, errorClass: res.errorClass, error: res.error };
      // Incoming webhooks answer 200 with the literal body "ok" on success.
      if (res.ok && (!res.bodyText || res.bodyText.trim() === "ok")) return { ok: true };
      if (res.ok) return { ok: true };
      return {
        ok: false,
        errorClass: classifyHttpStatus(res.status),
        retryAfterMs: res.retryAfterMs,
        detail: (res.bodyText || "").slice(0, 200),
      };
    }

    // Bot transport: chat.postMessage. Errors surface in the JSON body, not the
    // HTTP status, so a 200 with { ok: false } is still a failure.
    const res = await postJson(
      CHAT_POST_URL,
      { authorization: `Bearer ${secrets.botToken}` },
      { channel: config.channelId, ...payload },
    );
    if (res.errorClass) return { ok: false, errorClass: res.errorClass, error: res.error };
    let parsed = null;
    try { parsed = res.bodyText ? JSON.parse(res.bodyText) : null; } catch { parsed = null; }
    if (parsed && parsed.ok === true) return { ok: true, messageId: parsed.ts };
    if (parsed && parsed.ok === false) return { ok: false, errorClass: `slack-${parsed.error || "error"}` };
    if (!res.ok) return { ok: false, errorClass: classifyHttpStatus(res.status), retryAfterMs: res.retryAfterMs };
    return { ok: false, errorClass: "bad-response" };
  }


  function sleep(ms) {
    if (typeof sleepImpl === "function") return sleepImpl(ms);
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
  }

  // An event is settled once it has been delivered, or once we have given up on
  // it after bounded retries. Recording it either way is what stops a
  // permanently failing send from being re-enqueued by every later snapshot.
  function settle(item, outcome, meta) {
    inFlightKeys.delete(item.key);
    lastNotified.set(item.id, item.key);
    if (outcome !== "sent") safeLog("warn", `slack completion ${outcome}`, { id: item.id, ...meta });
  }

  function enqueueCompletion(id, key, message) {
    if (inFlightKeys.has(key)) return; // already queued or in flight
    if (queue.length >= maxQueue) {
      // Drop the oldest: a backlog means Slack is unavailable, and the newest
      // completion is the one the user still cares about. Never silently.
      const dropped = queue.shift();
      inFlightKeys.delete(dropped.key);
      lastNotified.set(dropped.id, dropped.key);
      safeLog("warn", "slack queue full, dropped oldest notification", { id: dropped.id, maxQueue });
    }
    queue.push({ id, key, message, attempts: 0 });
    inFlightKeys.add(key);
    startDrain();
  }

  // One drain loop at a time, so a burst of completions becomes a sequence of
  // requests rather than a simultaneous fan-out that invites rate limiting.
  function startDrain() {
    if (draining) return draining;
    draining = drainQueue().finally(() => { draining = null; });
    return draining;
  }

  async function drainQueue() {
    while (queue.length) {
      const item = queue[0];
      let res = null;
      try {
        res = await sendMessage(item.message);
      } catch (err) {
        res = { ok: false, errorClass: "network", error: err && err.message };
      }

      if (res && res.ok) {
        queue.shift();
        settle(item, "sent");
        continue;
      }

      const errorClass = (res && res.errorClass) || "unknown";
      if (!isRetryableErrorClass(errorClass)) {
        queue.shift();
        settle(item, "not delivered (permanent)", { errorClass });
        continue;
      }

      item.attempts += 1;
      if (item.attempts >= maxAttempts) {
        queue.shift();
        settle(item, "not delivered (retries exhausted)", { errorClass, attempts: item.attempts });
        continue;
      }

      // Retry-After wins over our own backoff — Slack is telling us the answer.
      const backoff = Math.min(retryBaseMs * Math.pow(2, item.attempts - 1), maxRetryDelayMs);
      await sleep((res && res.retryAfterMs) || backoff);
    }
  }

  // Test/inspection seam: resolves once the queue has settled.
  function drained() {
    return Promise.resolve(draining).then(() => (queue.length ? startDrain() : undefined));
  }


  // Startup recovery rebuilds a snapshot for sessions that outlived the last
  // run, but that snapshot only reached Dashboard/HUD. Slack's first snapshot
  // was therefore some later event, which the priming branch swallowed — so the
  // first completion after a restart went missing. Priming explicitly records
  // what is already history without sending it, and marks the notifier live, so
  // the next genuine completion is delivered.
  function prime(snapshot) {
    const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    for (const entry of sessions) {
      if (!entry || !entry.id || !isCompletion(entry)) continue;
      lastNotified.set(entry.id, dedupeKey(entry));
    }
    primed = true;
  }

  // Completion pings off the snapshot fanout. Sync + fire-and-forget + never
  // throw (mirrors telegram-companion). First snapshot only primes the dedupe
  // map so enabling later does not backfill old completions.
  function onSnapshot(snapshot) {
    const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const config = readConfig();
    const enabled = config.enabled === true;
    const priming = !primed;
    const seenIds = new Set();
    const toSend = [];

    for (const entry of sessions) {
      if (!entry || !entry.id) continue;
      seenIds.add(entry.id);
      if (!isCompletion(entry)) continue;
      const key = dedupeKey(entry);
      if (lastNotified.get(entry.id) === key) continue;
      if (inFlightKeys.has(key)) continue; // queued already; do not duplicate
      // Priming and disabled-notifications both mean "never send this", so the
      // event is settled immediately. A send-worthy event is NOT recorded here —
      // it is recorded once delivery settles, so a failure can still be retried.
      if (priming || !enabled) { lastNotified.set(entry.id, key); continue; }
      // Per-event gating: "interrupted" is the error/aborted family.
      const interrupted = entry.badge === "interrupted";
      if (interrupted && !config.notifyOnError) { lastNotified.set(entry.id, key); continue; }
      if (!interrupted && !config.notifyOnDone) { lastNotified.set(entry.id, key); continue; }
      toSend.push(entry);
    }

    for (const id of Array.from(lastNotified.keys())) {
      if (!seenIds.has(id) && !queue.some((item) => item.id === id)) lastNotified.delete(id);
    }

    primed = true;
    if (!toSend.length) return;
    if (!isReady()) return;

    const lang = readLang();
    const includeOutput = config.outputMode === "full";
    for (const entry of toSend) {
      let message = null;
      try {
        message = buildCompletionMessage(entry, { lang, includeOutput });
      } catch (err) {
        safeLog("warn", "slack completion format threw", { id: entry.id, error: err && err.message });
        continue;
      }
      if (!message) continue;
      enqueueCompletion(entry.id, dedupeKey(entry), message);
    }
  }

  // Read-only "permission needed" heads-up. Best-effort; returns a promise for
  // callers that want it but is safe to ignore.
  function notifyPermissionRequest(payload) {
    const config = readConfig();
    if (!config.enabled || !config.notifyOnPermission) return Promise.resolve({ ok: false, errorClass: "disabled" });
    if (!isReady()) return Promise.resolve({ ok: false, errorClass: "not-configured" });
    let message = null;
    try {
      message = buildPermissionMessage(payload, { lang: readLang() });
    } catch (err) {
      safeLog("warn", "slack permission format threw", { error: err && err.message });
      return Promise.resolve({ ok: false, errorClass: "format-error" });
    }
    return Promise.resolve()
      .then(() => sendMessage(message))
      .then((res) => {
        if (res && res.ok === false) {
          safeLog("warn", "slack permission notification not delivered", { errorClass: res.errorClass });
        }
        return res;
      })
      .catch((err) => {
        safeLog("warn", "slack permission notification threw", { error: err && err.message });
        return { ok: false, errorClass: "threw" };
      });
  }

  // Settings "send test" button. Surfaces a structured result the UI localizes.
  async function sendTest() {
    const state = settings.describeTransport(readConfig(), readSecrets());
    if (!state.transport) {
      return {
        status: "error",
        code: state.reason || "not-configured",
        message: "Slack transport is not configured",
      };
    }
    let res;
    try {
      res = await sendMessage(buildTestMessage({ lang: readLang() }));
    } catch (err) {
      return { status: "error", code: "threw", message: err && err.message };
    }
    if (res && res.ok) return { status: "ok", transport: state.transport };
    // `code` is a stable identifier the Settings page localizes ("the webhook
    // was deleted", "the token was rejected"); `message` stays English for logs.
    return {
      status: "error",
      code: (res && res.errorClass) || "send-failed",
      message: (res && res.detail) || (res && res.error) || "Slack rejected the message",
    };
  }

  const supportsApproval = false;

  return {
    isEnabled,
    isReady,
    getStatus,
    prime,
    drained,
    onSnapshot,
    notifyPermissionRequest,
    sendMessage,
    sendTest,
    supportsApproval,
    _lastNotified: lastNotified,
  };
}

module.exports = {
  createSlackNotifyClient,
  isCompletion,
  dedupeKey,
  classifyHttpStatus,
  COMPLETION_EVENTS,
};
