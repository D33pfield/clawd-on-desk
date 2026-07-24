"use strict";
// test/hook-pid-cache-contexts.test.js — #634: every migrated adapter passes a
// correct lifecycle context to the shared resolver's cross-process pid cache.
//
// Two layers, mirroring the repo's split for this area:
//   A. In-process ctx capture (all platforms) — a fake resolve records the ctx
//      each adapter builds, pinning namespace / lifecycle mapping / the
//      RAW-session-id cacheable guard (a prefixed "<agent>:default" fallback
//      must NOT count as cacheable, cf. #583).
//   B. Real-subprocess cache behavior (win32) — the offline-probe pattern from
//      test/hook-adapter-offline-contract.test.js, plus a seeded live v2 cache
//      entry in the real tmpdir: a cache hit must attempt ZERO snapshot spawns
//      (#634 acceptance), kiro (no stable session id) must keep its per-event
//      fresh snapshot (graceful degrade), and a prompt-lifecycle event must be
//      spawn-free even on a cache miss.

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOKS_DIR = path.join(__dirname, "..", "hooks");
const PROBE = path.join(__dirname, "helpers", "hook-offline-probe.js");
const pc = require("../hooks/pid-cache");

// Full public metadata shape the resolver returns — adapters destructure all of
// these, so the capture stub must provide every field.
function fakeMeta() {
  return {
    stablePid: 4321, terminalPid: 4321, snapshotOk: true, agentPid: 8765,
    agentCommandLine: "", detectedEditor: null, pidChain: [],
    foregroundWtHwnd: null, tmuxSocket: null, tmuxClient: null, headless: false,
  };
}

function capture() {
  const calls = [];
  const fn = (ctx) => { calls.push(ctx); return fakeMeta(); };
  fn.calls = calls;
  return fn;
}

const stubPost = (body, opts, cb) => cb(false, null);

// ═════════════════════════════════════════════════════════════════════════════
// A. ctx capture — buildStateBody seams (kimi / codex / copilot / qwen)
// ═════════════════════════════════════════════════════════════════════════════

describe("#634 ctx contract — buildStateBody seams", () => {
  let hadRemote;
  before(() => { hadRemote = process.env.CLAWD_REMOTE; delete process.env.CLAWD_REMOTE; });
  after(() => { if (hadRemote !== undefined) process.env.CLAWD_REMOTE = hadRemote; });

  it("kimi: lifecycle map + prefixed-default is not cacheable", () => {
    const mod = require("../hooks/kimi-hook.js");
    for (const [event, lifecycle] of [
      ["SessionStart", "start"], ["UserPromptSubmit", "prompt"],
      ["SessionEnd", "end"], ["PreToolUse", "event"], ["Stop", "event"],
    ]) {
      const cap = capture();
      mod.buildStateBody(event, { session_id: "k1", cwd: "D:/repo" }, cap);
      assert.strictEqual(cap.calls.length, 1, event);
      assert.deepStrictEqual(
        { ...cap.calls[0] },
        { namespace: "kimi-cli", sessionId: "kimi-cli:k1", cacheCwd: "D:/repo", lifecycle, cacheable: true },
        event
      );
    }
    const cap = capture();
    mod.buildStateBody("PreToolUse", { cwd: "D:/repo" }, cap); // no session_id
    assert.strictEqual(cap.calls[0].sessionId, "kimi-cli:default");
    assert.strictEqual(cap.calls[0].cacheable, false, "kimi-cli:default must not key a shared cache entry");
  });

  it("codex: state + permission bodies share the guard; Stop is not end", () => {
    const mod = require("../hooks/codex-hook.js");
    for (const [event, lifecycle] of [
      ["SessionStart", "start"], ["UserPromptSubmit", "prompt"], ["Stop", "event"], ["PreToolUse", "event"],
    ]) {
      const cap = capture();
      mod.buildStateBody({ hook_event_name: event, session_id: "cx1", cwd: "D:/repo" }, cap);
      assert.strictEqual(cap.calls[0].namespace, "codex", event);
      assert.strictEqual(cap.calls[0].lifecycle, lifecycle, event);
      assert.strictEqual(cap.calls[0].sessionId, "codex:cx1", event);
      assert.strictEqual(cap.calls[0].cacheable, true, event);
    }
    const cap = capture();
    mod.buildStateBody({ hook_event_name: "PreToolUse", cwd: "D:/repo" }, cap);
    assert.strictEqual(cap.calls[0].sessionId, "codex:default");
    assert.strictEqual(cap.calls[0].cacheable, false, "codex:default must not key a shared cache entry");
  });

  it("copilot: camelCase lifecycle map; permission body uses the event lifecycle", () => {
    const mod = require("../hooks/copilot-hook.js");
    for (const [event, lifecycle] of [
      ["sessionStart", "start"], ["userPromptSubmitted", "prompt"],
      ["sessionEnd", "end"], ["preToolUse", "event"], ["agentStop", "event"],
    ]) {
      const cap = capture();
      mod.buildStateBody(event, { sessionId: "cp1", cwd: "D:/repo" }, cap);
      assert.strictEqual(cap.calls[0].namespace, "copilot-cli", event);
      assert.strictEqual(cap.calls[0].lifecycle, lifecycle, event);
      assert.strictEqual(cap.calls[0].cacheable, true, event);
    }
    const cap = capture();
    mod.buildStateBody("preToolUse", { cwd: "D:/repo" }, cap); // no session id → "default"
    assert.strictEqual(cap.calls[0].cacheable, false);
  });

  it("qwen-code: state + permission bodies; raw-id guard beats the prefixed fallback", () => {
    const mod = require("../hooks/qwen-code-hook.js");
    for (const [event, lifecycle] of [
      ["SessionStart", "start"], ["UserPromptSubmit", "prompt"], ["SessionEnd", "end"], ["PreToolUse", "event"],
    ]) {
      const cap = capture();
      mod.buildStateBody(event, { session_id: "qw1", cwd: "D:/repo" }, cap, {});
      assert.strictEqual(cap.calls[0].namespace, "qwen-code", event);
      assert.strictEqual(cap.calls[0].lifecycle, lifecycle, event);
      assert.strictEqual(cap.calls[0].sessionId, "qwen-code:qw1", event);
      assert.strictEqual(cap.calls[0].cacheable, true, event);
    }
    const capNoSid = capture();
    mod.buildStateBody("PreToolUse", { cwd: "D:/repo" }, capNoSid, {});
    assert.strictEqual(capNoSid.calls[0].cacheable, false, "qwen-code:default must not be cacheable");
    const capLiteral = capture();
    mod.buildStateBody("PreToolUse", { session_id: "default", cwd: "D:/repo" }, capLiteral, {});
    assert.strictEqual(capLiteral.calls[0].cacheable, false, "a literal raw \"default\" id must not be cacheable either");
    const capPerm = capture();
    mod.buildPermissionBody("PermissionRequest", { session_id: "qw1", cwd: "D:/repo", tool_name: "bash" }, capPerm, {});
    assert.strictEqual(capPerm.calls[0].lifecycle, "event", "permission bodies use the event lifecycle");
    assert.strictEqual(capPerm.calls[0].cacheable, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A (cont.) — sendHookEvent deps.resolvePid seams (gemini / qoder / qoderwork /
// antigravity)
// ═════════════════════════════════════════════════════════════════════════════

describe("#634 ctx contract — sendHookEvent seams", () => {
  it("gemini: BeforeAgent is the prompt equivalent; gemini:default not cacheable", async () => {
    const mod = require("../hooks/gemini-hook.js");
    const send = mod.sendHookEvent || mod.__test.sendHookEvent;
    for (const [event, lifecycle] of [
      ["SessionStart", "start"], ["BeforeAgent", "prompt"], ["SessionEnd", "end"], ["BeforeTool", "event"],
    ]) {
      const cap = capture();
      await send({ hook_event_name: event, session_id: "g1", cwd: "D:/repo" }, "", { env: {}, resolvePid: cap, postState: stubPost });
      assert.strictEqual(cap.calls.length, 1, event);
      assert.deepStrictEqual(
        { ...cap.calls[0] },
        { namespace: "gemini-cli", sessionId: "gemini:g1", cacheCwd: "D:/repo", lifecycle, cacheable: true },
        event
      );
    }
    const cap = capture();
    await send({ hook_event_name: "BeforeTool", cwd: "D:/repo" }, "", { env: {}, resolvePid: cap, postState: stubPost });
    assert.strictEqual(cap.calls[0].sessionId, "gemini:default");
    assert.strictEqual(cap.calls[0].cacheable, false, "gemini:default must not key a shared cache entry");
  });

  for (const [file, ns] of [["qoder-hook.js", "qoder"], ["qoderwork-hook.js", "qoderwork"]]) {
    it(`${ns}: SessionStart/UserPromptSubmit/SessionEnd map; default ids not cacheable`, async () => {
      const mod = require(`../hooks/${file}`);
      for (const [event, lifecycle] of [
        ["SessionStart", "start"], ["UserPromptSubmit", "prompt"], ["SessionEnd", "end"],
        ["PreToolUse", "event"], ["Stop", "event"],
      ]) {
        const cap = capture();
        await mod.sendHookEvent({ hook_event_name: event, session_id: "q1", cwd: "D:/repo" }, "", { env: {}, resolvePid: cap, postState: stubPost });
        assert.strictEqual(cap.calls.length, 1, event);
        assert.strictEqual(cap.calls[0].namespace, ns, event);
        assert.strictEqual(cap.calls[0].lifecycle, lifecycle, event);
        assert.strictEqual(cap.calls[0].sessionId, `${ns}:q1`, event);
        assert.strictEqual(cap.calls[0].cacheable, true, event);
      }
      const cap = capture();
      await mod.sendHookEvent({ hook_event_name: "PreToolUse", cwd: "D:/repo" }, "", { env: {}, resolvePid: cap, postState: stubPost });
      assert.strictEqual(cap.calls[0].cacheable, false, `${ns}:default must not key a shared cache entry`);
      const capLiteral = capture();
      await mod.sendHookEvent({ hook_event_name: "PreToolUse", session_id: "default", cwd: "D:/repo" }, "", { env: {}, resolvePid: capLiteral, postState: stubPost });
      assert.strictEqual(capLiteral.calls[0].cacheable, false, "a literal raw \"default\" id must not be cacheable either");
    });
  }

  it("antigravity: every event uses the event lifecycle; transcript-dirname id is cacheable", async () => {
    const mod = require("../hooks/antigravity-hook.js");
    const send = mod.sendHookEvent || (mod.__test && mod.__test.sendHookEvent);
    assert.strictEqual(typeof send, "function", "sendHookEvent seam");
    const deps = (cap) => ({ env: {}, resolvePid: cap, postState: stubPost, postPermission: stubPost });

    const cap = capture();
    await send({ hookEventName: "PreToolUse", conversationId: "ag1", workspacePaths: ["D:/repo"] }, "", deps(cap));
    assert.strictEqual(cap.calls.length, 1);
    assert.deepStrictEqual(
      { ...cap.calls[0] },
      { namespace: "antigravity-cli", sessionId: "antigravity:ag1", cacheCwd: "D:/repo", lifecycle: "event", cacheable: true }
    );

    const capDirname = capture();
    await send({ hookEventName: "PreToolUse", transcriptPath: "C:/t/conv-77/rollout.json", workspacePaths: ["D:/repo"] }, "", deps(capDirname));
    assert.strictEqual(capDirname.calls[0].sessionId, "antigravity:conv-77");
    assert.strictEqual(capDirname.calls[0].cacheable, true, "transcript-dirname fallback is a real per-conversation id");

    const capNone = capture();
    await send({ hookEventName: "PreToolUse", workspacePaths: ["D:/repo"] }, "", deps(capNone));
    assert.strictEqual(capNone.calls[0].sessionId, "antigravity:default");
    assert.strictEqual(capNone.calls[0].cacheable, false, "antigravity:default must not key a shared cache entry");
  });

  it("antigravity: cache key stays stable while toolCall.args.Cwd varies within one conversation", async () => {
    const mod = require("../hooks/antigravity-hook.js");
    const send = mod.sendHookEvent || (mod.__test && mod.__test.sendHookEvent);
    const deps = (cap) => ({ env: {}, resolvePid: cap, postState: stubPost, postPermission: stubPost });

    // Same conversation + workspace; the per-tool cwd wanders across subdirs
    // and slash spellings. resolveCwd() legitimately follows it for the event
    // body, but the CACHE key must not — each drift would be a fresh v2 file
    // and a snapshot-spawning miss.
    const toolCwds = ["D:/repo", "D:\\repo", "D:/repo/src", undefined];
    const seen = [];
    for (const toolCwd of toolCwds) {
      const cap = capture();
      const payload = { hookEventName: "PreToolUse", conversationId: "ag-stable", workspacePaths: ["D:/repo"] };
      if (toolCwd !== undefined) payload.toolCall = { args: { Cwd: toolCwd } };
      await send(payload, "", deps(cap));
      seen.push(cap.calls[0].cacheCwd);
      assert.strictEqual(cap.calls[0].cacheable, true, String(toolCwd));
    }
    assert.deepStrictEqual(seen, ["D:/repo", "D:/repo", "D:/repo", "D:/repo"],
      "cacheCwd must be the stable workspacePaths[0], never the per-tool cwd");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. Real subprocess — seeded v2 cache hit ⇒ zero snapshot spawns (win32)
// ═════════════════════════════════════════════════════════════════════════════

describe("#634 subprocess — cache hits spawn nothing; kiro degrades gracefully", { skip: process.platform !== "win32" }, () => {
  let fakeHome;
  let probeOut;
  const seeded = [];

  before(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-634-ctx-home-"));
    probeOut = path.join(fakeHome, "spawns.json");
  });
  after(() => { try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {} });
  afterEach(() => {
    for (const [ns, sid, cwd] of seeded.splice(0)) pc.dropPidCacheV2(ns, sid, cwd);
  });

  // The parent and the child hook share the real os.tmpdir() (TEMP is not
  // remapped — only USERPROFILE/HOME are), so a v2 entry seeded here is exactly
  // what the child's resolver reads. Both pids are this test process — alive
  // from the child's perspective, so the double-liveness check passes.
  function seedLiveCache(ns, sid, cwd) {
    const ok = pc.writePidCacheV2(ns, sid, cwd, {
      stablePid: process.pid, agentPid: process.pid, headless: false, detectedEditor: null,
    });
    assert.ok(ok, `seed ${ns}`);
    seeded.push([ns, sid, cwd]);
  }

  const LIVE_RUNTIME = () => ({ app: "clawd-on-desk", port: 23333, ownerPid: process.pid });

  function runHook(name, payload) {
    const clawdDir = path.join(fakeHome, ".clawd");
    fs.mkdirSync(clawdDir, { recursive: true });
    fs.writeFileSync(path.join(clawdDir, "runtime.json"), JSON.stringify(LIVE_RUNTIME()));
    try { fs.unlinkSync(probeOut); } catch {}
    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, CLAWD_PROBE_OUT: probeOut };
    delete env.CLAWD_REMOTE;
    const result = spawnSync(process.execPath, ["--require", PROBE, path.join(HOOKS_DIR, name)], {
      input: `${JSON.stringify(payload)}\n`,
      encoding: "utf8", windowsHide: true, timeout: 20000, env,
    });
    let spawns = null;
    try { spawns = JSON.parse(fs.readFileSync(probeOut, "utf8")); } catch {}
    return { spawns, stderr: result.stderr };
  }

  const sid = (p) => `${p}-634-${process.pid}`;

  // Script-style adapters (no unit seam) — a live v2 hit must spawn nothing.
  const HIT_ROWS = [
    { name: "cursor-hook.js", ns: "cursor-agent", raw: sid("cur"), cacheSid: sid("cur"),
      payload: { hook_event_name: "preToolUse", conversation_id: sid("cur"), cwd: "D:/repo" } },
    { name: "codebuddy-hook.js", ns: "codebuddy", raw: sid("cb"), cacheSid: sid("cb"),
      payload: { hook_event_name: "PreToolUse", session_id: sid("cb"), cwd: "D:/repo" } },
    { name: "reasonix-hook.js", ns: "reasonix", raw: sid("rx"), cacheSid: `reasonix:${sid("rx")}`,
      payload: { event: "PreToolUse", session_id: sid("rx"), cwd: "D:/repo", toolName: "bash" } },
  ];

  for (const row of HIT_ROWS) {
    it(`${row.name}: live v2 cache hit ⇒ zero snapshot spawns`, () => {
      seedLiveCache(row.ns, row.cacheSid, "D:/repo");
      const r = runHook(row.name, row.payload);
      assert.ok(Array.isArray(r.spawns), `${row.name} did not report — stderr=${r.stderr}`);
      assert.deepStrictEqual(r.spawns, [], `${row.name} must resolve from the cache without spawning`);
    });
  }

  it("kiro-hook.js: no stable session id ⇒ cache disabled, still one fresh snapshot per event", () => {
    // Even a seeded entry under its would-be key must be ignored (cacheable:false).
    seedLiveCache("kiro-cli", "default", "D:/repo");
    const r = runHook("kiro-hook.js", { hook_event_name: "preToolUse", cwd: "D:/repo" });
    assert.ok(Array.isArray(r.spawns), `kiro did not report — stderr=${r.stderr}`);
    assert.strictEqual(r.spawns.length, 1, "kiro must keep today's per-event fresh snapshot (graceful degrade)");
    assert.match(r.spawns[0], /powershell/i);
  });

  it("cursor-hook.js: prompt lifecycle is spawn-free even on a cache miss", () => {
    const r = runHook("cursor-hook.js", {
      hook_event_name: "beforeSubmitPrompt", conversation_id: sid("cur-miss"), cwd: "D:/repo",
    });
    assert.ok(Array.isArray(r.spawns), `cursor did not report — stderr=${r.stderr}`);
    assert.deepStrictEqual(r.spawns, [], "prompt is cache-only: no snapshot spawn, hit or miss");
  });

  it("qoder-hook.js: SessionEnd drops the live cache entry without spawning", () => {
    const raw = sid("qd-end");
    const cacheSid = `qoder:${raw}`;
    seedLiveCache("qoder", cacheSid, "D:/repo");
    const file = pc.cacheFilePathV2("qoder", cacheSid, "D:/repo");
    assert.ok(fs.existsSync(file), "seeded entry exists before SessionEnd");
    const r = runHook("qoder-hook.js", { hook_event_name: "SessionEnd", session_id: raw, cwd: "D:/repo" });
    assert.ok(Array.isArray(r.spawns), `qoder did not report — stderr=${r.stderr}`);
    assert.deepStrictEqual(r.spawns, [], "end is cache-only: no snapshot spawn");
    assert.strictEqual(fs.existsSync(file), false, "SessionEnd must delete the session's v2 cache entry");
  });

  it("qoder-hook.js: SessionEnd on a cache miss stays spawn-free", () => {
    const r = runHook("qoder-hook.js", { hook_event_name: "SessionEnd", session_id: sid("qd-end-miss"), cwd: "D:/repo" });
    assert.ok(Array.isArray(r.spawns), `qoder did not report — stderr=${r.stderr}`);
    assert.deepStrictEqual(r.spawns, [], "the end contract never takes a fresh snapshot, hit or miss");
  });

  it("reasonix-hook.js: a literal \"default\" session id ignores a seeded entry and stays fresh", () => {
    seedLiveCache("reasonix", "reasonix:default", "D:/repo");
    const r = runHook("reasonix-hook.js", { event: "PreToolUse", session_id: "default", cwd: "D:/repo", toolName: "bash" });
    assert.ok(Array.isArray(r.spawns), `reasonix did not report — stderr=${r.stderr}`);
    assert.strictEqual(r.spawns.length, 1, "literal default must not be cacheable: per-event fresh snapshot, like kiro");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. Consumer contract — no adapter silently stays on the bare (uncached) path
// ═════════════════════════════════════════════════════════════════════════════

describe("#634 consumer contract — ctx or explicit exemption", () => {
  // The offline-contract test locks the consumer COUNT; this locks the cache
  // MIGRATION: a createPidResolver consumer must build a cache context
  // (recognized by its `namespace: "` literal) or be exempted here on purpose.
  // Prewarm-style bare resolve() calls are fine — this only catches files with
  // no context anywhere.
  const EXEMPT = new Set([
    // #634 scopes exactly 12 adapters; WorkBuddy joined the resolver later
    // (#618) and is tracked as an explicit follow-up on the issue — remove
    // this exemption when it migrates.
    "workbuddy-hook.js",
  ]);

  it("every createPidResolver consumer passes a cache context or is exempted", () => {
    const consumers = fs.readdirSync(HOOKS_DIR)
      .filter((f) => f.endsWith("-hook.js"))
      .filter((f) => fs.readFileSync(path.join(HOOKS_DIR, f), "utf8").includes("createPidResolver("));
    assert.ok(consumers.length >= 14, "sanity: the resolver consumers are all visible to this scan");
    const bare = consumers.filter((f) => {
      if (EXEMPT.has(f)) return false;
      return !fs.readFileSync(path.join(HOOKS_DIR, f), "utf8").includes('namespace: "');
    });
    assert.deepStrictEqual(bare, [],
      "these adapters call createPidResolver but never build a cache context — migrate them or add an explicit exemption with a reason");
  });

  it("exemptions stay honest — an exempted file must still be a consumer", () => {
    for (const f of EXEMPT) {
      const p = path.join(HOOKS_DIR, f);
      assert.ok(fs.existsSync(p), `${f} exempted but missing`);
      assert.ok(fs.readFileSync(p, "utf8").includes("createPidResolver("), `${f} exempted but no longer a consumer — drop the exemption`);
    }
  });
});
