"use strict";

// DSH (DeepSeek Harness) decision responses in src/permission.js's isDsh
// branch of resolvePermissionEntry:
//   - permission allow/deny → { decision: "allow" | "deny" }
//   - ask_user_question elicitation → { decision: "allow", answers:
//     [{ id, selected[], custom? }] } — rebuilt from the Claude-shaped
//     bubble result ({ questionText: answerText }) back to DSH's
//     per-question-id vocabulary
//   - desktop option submission arrives via handleDecide's shared
//     elicitation-submit branch, which stores the answers and re-enters
//     resolvePermissionEntry with "allow" — this module never sees the
//     submit object itself
//   - autoclose (no-decision) → socket destroyed, DSH fails closed

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initPermission = require("../src/permission");

function createMockResponse() {
  const captured = {
    statusCode: null,
    headers: {},
    body: null,
    ended: false,
    listeners: {},
    destroyed: false,
  };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
    },
    write(chunk) {
      captured.body = (captured.body || "") + String(chunk);
    },
    end(chunk) {
      if (chunk !== undefined) captured.body = (captured.body || "") + String(chunk);
      captured.ended = true;
      this.writableEnded = true;
    },
    on(evt, fn) {
      (captured.listeners[evt] = captured.listeners[evt] || []).push(fn);
    },
    removeListener() {},
    destroy() {
      captured.destroyed = true;
      this.destroyed = true;
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    focusTerminalCalls: [],
    focusTerminalForSession(sessionId) { this.focusTerminalCalls.push(sessionId); },
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    getPetWindowBounds: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    updateDebugLog: null,
    sessionDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    pendingPermissions: [],
    resolvePermissionEntry: () => {},
    sendPermissionResponse: () => {},
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    ...overrides,
  };
}

function makeDshPermissionEntry(overrides = {}) {
  const res = createMockResponse();
  return {
    res,
    abortHandler: () => {},
    suggestions: [],
    sessionId: "dsh-session-1",
    bubble: null,
    hideTimer: null,
    toolName: "pwsh",
    toolInput: { command: "Set-Content C:\\test.txt" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    isDsh: true,
    ...overrides,
  };
}

describe("DSH permission decisions", () => {
  it("sends { decision: allow } on allow", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions } = perm;
    const permEntry = makeDshPermissionEntry();
    pendingPermissions.push(permEntry);
    perm.resolvePermissionEntry(permEntry, "allow");
    const { captured } = permEntry.res;
    assert.equal(captured.statusCode, 200);
    assert.deepEqual(JSON.parse(captured.body), { decision: "allow" });
  });

  it("sends { decision: deny } on deny", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions } = perm;
    const permEntry = makeDshPermissionEntry();
    pendingPermissions.push(permEntry);
    perm.resolvePermissionEntry(permEntry, "deny", "user said no");
    assert.deepEqual(JSON.parse(permEntry.res.captured.body), { decision: "deny" });
  });

  it("destroys the socket on no-decision (autoclose → DSH fails closed)", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions } = perm;
    const permEntry = makeDshPermissionEntry();
    pendingPermissions.push(permEntry);
    perm.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected");
    assert.equal(permEntry.res.captured.destroyed, true);
  });
});

describe("DSH ask_user_question elicitation", () => {
  const wireQuestions = [
    {
      id: "q1",
      question: "你想做什么？",
      options: [{ label: "继续", description: "继续当前任务" }, { label: "停止" }],
    },
    { id: "q2", question: "输入备注", options: [] },
  ];

  function makeElicitationEntry(overrides = {}) {
    return makeDshPermissionEntry({
      toolName: "ask_user_question",
      toolInput: { questions: wireQuestions },
      isElicitation: true,
      ...overrides,
    });
  }

  it("rebuilds per-question-id answers from the bubble result on allow", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions } = perm;
    const permEntry = makeElicitationEntry();
    permEntry.resolvedUpdatedInput = {
      questions: wireQuestions,
      answers: { "你想做什么？": "继续", "输入备注": "自定义文本" },
    };
    pendingPermissions.push(permEntry);
    perm.resolvePermissionEntry(permEntry, "allow");
    const body = JSON.parse(permEntry.res.captured.body);
    assert.equal(body.decision, "allow");
    assert.deepEqual(body.answers, [
      { id: "q1", selected: ["继续"] },
      { id: "q2", selected: [], custom: "自定义文本" },
    ]);
  });

  it("drops answers for questions without an id (Claude-shaped questions)", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions } = perm;
    const permEntry = makeElicitationEntry({
      toolInput: { questions: [{ question: "无 id 的问题", options: [{ label: "A" }] }] },
    });
    permEntry.resolvedUpdatedInput = { answers: { "无 id 的问题": "A" } };
    pendingPermissions.push(permEntry);
    perm.resolvePermissionEntry(permEntry, "allow");
    assert.deepEqual(JSON.parse(permEntry.res.captured.body).answers, []);
  });

  it("sends a plain allow when resolved without a stored answer", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const { pendingPermissions } = perm;
    const permEntry = makeElicitationEntry();
    pendingPermissions.push(permEntry);
    perm.resolvePermissionEntry(permEntry, "allow");
    assert.deepEqual(JSON.parse(permEntry.res.captured.body), { decision: "allow" });
  });
});
