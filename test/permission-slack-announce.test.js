// Slack "approval needed" announcements must describe reality.
//
// Slack is notification-only in this build: the message tells the user to go
// approve something in the desktop app, and there is no follow-up "resolved"
// message to correct it. So the announce point matters more than it would for
// an interactive channel — a ping for a request Clawd auto-approved a
// microsecond later sends the user to an app with nothing to approve.
//
// The announce therefore happens where a human decision is known to be pending:
//   - showPermissionBubble, AFTER the automation chokepoint declined the entry
//     (DND / per-agent / headless gates already ran earlier in the route), and
//   - maybeStartRemoteApproval, for bubble-less remote-only entries.
// Never from addPendingPermission, which only means "the route queued it".

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initPermission = require("../src/permission");
const {
  classifyPermissionInteraction,
} = require("../src/permission-automation-policy");

function makeCapturingRes() {
  const captured = { statusCode: null, body: "", destroyCalls: 0 };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(status) { captured.statusCode = status; this.headersSent = true; },
    end(chunk) { if (chunk !== undefined) captured.body += String(chunk); this.writableEnded = true; },
    destroy() { captured.destroyCalls++; this.destroyed = true; },
    on() {},
    removeListener() {},
  };
}

function makeCtx(overrides = {}) {
  const announced = [];
  const ctx = {
    lang: "en",
    focusTerminalForSession() {},
    getSettingsSnapshot: () => ({}),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    getPermissionAutomationMode: () => "off",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    pendingPermissions: [],
    sessions: new Map(),
    sendPermissionResponse: () => {},
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    notifySlackPermission: (payload) => { announced.push(payload); },
    ...overrides,
  };
  ctx.announced = announced;
  return ctx;
}

function makePermEntry(overrides = {}) {
  const entry = {
    res: makeCapturingRes(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "session-test",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "rm -rf /", description: "clean the tree" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    agentId: "claude-code",
    ...overrides,
  };
  entry.interaction = overrides.interaction || classifyPermissionInteraction({
    agentId: entry.agentId,
    eventKind: entry.isCodexNotify || entry.isKimiNotify ? "passive-notification" : "permission",
    toolName: entry.toolName,
  });
  return entry;
}

describe("slack permission announce: only for requests a human must answer", () => {
  it("does not announce when the entry is merely queued", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    perm.addPendingPermission(makePermEntry(), "added");
    assert.deepEqual(ctx.announced, []);
  });

  it("announces once when the request survives to a bubble", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    // No Electron in tests: the bubble build throws right after the announce.
    assert.throws(() => perm.showPermissionBubble(entry));
    assert.equal(ctx.announced.length, 1);
    assert.match(ctx.announced[0].title, /Bash/);
    assert.equal(ctx.announced[0].toolName, "Bash");
    assert.equal(ctx.announced[0].agentId, "claude-code");

    // A retry (repositioning, re-show) must not ping Slack twice.
    assert.throws(() => perm.showPermissionBubble(entry));
    assert.equal(ctx.announced.length, 1);
  });

  it("stays silent when global automation auto-approves the request", () => {
    const ctx = makeCtx({ getPermissionAutomationMode: () => "unattended" });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    perm.showPermissionBubble(entry);

    assert.equal(perm.pendingPermissions.includes(entry), false, "entry was auto-approved");
    assert.equal(JSON.parse(entry.res.captured.body).hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(ctx.announced, [], "no Slack ping for a request nobody had to answer");
  });

  it("stays silent when auto-tools auto-approves an ordinary tool", () => {
    const ctx = makeCtx({ getPermissionAutomationMode: () => "auto-tools" });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    perm.showPermissionBubble(entry);

    assert.equal(perm.pendingPermissions.includes(entry), false);
    assert.deepEqual(ctx.announced, []);
  });

  it("still announces the questions auto-tools defers to a human", () => {
    // The mirror image of the two cases above: same mode, same chokepoint, but
    // auto-tools refuses to answer a question on the user's behalf — so this
    // one really is waiting on them and Slack should say so.
    const ctx = makeCtx({ getPermissionAutomationMode: () => "auto-tools" });
    const perm = initPermission(ctx);
    const entry = makePermEntry({
      toolName: "AskUserQuestion",
      isElicitation: true,
      toolInput: { questions: [{ question: "Which one?" }] },
    });
    perm.addPendingPermission(entry, "added");

    assert.throws(() => perm.showPermissionBubble(entry));
    assert.equal(perm.pendingPermissions.includes(entry), true);
    assert.equal(ctx.announced.length, 1);
  });

  it("does not announce plan reviews, which are not remote-actionable", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry({ toolName: "ExitPlanMode", toolInput: { plan: "ship it" } });
    perm.addPendingPermission(entry, "added");

    assert.throws(() => perm.showPermissionBubble(entry));
    assert.equal(perm.pendingPermissions.includes(entry), true);
    assert.deepEqual(ctx.announced, []);
  });

  it("stays silent when a session automation override auto-approves", () => {
    const ctx = makeCtx({
      getEffectivePermissionAutomationMode: () => "auto-tools",
      hasSessionAutomationOverride: () => true,
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry({
      sessionAutomationIdentity: { eligible: true, reason: "verified" },
    });
    perm.addPendingPermission(entry, "added");

    perm.showPermissionBubble(entry);

    assert.equal(perm.pendingPermissions.includes(entry), false);
    assert.deepEqual(ctx.announced, []);
  });

  it("announces when a session override fails the live gate and a human must decide", () => {
    const ctx = makeCtx({
      getEffectivePermissionAutomationMode: () => "auto-tools",
      hasSessionAutomationOverride: () => true,
      isAgentPermissionsEnabled: () => false,
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry({
      sessionAutomationIdentity: { eligible: true, reason: "verified" },
    });
    perm.addPendingPermission(entry, "added");

    assert.throws(() => perm.showPermissionBubble(entry));
    assert.equal(perm.pendingPermissions.includes(entry), true);
    assert.equal(ctx.announced.length, 1);
  });

  it("stays silent under Do Not Disturb", () => {
    // DND drops the request before it surfaces anywhere locally; a Slack ping
    // would be the one channel that still reached the user.
    const ctx = makeCtx({ doNotDisturb: true });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    assert.throws(() => perm.showPermissionBubble(entry));
    assert.deepEqual(ctx.announced, []);
  });

  it("stays silent for passive notifications, which are not approvals", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry({ isCodexNotify: true, agentId: "codex", res: null });
    perm.addPendingPermission(entry, "added");

    assert.throws(() => perm.showPermissionBubble(entry));
    assert.deepEqual(ctx.announced, []);
  });

  it("stays silent for headless sessions, which have no desktop app to go to", () => {
    const ctx = makeCtx({
      sessions: new Map([["session-test", { agentId: "claude-code", headless: true }]]),
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ headless: true });
    perm.addPendingPermission(entry, "added");

    assert.throws(() => perm.showPermissionBubble(entry));
    assert.deepEqual(ctx.announced, []);
  });

  it("survives a throwing Slack notifier without breaking the bubble path", () => {
    const ctx = makeCtx({
      notifySlackPermission: () => { throw new Error("slack exploded"); },
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    // The only throw that escapes is the (Electron-less) bubble build, not Slack.
    assert.throws(
      () => perm.showPermissionBubble(entry),
      (err) => !/slack exploded/.test(String(err && err.message)),
    );
    assert.equal(perm.pendingPermissions.includes(entry), true);
  });
});

describe("slack permission announce: remote-only entries", () => {
  function makeRemoteCtx(overrides = {}) {
    return makeCtx({
      getTelegramApprovalClient: () => null,
      ...overrides,
    });
  }

  it("announces a bubble-less entry once a remote client takes it", () => {
    const requested = [];
    const client = {
      requestApproval: (payload) => { requested.push(payload); return new Promise(() => {}); },
    };
    const ctx = makeRemoteCtx({ getRemoteApprovalClients: () => [{ name: "telegram", client }] });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ bubble: null, remoteOnly: true });
    perm.addPendingPermission(entry, "added");

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(requested.length, 1);
    assert.equal(ctx.announced.length, 1);
  });

  it("does not announce when no remote client picks the entry up", () => {
    const ctx = makeRemoteCtx({ getRemoteApprovalClients: () => [] });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ bubble: null, remoteOnly: true });
    perm.addPendingPermission(entry, "added");

    assert.equal(perm.maybeStartRemoteApproval(entry), false);
    assert.deepEqual(ctx.announced, []);
  });

  it("does not announce an entry that automation already resolved out of the queue", () => {
    const client = { requestApproval: () => new Promise(() => {}) };
    const ctx = makeRemoteCtx({ getRemoteApprovalClients: () => [{ name: "telegram", client }] });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ bubble: null, remoteOnly: true });
    // Never queued (or already resolved out) — maybeStartRemoteApproval bails.
    assert.equal(perm.maybeStartRemoteApproval(entry), false);
    assert.deepEqual(ctx.announced, []);
  });
});

// ── Interaction kind and action target (review item 4) ──────────────────────
// The announce ran every entry through the approval summary builder. For an
// AskUserQuestion that builder can never find a description, so Slack received
// "No description available" and told the reader to approve something that is
// actually a question — one that capabilities.allowDeny says cannot be approved.

function makeQuestionEntry(overrides = {}) {
  return makePermEntry({
    toolName: "AskUserQuestion",
    toolInput: {
      questions: [
        { header: "Rollout", question: "Which environment?",
          options: [{ label: "staging" }, { label: "production" }] },
      ],
    },
    interaction: classifyPermissionInteraction({
      agentId: "claude-code",
      eventKind: "permission",
      toolName: "AskUserQuestion",
    }),
    ...overrides,
  });
}

describe("slack announce: interaction kind and action target", () => {
  it("sends the questions themselves for an AskUserQuestion", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makeQuestionEntry();
    perm.addPendingPermission(entry, "added");
    assert.throws(() => perm.showPermissionBubble(entry));

    assert.equal(ctx.announced.length, 1);
    const payload = ctx.announced[0];
    assert.equal(payload.kind, "question");
    assert.ok(Array.isArray(payload.questions), "the questions must reach the renderer");
    assert.equal(payload.questions[0].question, "Which environment?");
    // The generic approval fallback must not be what describes it.
    assert.ok(!/No description available/i.test(payload.summary || ""),
      "the question content replaces the approval summary, not sits beside it");
  });

  it("marks an ordinary tool request as an approval decided on the desktop", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    assert.throws(() => perm.showPermissionBubble(entry));

    assert.equal(ctx.announced[0].kind, "approval");
    assert.equal(ctx.announced[0].actionTarget, "desktop");
  });

  it("marks a remote-only entry as decided in the remote channel", () => {
    // Bubbles are disabled for this agent, so there is no desktop bubble to
    // point at — the usable action is in Telegram/Feishu.
    const client = { requestApproval: () => new Promise(() => {}) };
    const ctx = makeCtx({
      getTelegramApprovalClient: () => null,
      getRemoteApprovalClients: () => [{ name: "telegram", client }],
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ remoteOnly: true, bubble: null });
    perm.addPendingPermission(entry, "added");

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(ctx.announced.length, 1);
    assert.equal(ctx.announced[0].actionTarget, "remote");
  });

  it("does not announce from the remote path for an entry that has a bubble", () => {
    // maybeStartRemoteApproval runs for ordinary bubbled entries too (codex,
    // qwen, CC elicitation all call it). Only remote-only entries should be
    // labelled "decide remotely" from there.
    const client = { requestApproval: () => new Promise(() => {}) };
    const ctx = makeCtx({
      getTelegramApprovalClient: () => null,
      getRemoteApprovalClients: () => [{ name: "telegram", client }],
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry(); // remoteOnly is falsy
    perm.addPendingPermission(entry, "added");

    perm.maybeStartRemoteApproval(entry);
    assert.deepEqual(ctx.announced, [],
      "a bubbled entry announces from showPermissionBubble, with the desktop target");
  });
});

// ── When the bubble fails after the heads-up has gone out (review item 4) ───
// A webhook message cannot be edited or deleted. If the bubble then fails, the
// request falls back to the agent's own terminal prompt, so the already-sent
// "approve in the desktop app" becomes untrue with no way to unsend it. We
// cannot retract, so we correct.

describe("slack announce: the desktop bubble fails after announcing", () => {
  function makeFailCtx(overrides = {}) {
    const corrections = [];
    const ctx = makeCtx({
      notifySlackBubbleFailed: (payload) => corrections.push(payload),
      ...overrides,
    });
    ctx.corrections = corrections;
    return ctx;
  }

  it("corrects a heads-up that has already been sent", () => {
    const ctx = makeFailCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    assert.throws(() => perm.showPermissionBubble(entry));
    assert.equal(ctx.announced.length, 1, "precondition: the heads-up went out");

    // What failPermissionBubble does when the renderer never comes up.
    perm.failPermissionBubbleForTest(entry, "did-fail-load");

    assert.equal(ctx.corrections.length, 1, "the reader must be told it moved");
    assert.equal(ctx.corrections[0].agentId, "claude-code");
  });

  it("sends no correction when nothing was announced", () => {
    // Auto-approved: no heads-up was sent, so there is nothing to correct and a
    // bare "it went back to the terminal" message would be baffling.
    const ctx = makeFailCtx({ getPermissionAutomationMode: () => "unattended" });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    perm.showPermissionBubble(entry);
    assert.deepEqual(ctx.announced, []);

    perm.failPermissionBubbleForTest(entry, "did-fail-load");
    assert.deepEqual(ctx.corrections, []);
  });

  it("corrects at most once even if several failures fire", () => {
    const ctx = makeFailCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    assert.throws(() => perm.showPermissionBubble(entry));

    perm.failPermissionBubbleForTest(entry, "did-fail-load");
    perm.failPermissionBubbleForTest(entry, "render-process-gone");
    assert.equal(ctx.corrections.length, 1);
  });
});

describe("slack announce: main.js wiring", () => {
  // These two ctx hooks are supplied by main.js. Either could be perfectly
  // implemented here and simply never wired, and no behavioural test in this
  // file could tell — they all inject their own ctx.
  it("both Slack ctx hooks are actually provided by the main process", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(source, /notifySlackPermission:\s*\(payload\)\s*=>/,
      "main.js must provide notifySlackPermission");
    assert.match(source, /notifySlackBubbleFailed:\s*\(payload\)\s*=>/,
      "main.js must provide notifySlackBubbleFailed");
    assert.match(source, /client\.notifyBubbleFailed\(payload\)/,
      "and route it to the Slack client");
  });
});
