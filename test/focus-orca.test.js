// test/focus-orca.test.js — Orca window raise + pane-level focus switching
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { loadFocusWithMock } = require("./helpers/load-focus-with-mock");

const { orcaPaneKeyFromEnv, applyOrcaPaneKey, NESTED_TERMINAL_ENV } = require("../hooks/shared-process");

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
    timeoutOn = [],
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

    // Window-raise helpers used off Windows; they carry no payload.
    if (cmd === "/usr/bin/open" || cmd === "wmctrl" || cmd === "xdotool") {
      if (cb) cb(null, "", "");
      return;
    }

    const joined = args.join(" ");
    if (timeoutOn.some((prefix) => joined.startsWith(prefix))) {
      // execFile's own timeout kill: non-zero exit, empty stdout, killed set.
      const err = new Error(`spawn ${cmd} ETIMEDOUT`);
      err.killed = true;
      if (cb) cb(err, "", "");
      return;
    }
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

  it("rejects a pane key inherited by a terminal launched inside the pane", () => {
    // Launch a terminal from inside an Orca pane and the child inherits
    // TERM_PROGRAM and ORCA_PANE_KEY while living in its own window. A pane key
    // outranks every other signal in the focus script, so that copy would raise
    // Orca instead of the terminal the agent is really in.
    assert.ok(NESTED_TERMINAL_ENV.length >= 10, "expected the full nested-terminal marker list");
    for (const marker of NESTED_TERMINAL_ENV) {
      const env = { TERM_PROGRAM: "Orca", ORCA_PANE_KEY: PANE_KEY, [marker]: "1" };
      assert.strictEqual(orcaPaneKeyFromEnv(env), null, `${marker} must veto the pane key`);
      assert.deepStrictEqual(applyOrcaPaneKey({ a: 1 }, env), { a: 1 });
    }

    // tmux is on the list rather than exempt from it: the server outlives the pane
    // it was started from, so re-attaching the session from another terminal would
    // carry a stale key. tmux >= 3.2 also sets TERM_PROGRAM=tmux, which the
    // TERM_PROGRAM check rejects on its own.
    assert.ok(NESTED_TERMINAL_ENV.includes("TMUX"));
  });

  it("adds orca_pane_key to a body only when the env supplies one", () => {
    assert.deepStrictEqual(
      applyOrcaPaneKey({ a: 1 }, { TERM_PROGRAM: "Orca", ORCA_PANE_KEY: PANE_KEY }),
      { a: 1, orca_pane_key: PANE_KEY }
    );
    assert.deepStrictEqual(applyOrcaPaneKey({ a: 1 }, {}), { a: 1 });
  });

  // The pane key is read per body rather than added to the resolver result: the
  // #674 no-arg red line freezes that shape (defended by the NO_ARG_FIELDS
  // assertion in test/pid-resolver-context.test.js), and reading it per body also
  // survives a cache hit and a failed snapshot, neither of which has room for it.
  // The cost is that every producer needs its own line, so check them by source.
  it("is carried by every producer that reports a process chain for focus", () => {
    const fs = require("fs");
    const hooksDir = path.join(__dirname, "..", "hooks");
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|py)$/.test(entry.name)) files.push(full);
      }
    };
    walk(hooksDir);

    // AGENTS.md:155 — OpenClaw's Phase 1 integration is state-only, with no
    // permission bubble and no terminal focus, so it has nothing to focus.
    const stateOnly = new Set([path.join("openclaw-plugin", "index.js")]);

    const missing = [];
    for (const file of files) {
      if (stateOnly.has(path.relative(hooksDir, file))) continue;
      const src = fs.readFileSync(file, "utf8");
      // pid_chain, not tmux_client: a producer that reports a process chain is one
      // whose sessions can be focus targets, whether or not it ever grew tmux
      // support.
      if (!/["']?pid_chain["']?\s*[:=]/.test(src)) continue;
      // A CALL, not a mention: matching the bare name meant the `applyOrcaPaneKey`
      // in a producer's require destructure satisfied this on its own, so deleting
      // the actual call left an unused import and a green suite — and there is no
      // linter here to flag the orphan.
      if (!src.includes("orca_pane_key") && !/applyOrcaPaneKey\s*\(/.test(src)) {
        missing.push(path.relative(hooksDir, file));
      }
    }
    assert.deepStrictEqual(missing, [], "focus-capable producers missing orca_pane_key");
  });
});

describe("Orca pane key validator copies", () => {
  const fs = require("fs");
  const repo = path.join(__dirname, "..");
  // Duplicated rather than shared because pi-extension-core.js and the
  // opencode-family plugin each ship standalone, and the tmux siblings set that
  // precedent. Nothing but this test keeps the copies in step.
  const jsCopies = [
    "hooks/shared-process.js",
    "hooks/pi-extension-core.js",
    "hooks/opencode-family-plugin/core.mjs",
    "src/server-route-state.js",
    "src/server-route-permission.js",
    "src/focus.js",
  ];

  it("shares one pattern across every copy", () => {
    for (const rel of jsCopies) {
      const src = fs.readFileSync(path.join(repo, rel), "utf8");
      const at = src.indexOf("/^[\\w-]+:[\\w-]+$/");
      assert.ok(at > 0, `${rel} must use the canonical pane-key pattern`);
      // Scoped to the validator: these files carry unrelated .trim() calls, so a
      // whole-file match would pass no matter what the validator itself did.
      assert.ok(src.slice(Math.max(0, at - 400), at).includes(".trim()"),
        `${rel} must trim before matching`);
    }
    const py = fs.readFileSync(path.join(repo, "hooks/hermes-plugin/__init__.py"), "utf8");
    assert.ok(py.includes(String.raw`r"[\w-]+:[\w-]+"`), "the Python copy must use the same pattern");
    assert.ok(/re\.fullmatch\(r"\[\\w-\]\+:\[\\w-\]\+", pane_key, re\.ASCII\)/.test(py),
      "the Python copy must pin \\w to ASCII so it is not laxer than the JS copies");
  });

  // This gate is what decides whether Clawd hijacks focus to Orca. A marker added
  // to shared-process.js alone would leave the standalone copies trusting an
  // inherited key, with the wrong window reported as a successful focus.
  it("keeps the nested-terminal marker list in step across every copy", () => {
    for (const rel of ["hooks/pi-extension-core.js", "hooks/opencode-family-plugin/core.mjs",
      "hooks/hermes-plugin/__init__.py"]) {
      const src = fs.readFileSync(path.join(repo, rel), "utf8");
      const match = /NESTED_TERMINAL_ENV\s*=\s*[[(]/.exec(src);
      assert.ok(match, `${rel} must declare the nested-terminal marker list`);
      const list = src.slice(match.index, match.index + 400);
      for (const marker of NESTED_TERMINAL_ENV) {
        assert.ok(list.includes(`"${marker}"`), `${rel} is missing ${marker} from the list`);
      }
    }
  });
});

describe("Orca window raise stays in the focus script", () => {
  // The raise is the generated PowerShell's job ($orcaProcessNames), so this path
  // must spawn nothing but the `orca` CLI. A by-name raise from Node was tried and
  // deliberately dropped: macOS and Linux are unverified on real hardware, and
  // WM_CLASS "orca" also matches GNOME's screen reader, so a miss would have
  // activated the wrong window and logged it as a success.
  for (const platform of ["win32", "darwin", "linux"]) {
    it(`spawns only the orca CLI on ${platform}`, async () => {
      await withFocus({ platform }, async (t, cli) => {
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        const strays = cli.calls.filter((c) => !/(^|[\\/])orca(\.exe)?$/i.test(c.cmd));
        assert.deepStrictEqual(strays.map((c) => c.cmd), [],
          `no window-raise helper may be spawned from Node: ${JSON.stringify(cli.calls)}`);
        assert.ok(cli.switchCalls().length > 0, "the pane switch still runs");
      });
    });
  }
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

  it("normalizes separators and trailing slash, folding case only where the filesystem does", () => {
    withFocus({ platform: "win32" }, (t) => {
      assert.strictEqual(
        t.normalizeOrcaWorktreePath("D:\\Repos\\Apps\\clawd-on-desk\\"),
        t.normalizeOrcaWorktreePath("d:/repos/apps/clawd-on-desk")
      );
    });
    withFocus({ platform: "linux" }, (t) => {
      // Here these are two different directories, and folding them would make the
      // worktree fallback pick whichever pane happens to be listed first.
      assert.notStrictEqual(
        t.normalizeOrcaWorktreePath("/home/kai/work/Repo"),
        t.normalizeOrcaWorktreePath("/home/kai/work/repo")
      );
      assert.strictEqual(
        t.normalizeOrcaWorktreePath("/home/kai/work/repo/"),
        t.normalizeOrcaWorktreePath("/home/kai/work/repo")
      );
      assert.strictEqual(t.normalizeOrcaWorktreePath("   "), null);
      assert.strictEqual(t.normalizeOrcaWorktreePath(null), null);
    });
  });

  it("falls back to the worktree when the agent's cwd sits below its root", async () => {
    await withFocus({ platform: "linux" }, async (t, cli) => {
      // Routine shape: the pane is gone and the agent's cwd is a subdirectory of
      // the worktree, which an exact match would report as orca-pane-not-found.
      t.scheduleOrcaPaneFocus("gone-tab:gone-leaf", "D:\\Repos\\Apps\\clawd-on-desk\\src\\hooks");
      await settle(t);
      const switches = cli.switchCalls();
      assert.strictEqual(switches.length, 1, "expected the worktree fallback to switch");
      assert.strictEqual(switches[0].args[3], LIVE_HANDLE);
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

  it("prefers the longest matching worktree so a nested session keeps its own tab", async () => {
    const terminals = [
      { handle: "term_outer", tabId: "outer", leafId: "leaf", worktreePath: "D:/Repos/Apps" },
      { handle: "term_inner", tabId: "inner", leafId: "leaf", worktreePath: "D:/Repos/Apps/clawd-on-desk" },
    ];
    await withFocus({ terminals }, async (t) => {
      const handle = await new Promise((resolve) => {
        t.resolveOrcaHandle("gone-tab:gone-leaf", `${CWD}\\src`, (h) => resolve(h));
      });
      // Both worktrees are prefixes of the cwd and the outer one is listed first;
      // taking it would switch a different session's tab and still log a success.
      assert.strictEqual(handle, "term_inner");
    });
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
        // Not orca-pane-not-found: "Orca is not installed / not on PATH" and
        // "that pane is gone" need different fixes, and focus-debug.log is the
        // only place anyone will see the difference.
        assert.ok(logs.some(l => l.includes("reason=orca-cli-not-found")), logs.join("|"));
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
        assert.match(script, /if \(\$orcaHosted\) \{/);
        assert.match(script, /\$reason = 'orca-window'/);
        assert.match(script, /\$reason = 'orca-window-ambiguous'/);
        assert.match(script, /\$reason = 'orca-window-missing'/);
      }
    });
  });

  it("tries the Orca window before every other branch in the script", () => {
    withFocus({ platform: "win32" }, (t) => {
      const script = t.makeFocusCmd(4242, ["clawd-on-desk"], "key", 4660, "tok", ["clawd-on-desk"], true);
      const orcaAt = script.indexOf("if ($orcaHosted) {");
      const cacheAt = script.indexOf("$reason = 'cached-window'");
      const wtHwndAt = script.indexOf("$reason = 'wt-hwnd-from-hook'");
      const walkAt = script.indexOf("for ($i = 0; $i -lt 8; $i++)");
      // Anchor on the assignment, not the bare reason string — the explanatory
      // comment above the Orca branch mentions that reason by name too.
      const wtFallbackAt = script.indexOf("$reason = 'wt-title-mismatch-single-wt-window'");
      assert.ok(orcaAt > 0 && cacheAt > 0 && wtHwndAt > 0 && walkAt > 0 && wtFallbackAt > 0);
      for (const [label, at] of [["cached-window", cacheAt], ["wt-hwnd-from-hook", wtHwndAt],
        ["the process-tree walk", walkAt], ["the WT title fallbacks", wtFallbackAt]]) {
        assert.ok(orcaAt < at, `Orca branch must precede ${label}`);
      }
    });
  });

  it("keeps a recorded wt_hwnd and a stale cache from pre-empting an Orca session", () => {
    withFocus({ platform: "win32" }, (t) => {
      // Both fields ride the same request: wt_hwnd is whatever happened to be
      // foreground when the hook fired (hooks/shared-process.js foregroundWtHwnd),
      // and src/state.js makes it sticky, so one SessionStart next to a Windows
      // Terminal window would otherwise focus that terminal for the rest of the
      // session — and report it as a success.
      const script = t.makeFocusCmd(4242, ["clawd-on-desk"], "key", 4660, "tok", ["clawd-on-desk"], true);
      assert.match(script, /\$wtHwndFromHook = \[IntPtr\]\(\[int64\]4660\)/);
      assert.match(script, /\$orcaHosted = \$true/);
      assert.ok(script.includes("if (-not $focused -and -not $orcaHosted) {"),
        "the window cache must be gated off for Orca sessions");
      // Get-ClawdCachedWindow evicts the stored entry on a validation miss, so it
      // has to be read inside that gate rather than before it — otherwise an Orca
      // focus drops another path's cache entry as a side effect.
      const cacheGateAt = script.indexOf("if (-not $focused -and -not $orcaHosted) {");
      const cacheReadAt = script.indexOf("$cachedHwnd = Get-ClawdCachedWindow");
      assert.ok(cacheGateAt > 0 && cacheReadAt > cacheGateAt,
        "the cache must not be read, and evicted, ahead of the Orca gate");
      assert.ok(script.includes("if (-not $focused -and -not $orcaHosted -and $wtHwndFromHook -ne [IntPtr]::Zero)"),
        "the recorded wt_hwnd must be gated off for Orca sessions");
      // On orca-window-missing the reason must stay negative rather than being
      // overwritten by a fallback that focused an unrelated window.
      assert.strictEqual(t.isPositiveFocusReason("orca-window-missing"), false);

      // Gating those two off must not also lock out the console recovery further
      // down, which is an identity signal rather than a guess: its reason
      // whitelist has to accept the Orca branch's negative outcomes.
      const conhostGate = script.slice(script.indexOf("$pendingConsoleHwnd -ne [IntPtr]::Zero) {"));
      assert.match(conhostGate, /\$reason -eq 'orca-window-missing'/);
      assert.match(conhostGate, /\$reason -eq 'orca-window-ambiguous'/);
      // The WT title guess stays locked out, though — for an Orca session it can
      // only ever name an unrelated terminal.
      assert.ok(script.includes("if (-not $focused -and $reason -eq 'no-parent-window') {"),
        "the WT title fallback must stay gated on no-parent-window alone");
    });
  });

  it("never caches the Orca window, whose title cannot satisfy the cache check", () => {
    withFocus({ platform: "win32" }, (t) => {
      const script = t.makeFocusCmd(4242, ["clawd-on-desk"], "key", null, "tok", ["clawd-on-desk"], true);
      const block = script.slice(
        script.indexOf("if ($orcaHosted) {"),
        script.indexOf("$cachedHwnd = Get-ClawdCachedWindow")
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

describe("Orca CLI that never answers", () => {
  // Warm round-trips are ~400ms, but the first call after Orca has been idle can
  // exceed the timeout and get killed. Reporting that as a missing pane sends
  // whoever reads focus-debug.log looking in entirely the wrong place.
  for (const step of ["terminal list", "terminal switch"]) {
    it(`reports a killed \`${step}\` as a timeout rather than a missing pane`, async () => {
      await withFocus({ platform: "win32", timeoutOn: [step] }, async (t, cli, logs) => {
        t.scheduleOrcaPaneFocus(PANE_KEY, CWD);
        await settle(t);
        assert.ok(logs.some((l) => l.includes("reason=orca-cli-timeout")),
          `expected orca-cli-timeout, got ${JSON.stringify(logs)}`);
        assert.ok(!logs.some((l) => /orca-pane-not-found|orca-switch-failed/.test(l)),
          `a timeout must not be reported as pane-not-found or switch-failed: ${JSON.stringify(logs)}`);
      });
    });
  }
});

describe("Orca focus wiring", () => {
  // The Windows dispatch itself is driven through the public focusTerminalWindow in
  // test/focus-windows.test.js, which mocks spawn so the real helper never starts.
  it("is dispatched from the Windows branch alone", () => {
    const fs = require("fs");
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "focus.js"), "utf8");
    const calls = src.match(/scheduleOrcaPaneFocus\(request\./g) || [];
    // Off Windows there is no raise, so a pane switch there would move a tab in a
    // window that never comes forward — worse than doing nothing.
    assert.strictEqual(calls.length, 1, "expected exactly one platform dispatch");
    const linuxBranch = src.slice(src.indexOf("branch=linux-command-submitted") - 800);
    assert.ok(!/scheduleOrcaPaneFocus/.test(linuxBranch.slice(0, 800)),
      "the Linux branch must not dispatch the pane switch");
  });

  it("carries the pane key through every focus-entry builder", () => {
    const fs = require("fs");
    const repo = path.join(__dirname, "..");
    // These assignments are the only thing putting the pane key on the entries that
    // reach normalizeFocusRequest and the Direct Send paste delay, and the
    // permission bubble's "go to terminal" is the gesture the whole feature exists
    // for. No fixture in test/permission-*.test.js sets a pane key, so deleting one
    // of these lines otherwise fails nothing. The snapshot entry is a whitelist:
    // omit it there and the field silently never reaches Telegram Direct Send.
    const sites = [
      ["src/main.js", "if (entry.orcaPaneKey) focusEntry.orcaPaneKey = entry.orcaPaneKey;"],
      ["src/main.js", "orcaPaneKey: session.orcaPaneKey,"],
      ["src/permission.js", "if (perm.orcaPaneKey) focusEntry.orcaPaneKey = perm.orcaPaneKey;"],
      ["src/state-session-snapshot.js", "orcaPaneKey: (session && session.orcaPaneKey) || null,"],
    ];
    for (const [rel, needle] of sites) {
      const src = fs.readFileSync(path.join(repo, rel), "utf8");
      assert.ok(src.includes(needle), `${rel} must carry the pane key: ${needle}`);
    }
  });
});
