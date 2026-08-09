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
