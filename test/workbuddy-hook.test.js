const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  HOOK_MAP,
  stdoutForEvent,
  deriveSessionTitle,
  SESSION_TITLE_MAX,
} = require("../hooks/workbuddy-hook");

describe("WorkBuddy hook runtime", () => {
  it("maps lifecycle events to idle / thinking / sleeping", () => {
    assert.strictEqual(HOOK_MAP.SessionStart.state, "idle");
    assert.strictEqual(HOOK_MAP.UserPromptSubmit.state, "thinking");
    assert.strictEqual(HOOK_MAP.SessionEnd.state, "sleeping");
  });

  it("maps tool-boundary events to working", () => {
    assert.strictEqual(HOOK_MAP.PreToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUse.state, "working");
  });

  it("maps Stop to attention and Notification to notification", () => {
    assert.strictEqual(HOOK_MAP.Stop.state, "attention");
    assert.strictEqual(HOOK_MAP.Notification.state, "notification");
  });

  it("gates PreToolUse with an allow decision, all other events with {}", () => {
    assert.strictEqual(stdoutForEvent("PreToolUse"), JSON.stringify({ decision: "allow" }));
    assert.strictEqual(stdoutForEvent("UserPromptSubmit"), "{}");
    assert.strictEqual(stdoutForEvent("Stop"), "{}");
  });
});

describe("WorkBuddy hook session title (#648)", () => {
  it("prefers an explicit payload.session_title over the prompt", () => {
    const title = deriveSessionTitle("UserPromptSubmit", {
      session_title: "  Rename me  ",
      prompt: "ignored first line",
    });
    assert.strictEqual(title, "Rename me");
  });

  it("uses the first non-blank line of the prompt on UserPromptSubmit", () => {
    const title = deriveSessionTitle("UserPromptSubmit", {
      prompt: "\n   \nFix the login bug\nmore context here",
    });
    assert.strictEqual(title, "Fix the login bug");
  });

  it("truncates long titles to SESSION_TITLE_MAX with an ellipsis", () => {
    const long = "x".repeat(200);
    const title = deriveSessionTitle("UserPromptSubmit", { prompt: long });
    assert.strictEqual(title.length, SESSION_TITLE_MAX);
    assert.ok(title.endsWith("\u2026"));
    assert.strictEqual(title, `${"x".repeat(SESSION_TITLE_MAX - 1)}\u2026`);
  });

  it("does not derive a prompt title on non-UserPromptSubmit events", () => {
    // A prompt field on e.g. PreToolUse must not become the title — only
    // UserPromptSubmit is a high-quality source.
    assert.strictEqual(deriveSessionTitle("PreToolUse", { prompt: "not a title" }), null);
    assert.strictEqual(deriveSessionTitle("Stop", { prompt: "not a title" }), null);
  });

  it("returns null when no high-quality source exists (server falls back to cwd)", () => {
    // Crucially we do NOT fall back to cwd/session_id here: a low-quality value
    // would overwrite a good title via the server's sticky `||` chain.
    assert.strictEqual(deriveSessionTitle("UserPromptSubmit", {}), null);
    assert.strictEqual(deriveSessionTitle("UserPromptSubmit", { prompt: "   \n  " }), null);
    assert.strictEqual(deriveSessionTitle("SessionStart", { cwd: "/home/me/project" }), null);
  });
});

// A function-level assertion on stdoutForEvent() cannot see this: the filter
// lives in the async run() body, and the bug it prevents (a phantom "default"
// session + an exit-timing POST) only shows up when the REAL script consumes
// stdin and either does or does not reach out to Clawd. The Windows P0 proved
// exit-timing bugs are invisible to unit tests, so this runs the shipped hook in
// a subprocess and asserts the three things that matter: exit code, exact
// stdout bytes, and the number of outbound HTTP attempts.
describe("WorkBuddy hook session_id filter (#618 / #648) — real subprocess", () => {
  const HOOK = path.resolve(__dirname, "..", "hooks", "workbuddy-hook.js");
  const RECORDER = path.resolve(__dirname, "helpers", "hook-post-recorder.js");
  let fakeHome;
  let postOut;

  before(() => {
    // Empty home ⇒ no ~/.clawd/runtime.json ⇒ every port looks offline. This is
    // what makes "zero HTTP attempts" mean "the hook chose not to forward",
    // not "the hook tried but the socket was refused".
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "wb-sessfilter-"));
    postOut = path.join(fakeHome, "attempts.json");
  });

  after(() => {
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function runHook(payload) {
    try { fs.unlinkSync(postOut); } catch { /* first run */ }
    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, CLAWD_POST_OUT: postOut };
    delete env.CLAWD_REMOTE;
    const result = spawnSync(process.execPath, ["--require", RECORDER, HOOK], {
      input: `${JSON.stringify(payload)}\n`,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
      env,
    });
    let attempts = null;
    try { attempts = JSON.parse(fs.readFileSync(postOut, "utf8")); } catch { /* hook never exited cleanly */ }
    return { ...result, attempts };
  }

  it("forwards nothing and produces no placeholder session when session_id is absent", () => {
    const r = runHook({ hook_event_name: "UserPromptSubmit", prompt: "do a thing", cwd: "/tmp/repo" });

    assert.strictEqual(r.status, 0, `must exit 0; stderr=${r.stderr}`);
    assert.strictEqual(r.stderr, "", "must not surface an error to WorkBuddy");
    assert.strictEqual(r.stdout, "{}\n", "UserPromptSubmit still gets a valid empty-JSON answer");
    assert.ok(Array.isArray(r.attempts), `hook did not exit cleanly — status=${r.status}, stderr=${r.stderr}`);
    assert.deepStrictEqual(r.attempts, [],
      `no session_id must mean zero contact with Clawd — got ${JSON.stringify(r.attempts)}`);
  });

  it("also short-circuits when session_id is blank / whitespace", () => {
    const r = runHook({ hook_event_name: "PreToolUse", session_id: "   ", cwd: "/tmp/repo" });

    assert.strictEqual(r.status, 0, `must exit 0; stderr=${r.stderr}`);
    assert.strictEqual(r.stdout, `${JSON.stringify({ decision: "allow" })}\n`,
      "PreToolUse still gets its allow decision even when the event is dropped");
    assert.deepStrictEqual(r.attempts, [], "blank session_id is treated as absent — zero POST");
  });

  // VACUITY GUARD. "Zero attempts" only proves the filter works if the SAME
  // hook, given a real session_id, would otherwise have reached out. Without
  // this a hook that never posts at all would pass the case above for the wrong
  // reason (the exact class of bug #681's guard was written to catch).
  it("attempts to reach Clawd when session_id IS present (so the case above is not vacuous)", () => {
    const r = runHook({ hook_event_name: "PreToolUse", session_id: "s-618", cwd: "/tmp/repo" });

    assert.strictEqual(r.status, 0, `must exit 0; stderr=${r.stderr}`);
    assert.strictEqual(r.stdout, `${JSON.stringify({ decision: "allow" })}\n`);
    assert.ok(Array.isArray(r.attempts), `hook did not exit cleanly — stderr=${r.stderr}`);
    assert.ok(r.attempts.length >= 1,
      "a real session_id must make the hook try to contact Clawd — zero here would mean the "
      + "filter test above proves nothing");
  });
});
