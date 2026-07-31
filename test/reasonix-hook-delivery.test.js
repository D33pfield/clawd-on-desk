"use strict";

// Delivery-level tests for hooks/reasonix-hook.js: not just "silent exit 0",
// but what actually reaches the Clawd server, under the timing and platform
// conditions that used to silently drop events. Helpers:
//   hook-http-recorder.js  — answers http as a healthy Clawd server, records bodies
//   reasonix-hook-snapshot-fake.js — plants a reasonix.exe ancestor in the WMI snapshot
//   hook-orca-spy.js       — spies on applyOrcaPaneKey, stubs the resolver
//   hook-http-blocker.js   — fails all http (existing)

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK_PATH = path.resolve(__dirname, "..", "hooks", "reasonix-hook.js");
const RECORDER_PATH = path.resolve(__dirname, "hook-http-recorder.js");
const SNAPSHOT_FAKE_PATH = path.resolve(__dirname, "reasonix-hook-snapshot-fake.js");
const ORCA_SPY_PATH = path.resolve(__dirname, "hook-orca-spy.js");
const BLOCKER_PATH = path.resolve(__dirname, "hook-http-blocker.js");

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reasonix-delivery-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function hookEnv(homeDir, extra = {}) {
  return { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ...extra };
}

// A well-formed Clawd runtime identity owned by this (living) test runner, so
// the resolver's #681 zero-spawn gate opens inside spawned hooks.
function writeRuntimeIdentity(homeDir) {
  const clawdDir = path.join(homeDir, ".clawd");
  fs.mkdirSync(clawdDir, { recursive: true });
  fs.writeFileSync(
    path.join(clawdDir, "runtime.json"),
    JSON.stringify({ app: "clawd-on-desk", port: 23333, ownerPid: process.pid })
  );
}

function readRecords(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function spawnHook({ preload = [], payload, env = {}, home, timeout = 30000 }) {
  const homeDir = home || makeTempDir();
  return spawnSync(process.execPath, [...preload.flatMap((p) => ["--require", p]), HOOK_PATH], {
    input: JSON.stringify(payload) + "\n",
    encoding: "utf8",
    env: hookEnv(homeDir, env),
    windowsHide: true,
    timeout,
  });
}

describe("reasonix hook delivery", () => {
  it("still posts after a delayed (1800ms) stdin flush", async () => {
    const home = makeTempDir();
    const record = path.join(home, "http.jsonl");
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["--require", RECORDER_PATH, HOOK_PATH], {
      env: hookEnv(home, { CLAWD_HOOK_HTTP_RECORD: record }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const code = await new Promise((resolve) => {
      setTimeout(() => {
        child.stdin.end(
          JSON.stringify({ event: "UserPromptSubmit", sessionId: "s-1", cwd: "D:/proj", turn: 1 }) + "\n"
        );
      }, 1800);
      child.on("exit", resolve);
    });

    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, "");
    assert.strictEqual(stderr, "");
    assert.ok(Date.now() - startedAt >= 1800, "hook must actually wait for the late payload");
    const posts = readRecords(record).filter((entry) => entry.method === "POST");
    assert.strictEqual(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.strictEqual(body.event, "UserPromptSubmit");
    assert.strictEqual(body.state, "thinking");
  });

  it("attaches PID metadata on non-SessionStart events too", () => {
    const home = makeTempDir();
    writeRuntimeIdentity(home);
    const record = path.join(home, "http.jsonl");
    const result = spawnHook({
      preload: [RECORDER_PATH, SNAPSHOT_FAKE_PATH],
      payload: { event: "PreToolUse", toolName: "bash", cwd: "D:/proj" },
      env: { CLAWD_HOOK_HTTP_RECORD: record },
      home,
    });

    assert.strictEqual(result.status, 0);
    const posts = readRecords(record).filter((entry) => entry.method === "POST");
    assert.strictEqual(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.strictEqual(body.event, "PreToolUse");
    // Planted by reasonix-hook-snapshot-fake.js: reasonix.exe at pid 4000,
    // the direct parent of the hook's own parent.
    assert.strictEqual(body.agent_pid, 4000);
    assert.ok(Number.isInteger(body.source_pid) && body.source_pid > 0);
    assert.ok(Array.isArray(body.pid_chain) && body.pid_chain.includes(4000));
  });

  it("exits inside the blocking budget when stdin never arrives", async () => {
    const home = makeTempDir();
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["--require", BLOCKER_PATH, HOOK_PATH], {
      env: hookEnv(home),
    });
    // Never write and never close stdin: the phase-1 budget (2500ms) must fire
    // well below the 4500ms absolute deadline — and below Reasonix's outer 5s
    // blocking-hook budget, whose timeout would abort the user's turn.
    const code = await new Promise((resolve) => child.on("exit", resolve));
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(code, 0);
    assert.ok(elapsed >= 1800, `hook should wait out most of the stdin window (${elapsed}ms)`);
    assert.ok(elapsed < 5500, `hook must not outlive the blocking budget (${elapsed}ms)`);
  });

  it("resolver name set covers the Linux comm-truncated reasonix-deskto", () => {
    // Linux /proc comm is capped at TASK_COMM_LEN(16)-1 = 15 chars, so
    // "reasonix-desktop" shows up as "reasonix-deskto" in ps/pgrep output.
    // Resolver matching is plain Set membership, so the truncated form must
    // be in the set. This runner is Windows (no linux ps walk available), so
    // pin the set at the source.
    const source = fs.readFileSync(HOOK_PATH, "utf8");
    assert.match(source, /linux:\s*new Set\(\[[^\]]*"reasonix-deskto"/);
  });

  it("keeps applyOrcaPaneKey on both local and remote paths", () => {
    for (const remote of [false, true]) {
      const home = makeTempDir();
      const record = path.join(home, "orca.jsonl");
      const result = spawnHook({
        preload: [ORCA_SPY_PATH, RECORDER_PATH],
        payload: { event: "PreToolUse", toolName: "bash", cwd: "D:/proj" },
        env: {
          CLAWD_TEST_ORCA_RECORD: record,
          CLAWD_HOOK_HTTP_RECORD: path.join(home, "http.jsonl"),
          ...(remote ? { CLAWD_REMOTE: "1" } : {}),
        },
        home,
      });

      const label = remote ? "remote" : "local";
      assert.strictEqual(result.status, 0, `${label} exit`);
      const calls = readRecords(record);
      assert.strictEqual(calls.length, 1, `${label} must call applyOrcaPaneKey exactly once`);
      assert.strictEqual(calls[0].event, "PreToolUse");
    }
  });

  it("posts the expected body for a real Reasonix native payload", () => {
    const home = makeTempDir();
    const record = path.join(home, "http.jsonl");
    const result = spawnHook({
      preload: [RECORDER_PATH],
      payload: {
        event: "UserPromptSubmit",
        sessionId: "9f1c2a",
        cwd: "D:/proj",
        prompt: "你好",
        turn: 3,
      },
      env: { CLAWD_HOOK_HTTP_RECORD: record },
      home,
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    const posts = readRecords(record).filter((entry) => entry.method === "POST");
    assert.strictEqual(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.deepStrictEqual(
      {
        state: body.state,
        event: body.event,
        agent_id: body.agent_id,
        session_id: body.session_id,
        cwd: body.cwd,
      },
      {
        state: "thinking",
        event: "UserPromptSubmit",
        agent_id: "reasonix",
        // TODO(sessionId contract): native Reasonix payloads carry camelCase
        // `sessionId`, which the hook does not map yet, so sessions fall back
        // to reasonix:default. Update this expectation when the contract fix
        // lands (tracked as a follow-up, intentionally out of this PR).
        session_id: "reasonix:default",
        cwd: "D:/proj",
      }
    );
  });
});
