"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createSlackNotifyClient, isCompletion, dedupeKey, classifyHttpStatus } = require("../src/slack-notify-client");

const WEBHOOK = "https://hooks.slack.com/services/T/B/xxx";

function makeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, headers: (opts && opts.headers) || {}, body, opts: opts || {} });
    return responder(url, opts);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function okWebhook() {
  return { ok: true, status: 200, text: async () => "ok" };
}

function baseClient(overrides = {}) {
  return createSlackNotifyClient({
    getConfig: () => ({
      enabled: true,
      channelId: "",
      notifyOnDone: true,
      notifyOnError: true,
      notifyOnPermission: true,
      outputMode: "off",
      ...overrides.config,
    }),
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "", ...overrides.secrets }),
    getLang: () => "en",
    fetchImpl: overrides.fetchImpl || makeFetch(okWebhook),
  });
}

test("isCompletion / dedupeKey gate on badge + completion event", () => {
  assert.ok(isCompletion({ id: "s", badge: "done", lastEvent: { rawEvent: "Stop", at: 1 } }));
  assert.ok(!isCompletion({ id: "s", badge: "thinking", lastEvent: { rawEvent: "Stop", at: 1 } }));
  assert.ok(!isCompletion({ id: "s", badge: "done", lastEvent: { rawEvent: "Random", at: 1 } }));
  assert.equal(dedupeKey({ id: "s", lastEvent: { rawEvent: "Stop", at: 5 } }), "s:Stop:5");
});

test("classifyHttpStatus maps common failures", () => {
  assert.equal(classifyHttpStatus(429), "rate-limited");
  assert.equal(classifyHttpStatus(403), "unauthorized");
  assert.equal(classifyHttpStatus(404), "not-found");
  assert.equal(classifyHttpStatus(500), "http-500");
});

test("getStatus reflects readiness and transport", () => {
  const client = baseClient();
  const s = client.getStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.configured, true);
  assert.equal(s.ready, true);
  assert.equal(s.transport, "webhook");
  assert.equal(s.supportsApproval, false);
});

test("sendTest posts a webhook payload and reports ok", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  const res = await client.sendTest();
  assert.equal(res.status, "ok");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, WEBHOOK);
  assert.ok(Array.isArray(fetchImpl.calls[0].body.blocks));
});

test("bot transport posts to chat.postMessage with auth + channel", async () => {
  const fetchImpl = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) }));
  const client = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl,
  });
  const res = await client.sendMessage({ text: "hi", blocks: [] });
  assert.equal(res.ok, true);
  assert.equal(res.messageId, "1.2");
  const call = fetchImpl.calls[0];
  assert.ok(call.url.includes("chat.postMessage"));
  assert.equal(call.body.channel, "C99");
  assert.match(call.headers.authorization, /^Bearer xoxb-/);
});

test("chat.postMessage ok:false surfaces the slack error", async () => {
  const fetchImpl = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: "channel_not_found" }) }));
  const client = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl,
  });
  const res = await client.sendMessage({ text: "hi", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "slack-channel_not_found");
});

test("unconfigured client degrades without throwing", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = createSlackNotifyClient({
    getConfig: () => ({ enabled: true }),
    getSecrets: () => ({}),
    fetchImpl,
  });
  const res = await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "missing-secret");
  assert.equal(fetchImpl.calls.length, 0); // never hit the network
  const test = await client.sendTest();
  assert.equal(test.status, "error");
});

// A 3xx from either endpoint would otherwise move the request — and, on the bot
// transport, the Authorization header — to a host the webhook pin never vetted.
test("outbound requests refuse to follow redirects", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(fetchImpl.calls[0].opts.redirect, "error");

  const botFetch = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) }));
  const bot = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl: botFetch,
  });
  await bot.sendMessage({ text: "x", blocks: [] });
  assert.equal(botFetch.calls[0].opts.redirect, "error");
});

test("a redirect rejection is caught like any other transport failure", async () => {
  // What fetch actually does with redirect: "error" — reject, not resolve.
  const fetchImpl = makeFetch(() => { throw new TypeError("unexpected redirect"); });
  const client = baseClient({ fetchImpl });
  const res = await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "network");
});

test("network failure is caught and classified", async () => {
  const fetchImpl = makeFetch(() => { throw new Error("boom"); });
  const client = baseClient({ fetchImpl });
  const res = await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "network");
});

test("onSnapshot primes on first call, then sends once per new event", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  const snap = (at) => ({ sessions: [{ id: "s1", badge: "done", displayTitle: "T", lastEvent: { rawEvent: "Stop", at } }] });
  client.onSnapshot(snap(1)); // prime — no send
  client.onSnapshot(snap(1)); // same event — deduped
  client.onSnapshot(snap(2)); // new event — one send
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchImpl.calls.length, 1);
});

test("onSnapshot honors per-event gating", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ config: { notifyOnError: false }, fetchImpl });
  // prime with an unrelated running session so the map is primed
  client.onSnapshot({ sessions: [] });
  client.onSnapshot({ sessions: [{ id: "e1", badge: "interrupted", displayTitle: "T", lastEvent: { rawEvent: "ApiError", at: 1 } }] });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchImpl.calls.length, 0); // error notifications disabled
});

test("notifyPermissionRequest respects the toggle and readiness", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  const res = await client.notifyPermissionRequest({ title: "needs you", toolName: "Bash" });
  assert.equal(res.ok, true);
  assert.equal(fetchImpl.calls.length, 1);

  const fetchImpl2 = makeFetch(okWebhook);
  const off = baseClient({ config: { notifyOnPermission: false }, fetchImpl: fetchImpl2 });
  const res2 = await off.notifyPermissionRequest({ title: "x" });
  assert.equal(res2.ok, false);
  assert.equal(fetchImpl2.calls.length, 0);
});

// Defence in depth. The formatter redacts what it renders, but sendMessage is
// the last place the payload can be inspected before it leaves the process, and
// the one place that knows the *currently configured* credentials. A value that
// reached a field the formatter never sanitised — or a future caller that builds
// its own message — must still not carry the webhook out to the channel that
// webhook unlocks.
test("the configured webhook never survives into the outbound body", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  // Straight into sendMessage, so the formatter's redaction is bypassed
  // entirely and only the last-mile scrub can catch it.
  await client.sendMessage({ text: `deploy ${WEBHOOK} now`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `see ${WEBHOOK}` } },
  ] });

  const raw = JSON.stringify(fetchImpl.calls[0].body);
  assert.ok(!raw.includes(WEBHOOK), "the webhook URL must not appear in the body");
  assert.ok(raw.includes("redacted"), "it should be visibly redacted, not silently dropped");
  // The POST target is still the real webhook — only the payload is scrubbed.
  assert.equal(fetchImpl.calls[0].url, WEBHOOK);
});

test("the configured bot token never survives into the outbound body", async () => {
  const token = "xoxb-123456789-abcdefghij";
  const fetchImpl = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) }));
  const client = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: token },
    fetchImpl,
  });
  await client.sendMessage({ text: `token is ${token}`, blocks: [] });

  const raw = JSON.stringify(fetchImpl.calls[0].body);
  assert.ok(!raw.includes(token), "the bot token must not appear in the body");
  // It still authenticates the request.
  assert.match(fetchImpl.calls[0].headers.authorization, /^Bearer xoxb-/);
});

// Slack unfurls links by default and fetches whatever URL a message contains,
// pulling title/preview/thumbnail into the channel. Slack's own security guidance
// calls out LLM-derived URLs as an exfiltration risk, and agent output is exactly
// that, so both transports opt out.
test("link and media unfurling are disabled on both transports", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(fetchImpl.calls[0].body.unfurl_links, false);
  assert.equal(fetchImpl.calls[0].body.unfurl_media, false);

  const botFetch = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) }));
  const bot = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl: botFetch,
  });
  await bot.sendMessage({ text: "x", blocks: [] });
  assert.equal(botFetch.calls[0].body.unfurl_links, false);
  assert.equal(botFetch.calls[0].body.unfurl_media, false);
});

// The review asked for this specific shape: put the credential in every field an
// agent or user can influence, then assert on the *final serialized fetch body*
// rather than on any intermediate string.
test("no field can carry the webhook out — title, output, metadata, permission detail", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ config: { outputMode: "full" }, fetchImpl });

  client.onSnapshot({ sessions: [] }); // prime
  client.onSnapshot({ sessions: [{
    id: "s1",
    badge: "done",
    displayTitle: `ship ${WEBHOOK}`,
    cwd: `/srv/${WEBHOOK}`,
    host: WEBHOOK,
    agentId: "claude-code",
    assistantLastOutput: `curl -X POST ${WEBHOOK}`,
    lastEvent: { rawEvent: "Stop", at: 2 },
  }] });
  await new Promise((r) => setTimeout(r, 30));

  await client.notifyPermissionRequest({
    title: `approve ${WEBHOOK}`,
    toolName: "Bash",
    agentId: "claude-code",
    folder: `/w/${WEBHOOK}`,
    summary: `post to ${WEBHOOK}`,
  });

  assert.ok(fetchImpl.calls.length >= 2, "both a completion and a permission message were sent");
  for (const call of fetchImpl.calls) {
    const raw = JSON.stringify(call.body);
    assert.ok(!raw.includes(WEBHOOK), `webhook leaked into: ${raw.slice(0, 200)}`);
    // The distinctive path segment must not survive in pieces either.
    assert.ok(!raw.includes("/services/T/B/xxx"), "the secret path segment leaked");
  }
});

// ── Delivery is a queue, not a fan-out ──────────────────────────────────────
// Review item 2. Previously every completion in a snapshot was dispatched in
// parallel with the dedupe key committed *before* the send, so a 429 or a blip
// lost the message permanently and replaying the snapshot skipped it.

function queueClient(overrides = {}) {
  return createSlackNotifyClient({
    getConfig: () => ({ enabled: true, notifyOnDone: true, notifyOnError: true,
      notifyOnPermission: true, outputMode: "off", ...overrides.config }),
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "" }),
    getLang: () => "en",
    retryBaseMs: 0, // deterministic: no real waiting in tests
    ...overrides,
  });
}

const doneSnap = (ids, at = 1) => ({
  sessions: ids.map((id) => ({ id, badge: "done", displayTitle: id, lastEvent: { rawEvent: "Stop", at } })),
});

test("completions are delivered one at a time, not fired in parallel", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const fetchImpl = makeFetch(async () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return okWebhook();
  });
  const client = queueClient({ fetchImpl });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["a", "b", "c"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(maxConcurrent, 1, "a burst must not open three sockets at once");
});

test("a transient failure is retried instead of being lost", async () => {
  let n = 0;
  const fetchImpl = makeFetch(() => {
    n += 1;
    if (n === 1) return { ok: false, status: 503, text: async () => "busy" };
    return okWebhook();
  });
  const client = queueClient({ fetchImpl });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["s1"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 2, "the 503 should be retried once and then succeed");
});

test("429 waits for Retry-After before retrying", async () => {
  const waits = [];
  let n = 0;
  const fetchImpl = makeFetch(() => {
    n += 1;
    if (n === 1) {
      return { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "2" : null) }, text: async () => "" };
    }
    return okWebhook();
  });
  const client = queueClient({ fetchImpl, sleepImpl: (ms) => { waits.push(ms); return Promise.resolve(); } });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["s1"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(waits[0], 2000, "Retry-After is seconds; honour it rather than the default backoff");
});

test("a permanent 4xx is not retried", async () => {
  const fetchImpl = makeFetch(() => ({ ok: false, status: 404, text: async () => "no_service" }));
  const client = queueClient({ fetchImpl });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["s1"], 2));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 1, "a revoked webhook must not loop");
});

test("retries are capped, and a give-up does not re-enqueue forever", async () => {
  const fetchImpl = makeFetch(() => ({ ok: false, status: 500, text: async () => "boom" }));
  const client = queueClient({ fetchImpl, maxAttempts: 3 });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["s1"], 2));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 3, "attempts are bounded");

  // Replaying the same snapshot must not restart the cycle.
  client.onSnapshot(doneSnap(["s1"], 2));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 3, "the exhausted event is not retried on replay");
});

test("the queue is bounded and drops the oldest rather than growing without limit", async () => {
  const warnings = [];
  const fetchImpl = makeFetch(async () => { await new Promise((r) => setTimeout(r, 3)); return okWebhook(); });
  const client = queueClient({
    fetchImpl,
    maxQueue: 3,
    log: (level, message) => { if (level === "warn") warnings.push(message); },
  });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["a", "b", "c", "d", "e", "f", "g", "h"], 2));
  await client.drained();

  assert.ok(fetchImpl.calls.length <= 4, `bounded, got ${fetchImpl.calls.length}`);
  assert.ok(warnings.some((w) => /queue/i.test(w)), "dropping must be visible, not silent");
});

test("a repeat snapshot does not enqueue an event that is still in flight", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = makeFetch(async () => { await gate; return okWebhook(); });
  const client = queueClient({ fetchImpl });
  client.onSnapshot({ sessions: [] });
  client.onSnapshot(doneSnap(["s1"], 2));
  client.onSnapshot(doneSnap(["s1"], 2)); // same event, still sending
  release();
  await client.drained();

  assert.equal(fetchImpl.calls.length, 1);
});

// ── Startup recovery ────────────────────────────────────────────────────────
// Clawd rebuilds a snapshot for sessions that survived a restart, but it only
// reached Dashboard/HUD. Slack's first snapshot was therefore a later Stop,
// which the unconditional priming branch swallowed.

test("prime records history without sending, so old completions are not backfilled", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ fetchImpl });
  client.prime(doneSnap(["old"], 1));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 0, "a completion that happened before startup is history");

  client.onSnapshot(doneSnap(["old"], 1));
  await client.drained();
  assert.equal(fetchImpl.calls.length, 0, "and it stays history when the same snapshot arrives");
});

test("a session recovered as working still notifies when it later stops", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = queueClient({ fetchImpl });
  // What startup recovery actually produces: live sessions, not completions.
  client.prime({ sessions: [{ id: "s1", badge: "working", displayTitle: "T", lastEvent: { rawEvent: "PreToolUse", at: 1 } }] });
  client.onSnapshot(doneSnap(["s1"], 5));
  await client.drained();

  assert.equal(fetchImpl.calls.length, 1, "the first real completion after startup must be delivered");
});

test("startup recovery actually primes the notifier in main.js", () => {
  // The recovery path lives in main.js, which cannot be required here (Electron).
  // Without this, prime() could be perfectly correct and still never called —
  // exactly the failure mode the queue tests above cannot see.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const recoveryBlock = source.slice(source.indexOf("const recoveredSnapshot ="));
  assert.ok(recoveryBlock, "startup recovery block not found — did it move?");
  assert.match(
    recoveryBlock.slice(0, 900),
    /getSlackNotifyClient\(\)\.prime\(recoveredSnapshot\)/,
    "the recovered snapshot must be handed to the Slack notifier"
  );
});
