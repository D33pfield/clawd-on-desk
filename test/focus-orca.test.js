// test/focus-orca.test.js — Orca window raise + pane-level focus switching
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { loadFocusWithMock } = require("./helpers/load-focus-with-mock");

const { orcaPaneKeyFromEnv, applyOrcaPaneKey } = require("../hooks/shared-process");

const PANE_KEY = "8ce1fff7-tab:9813824b-leaf";
const CWD = "D:\\Repos\\Apps\\clawd-on-desk";
const LIVE_HANDLE = "term_63323b46";
const STALE_HANDLE = "term_4602ecfa";

function terminalListPayload(terminals) {
  return JSON.stringify({ ok: true, result: { terminals } });
}

const DEFAULT_TERMINALS = [
  {
    handle: LIVE_HANDLE,
    tabId: "8ce1fff7-tab",
    leafId: "9813824b-leaf",
    worktreePath: "D:/Repos/Apps/clawd-on-desk",
  },
  {
    handle: "term_other",
    tabId: "other-tab",
    leafId: "other-leaf",
    worktreePath: "D:\\Repos\\Apps\\Brainstorm",
  },
];

// execFile mock speaking the `orca ... --json` contract. `switchResults` is
// consumed one entry per `terminal switch` so a stale-then-fresh retry can be
// scripted.
function mockOrcaCli(opts = {}) {
  const {
    terminals = DEFAULT_TERMINALS,
    listPayload = null,
    switchResults = [{ ok: true }],
    missingBinaries = [],
  } = opts;
  const calls = [];
  let switchIdx = 0;

  const mock = function (cmd, args, options, cb) {
    if (typeof options === "function") { cb = options; options = {}; }
    calls.push({ cmd, args: [...args] });

    if (missingBinaries.includes(cmd)) {
      const err = new Error(`spawn ${cmd} ENOENT`);
      err.code = "ENOENT";
      if (cb) cb(err, "", "");
      return;
    }

    const joined = args.join(" ");
    if (joined.startsWith("terminal list")) {
      if (cb) cb(null, listPayload !== null ? listPayload : terminalListPayload(terminals), "");
      return;
    }
    if (joined.startsWith("terminal switch")) {
      const result = switchResults[Math.min(switchIdx, switchResults.length - 1)];
      switchIdx += 1;
      if (result.ok) {
        if (cb) cb(null, JSON.stringify({ ok: true, result: { focus: { handle: args[3] } } }), "");
      } else {
        // A failing `--json` command still prints its envelope on stdout and
        // exits non-zero, so the error and the payload arrive together.
        if (cb) cb(new Error("exit 1"), JSON.stringify({ ok: false, error: { code: result.code } }), "");
      }
      return;
    }
    if (cb) cb(new Error(`unexpected args: ${joined}`), "", "");
  };

  return { mock, calls, switchCalls: () => calls.filter(c => c.args.join(" ").startsWith("terminal switch")) };
}

function withFocus(opts, fn) {
  const cliMock = mockOrcaCli(opts);
  const logs = [];
  const { initFocus, cleanup } = loadFocusWithMock(cliMock.mock, { platform: opts.platform || "darwin" });
  try {
    const api = initFocus({ focusLog: (m) => logs.push(String(m)) });
    return fn(api.__test, cliMock, logs);
  } finally {
    cleanup();
  }
}

// scheduleOrcaPaneFocus defers by ORCA_PANE_FOCUS_DELAY_MS and then runs one or
// two async CLI hops; give it a generous multiple so the assertions are stable.
function settle(t) {
  return new Promise((resolve) => setTimeout(resolve, t.ORCA_PANE_FOCUS_DELAY_MS + 250));
}

describe("orcaPaneKeyFromEnv / applyOrcaPaneKey", () => {
  it("reads the pane key only when TERM_PROGRAM confirms Orca", () => {
    assert.strictEqual(orcaPaneKeyFromEnv({ TERM_PROGRAM: "Orca", ORCA_PANE_KEY: PANE_KEY }), PANE_KEY);
    // A shell launched from an Orca terminal inherits ORCA_PANE_KEY; without the
    // TERM_PROGRAM confirmation it would claim a pane it does not own.
    assert.strictEqual(orcaPaneKeyFromEnv({ ORCA_PANE_KEY: PANE_KEY }), null);
    assert.strictEqual(orcaPaneKeyFromEnv({ TERM_PROGRAM: "tmux", ORCA_PANE_KEY: PANE_KEY }), null);
    assert.strictEqual(orcaPaneKeyFromEnv({ TERM_PROGRAM: "Orca", ORCA_PANE_KEY: "junk" }), null);
    assert.strictEqual(orcaPaneKeyFromEnv({ TERM_PROGRAM: "Orca" }), null);
    assert.strictEqual(orcaPaneKeyFromEnv({}), null);
    assert.strictEqual(orcaPaneKeyFromEnv(null), null);
  });

  it("adds orca_pane_key to a body only when the env supplies one", () => {
    assert.deepStrictEqual(
      applyOrcaPaneKey({ a: 1 }, { TERM_PROGRAM: "Orca", ORCA_PANE_KEY: PANE_KEY }),
      { a: 1, orca_pane_key: PANE_KEY }
    );
    assert.deepStrictEqual(applyOrcaPaneKey({ a: 1 }, {}), { a: 1 });
  });

  it("stays out of the frozen resolver result shape (#674 red line)", () => {
    // The pane key owes nothing to the process walk, and growing the no-arg
    // resolve() object is exactly what that red line forbids.
    const shared = require("../hooks/shared-process");
    assert.strictEqual(typeof shared.applyOrcaPaneKey, "function");
    assert.strictEqual(typeof shared.orcaPaneKeyFromEnv, "function");
  });
});

describe("Orca pane key normalization", () => {
  it("accepts a tabId:leafId pair and rejects anything else", () => {
    withFocus({}, (t) => {
      assert.strictEqual(t.normalizeOrcaPaneKey(PANE_KEY), PANE_KEY);
      assert.strictEqual(t.normalizeOrcaPaneKey(`  ${PANE_KEY}  `), PANE_KEY);
      assert.strictEqual(t.normalizeOrcaPaneKey("no-colon"), null);
      assert.strictEqual(t.normalizeOrcaPaneKey("tab:"), null);
      assert.strictEqual(t.normalizeOrcaPaneKey(":leaf"), null);
      assert.strictEqual(t.normalizeOrcaPaneKey("tab:leaf:extra"), null);
      assert.strictEqual(t.normalizeOrcaPaneKey("tab leaf:x"), null);
      assert.strictEqual(t.normalizeOrcaPaneKey(""), null);
      assert.strictEqual(t.normalizeOrcaPaneKey(null), null);
      assert.strictEqual(t.normalizeOrcaPaneKey(`${"a".repeat(300)}:b`), null);
    });
  });

  it("normalizes worktree paths across separators, trailing slash and case", () => {
    withFocus({}, (t) => {
      assert.strictEqual(
        t.normalizeOrcaWorktreePath("D:\\Repos\\Apps\\clawd-on-desk\\"),
        t.normalizeOrcaWorktreePath("d:/repos/apps/clawd-on-desk")
      );
      assert.strictEqual(t.normalizeOrcaWorktreePath("   "), null);
      assert.strictEqual(t.normalizeOrcaWorktreePath(null), null);
    });
  });

  it("carries orcaPaneKey through normalizeFocusRequest in both casings", () => {
    withFocus({}, (t) => {
      const fromCamel = t.normalizeFocusRequest({ sourcePid: 10, orcaPaneKey: PANE_KEY });
      const fromSnake = t.normalizeFocusRequest({ sourcePid: 10, orca_pane_key: PANE_KEY });
      const fromMeta = t.normalizeFocusRequest(10, CWD, null, null, { orca_pane_key: PANE_KEY });
      assert.strictEqual(fromCamel.orcaPaneKey, PANE_KEY);
      assert.strictEqual(fromSnake.orcaPaneKey, PANE_KEY);
      assert.strictEqual(fromMeta.orcaPaneKey, PANE_KEY);
      assert.strictEqual(t.normalizeFocusRequest({ sourcePid: 10, orcaPaneKey: "junk" }).orcaPaneKey, null);
    });
  });

  it("leaves the editor allowlist untouched so the VS Code tab route cannot misfire", () => {
    withFocus({}, (t) => {
      // scheduleTerminalTabFocus POSTs to the extension ports for any truthy
      // editor, so "orca" must never become an editor value.
      assert.strictEqual(t.normalizeFocusRequest({ sourcePid: 10, editor: "orca" }).editor, null);
      assert.strictEqual(t.normalizeFocusRequest({ sourcePid: 10, editor: "code" }).editor, "code");
      assert.strictEqual(t.normalizeFocusRequest({ sourcePid: 10, editor: "cursor" }).editor, "cursor");
    });
  });
});

describe("Orca CLI discovery", () => {
  it("prefers PATH and adds the known install path on Windows", () => {
    const prev = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = "C:\\Users\\t\\AppData\\Local";
    try {
      withFocus({ platform: "win32" }, (t) => {
        const candidates = t.orcaCliCandidates();
        assert.strictEqual(candidates[0], "orca");
        assert.ok(candidates.some(c => c === path.join(
          "C:\\Users\\t\\AppData\\Local", "Programs", "orca", "resources", "bin", "orca.exe")));
      });
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prev;
    }
  });

  it("relies on PATH alone off Windows", () => {
    withFocus({ platform: "darwin" }, (t) => {
      assert.deepStrictEqual(t.orcaCliCandidates(), ["orca"]);
    });
  });
});

describe("resolveOrcaHandle", () => {
  it("resolves the live handle from the pane key", async () => {
    await withFocus({}, (t) => new Promise((resolve) => {
      t.resolveOrcaHandle(PANE_KEY, CWD, (handle) => {
        assert.strictEqual(handle, LIVE_HANDLE);
        resolve();
      });
    }));
  });

  it("falls back to the worktree path when the pane is gone", async () => {
    await withFocus({}, (t) => new Promise((resolve) => {
      t.resolveOrcaHandle("dead-tab:dead-leaf", CWD, (handle) => {
        assert.strictEqual(handle, LIVE_HANDLE);
        resolve();
      });
    }));
  });

  it("returns null when neither the pane nor the worktree matches", async () => {
    await withFocus({}, (t) => new Promise((resolve) => {
      t.resolveOrcaHandle("dead-tab:dead-leaf", "D:\\Repos\\Apps\\Unknown", (handle) => {
        assert.strictEqual(handle, null);
        resolve();
      });
    }));
  });

  it("returns null on an ok:false envelope or unparseable output", async () => {
    await withFocus({ listPayload: JSON.stringify({ ok: false, error: { code: "runtime_unavailable" } }) },
      (t) => new Promise((resolve) => {
        t.resolveOrcaHandle(PANE_KEY, CWD, (handle) => {
          assert.strictEqual(handle, null);
          resolve();
        });
      }));

    await withFocus({ listPayload: "not json" }, (t) => new Promise((resolve) => {
      t.resolveOrcaHandle(PANE_KEY, CWD, (handle) => {
        assert.strictEqual(handle, null);
        resolve();
      });
    }));
  });
});

describe("scheduleOrcaPaneFocus", () => {
  it("resolves then switches on a cold cache and remembers the handle", async () => {
    await withFocus({}, async (t, cli, logs) => {
      t.orcaHandleCache.clear();
      t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
      await settle(t);
      assert.deepStrictEqual(cli.switchCalls().map(c => c.args[3]), [LIVE_HANDLE]);
      assert.ok(logs.some(l => l.includes("branch=orca reason=orca-pane-switched")), logs.join("|"));
      assert.strictEqual(t.orcaHandleCache.get(PANE_KEY), LIVE_HANDLE);
    });
  });

  it("re-resolves exactly once when a cached handle has gone stale", async () => {
    await withFocus({ switchResults: [{ ok: false, code: "terminal_handle_stale" }, { ok: true }] },
      async (t, cli, logs) => {
        t.orcaHandleCache.clear();
        t.orcaHandleCache.set(PANE_KEY, STALE_HANDLE);
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        // Stale cached handle first, then the freshly resolved one — and no third try.
        assert.deepStrictEqual(cli.switchCalls().map(c => c.args[3]), [STALE_HANDLE, LIVE_HANDLE]);
        assert.ok(logs.some(l => l.includes("reason=orca-pane-switched")), logs.join("|"));
        assert.strictEqual(t.orcaHandleCache.get(PANE_KEY), LIVE_HANDLE);
      });
  });

  it("does not retry when a freshly resolved handle is itself rejected as stale", async () => {
    await withFocus({ switchResults: [{ ok: false, code: "terminal_handle_stale" }] },
      async (t, cli, logs) => {
        t.orcaHandleCache.clear();
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        assert.strictEqual(cli.switchCalls().length, 1);
        assert.ok(logs.some(l => l.includes("reason=orca-handle-stale")), logs.join("|"));
        assert.strictEqual(t.orcaHandleCache.has(PANE_KEY), false);
      });
  });

  it("reports a non-stale switch failure without caching the handle", async () => {
    await withFocus({ switchResults: [{ ok: false, code: "terminal_not_writable" }] },
      async (t, cli, logs) => {
        t.orcaHandleCache.clear();
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        assert.ok(logs.some(l => l.includes("reason=orca-switch-failed")), logs.join("|"));
        assert.strictEqual(t.orcaHandleCache.has(PANE_KEY), false);
      });
  });

  it("reports pane-not-found instead of switching a guessed terminal", async () => {
    await withFocus({ terminals: [] }, async (t, cli, logs) => {
      t.orcaHandleCache.clear();
      t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
      await settle(t);
      assert.strictEqual(cli.switchCalls().length, 0);
      assert.ok(logs.some(l => l.includes("reason=orca-pane-not-found")), logs.join("|"));
    });
  });

  it("degrades quietly when the orca CLI is not installed", async () => {
    const prev = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      await withFocus({ platform: "darwin", missingBinaries: ["orca"] }, async (t, cli, logs) => {
        t.orcaHandleCache.clear();
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        assert.strictEqual(cli.switchCalls().length, 0);
        assert.ok(logs.some(l => l.includes("reason=orca-pane-not-found")), logs.join("|"));
      });
    } finally {
      if (prev !== undefined) process.env.LOCALAPPDATA = prev;
    }
  });

  it("is a no-op without a pane key", async () => {
    await withFocus({}, async (t, cli, logs) => {
      t.scheduleOrcaPaneFocus(null, CWD);
      t.scheduleOrcaPaneFocus("", CWD);
      await settle(t);
      assert.strictEqual(cli.calls.length, 0);
      assert.strictEqual(logs.length, 0);
    });
  });
});

describe("Windows Orca window fallback", () => {
  it("gates the Orca branch on the orcaHosted flag", () => {
    withFocus({ platform: "win32" }, (t) => {
      const off = t.makeFocusCmd(4242, ["clawd-on-desk"], null, null, "tok");
      const on = t.makeFocusCmd(4242, ["clawd-on-desk"], null, null, "tok", ["clawd-on-desk"], true);
      // Sixth-arg callers must keep working — the flag defaults to off.
      assert.match(off, /\$orcaHosted = \$false/);
      assert.match(on, /\$orcaHosted = \$true/);
      for (const script of [off, on]) {
        assert.match(script, /\$orcaProcessNames = @\('Orca'\)/);
        assert.match(script, /function Get-ClawdOrcaWindows/);
        assert.match(script, /if \(-not \$focused -and \$orcaHosted\)/);
        assert.match(script, /\$reason = 'orca-window'/);
        assert.match(script, /\$reason = 'orca-window-ambiguous'/);
        assert.match(script, /\$reason = 'orca-window-missing'/);
      }
    });
  });

  it("resolves the Orca window before the Windows Terminal fallbacks", () => {
    withFocus({ platform: "win32" }, (t) => {
      const script = t.makeFocusCmd(4242, ["clawd-on-desk"], null, null, "tok", ["clawd-on-desk"], true);
      // An Orca session with one unrelated WT window open would otherwise land
      // on 'wt-title-mismatch-single-wt-window' and focus that terminal.
      const orcaAt = script.indexOf("if (-not $focused -and $orcaHosted)");
      const walkAt = script.indexOf("for ($i = 0; $i -lt 8; $i++)");
      // Anchor on the assignment, not the bare reason string — the explanatory
      // comment above the Orca branch mentions that reason by name too.
      const wtFallbackAt = script.indexOf("$reason = 'wt-title-mismatch-single-wt-window'");
      assert.ok(orcaAt > 0 && walkAt > 0 && wtFallbackAt > 0);
      assert.ok(orcaAt < walkAt, "Orca branch must precede the process-tree walk");
      assert.ok(orcaAt < wtFallbackAt, "Orca branch must precede the WT fallbacks");
    });
  });

  it("never caches the Orca window, whose title cannot satisfy the cache check", () => {
    withFocus({ platform: "win32" }, (t) => {
      const script = t.makeFocusCmd(4242, ["clawd-on-desk"], "key", null, "tok", ["clawd-on-desk"], true);
      const block = script.slice(
        script.indexOf("if (-not $focused -and $orcaHosted)"),
        script.indexOf("if (-not $focused) {\nfor ($i = 0")
      );
      assert.ok(block.length > 0);
      assert.ok(!block.includes("Save-ClawdFocusCache"),
        "the Orca window title is just 'Orca', so a cached entry would fail Test-ClawdWindowTitleMatch");
    });
  });

  it("counts orca-window as a successful focus but not its ambiguous siblings", () => {
    withFocus({ platform: "win32" }, (t) => {
      assert.strictEqual(t.isPositiveFocusReason("orca-window"), true);
      assert.strictEqual(t.isPositiveFocusReason("orca-window-ambiguous"), false);
      assert.strictEqual(t.isPositiveFocusReason("orca-window-missing"), false);
    });
  });
});
