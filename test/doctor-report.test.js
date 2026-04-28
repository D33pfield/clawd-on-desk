const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  redact,
  redactDoctorResult,
  formatAgentDetail,
  formatDiagnosticReport,
} = require("../src/doctor-report");

describe("doctor report redaction", () => {
  it("redacts home paths across common platforms", () => {
    const text = [
      "C:\\Users\\Alice\\AppData\\Roaming",
      "/Users/bob/.codex/hooks.json",
      "/home/carol/.config/opencode/opencode.json",
    ].join("\n");

    const out = redact(text, { homeDir: "C:\\Users\\Alice" });
    assert.ok(!out.includes("Alice"));
    assert.ok(!out.includes("/Users/bob"));
    assert.ok(!out.includes("/home/carol"));
    assert.ok(out.includes("~/"));
  });

  it("redacts common secret shapes and non-loopback IP addresses", () => {
    const out = redact([
      "sk-abcdefghijklmnopqrstuvwxyz",
      "Bearer secret-token",
      "xoxb-123-secret",
      "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      "github_pat_abc123",
      "AKIA1234567890ABCDEF",
      '"password": "secret"',
      '"api_key": "secret"',
      "10.0.0.12",
      "127.0.0.1",
    ].join("\n"));

    assert.ok(!out.includes("secret-token"));
    assert.ok(!out.includes("10.0.0.12"));
    assert.ok(out.includes("127.0.0.1"));
    assert.ok(out.includes("[IP]"));
    assert.ok(out.includes("[REDACTED]"));
  });

  it("redacts nested doctor results before they are sent to the Settings UI", () => {
    const result = redactDoctorResult({
      checks: [{
        id: "agent-integrations",
        detail: "C:\\Users\\Alice\\.clawd\\runtime.json",
        details: [{
          agentName: "Cursor Agent",
          detail: "C:\\Users\\Alice\\.cursor\\hooks.json missing",
          opencodeEntry: "/Users/bob/.config/opencode/opencode.json",
        }],
      }],
    }, { homeDir: "C:\\Users\\Alice" });

    const text = JSON.stringify(result);
    assert.ok(!text.includes("Alice"));
    assert.ok(!text.includes("/Users/bob"));
    assert.ok(text.includes("~/.cursor"));
    assert.ok(text.includes("~/.config/opencode"));
  });
});

describe("formatDiagnosticReport", () => {
  it("formats structured agent diagnostics into visible detail text", () => {
    const detail = formatAgentDetail({
      detail: "hook registered",
      permissionBubbleDetail: "permission bubbles disabled for this agent",
      supplementary: {
        key: "codex_hooks",
        value: "uncertain",
        detail: "config missing",
      },
      kiroScan: {
        fullyValidFiles: ["clawd.json"],
        brokenFiles: ["custom.json"],
        noMarkerFiles: ["other.json"],
        corruptFiles: ["bad.json"],
      },
      opencodeEntryIssue: "directory-missing",
      opencodeEntry: "C:\\Users\\Alice\\opencode-plugin",
    });

    assert.match(detail, /permission bubbles disabled/);
    assert.match(detail, /codex_hooks=uncertain/);
    assert.match(detail, /valid=clawd\.json/);
    assert.match(detail, /broken=custom\.json/);
    assert.match(detail, /corrupt=bad\.json/);
    assert.match(detail, /no-marker=1/);
    assert.match(detail, /opencode issue: directory-missing/);
    assert.match(detail, /opencode entry:/);
  });

  it("formats summary and agent integration details", () => {
    const report = formatDiagnosticReport({
      generatedAt: "2026-04-28T14:32:00.000Z",
      overall: { status: "warning", issueCount: 1 },
      checks: [
        { id: "local-server", status: "pass", level: null, detail: "Listening on 127.0.0.1:23333" },
        {
          id: "agent-integrations",
          status: "warning",
          level: "warning",
          detail: "1 warning",
          details: [
            {
              agentId: "cursor-agent",
              agentName: "Cursor Agent",
              eventSource: "hook",
              status: "not-connected",
              detail: "C:\\Users\\Alice\\.cursor\\hooks.json missing",
              permissionBubbleDetail: "permission bubbles disabled for this agent",
              supplementary: {
                key: "codex_hooks",
                value: "uncertain",
                detail: "config missing",
              },
              kiroScan: {
                fullyValidFiles: ["clawd.json"],
                brokenFiles: [],
                noMarkerFiles: [],
                corruptFiles: [],
              },
              opencodeEntryIssue: "directory-missing",
            },
          ],
        },
      ],
    }, {
      version: "0.6.2",
      platform: "win32",
      release: "10.0.26200",
      locale: "zh",
      homeDir: "C:\\Users\\Alice",
    });

    assert.match(report, /# Clawd Diagnostic Report/);
    assert.match(report, /Overall: WARNING/);
    assert.match(report, /Cursor Agent/);
    assert.match(report, /permission bubbles disabled/);
    assert.match(report, /codex_hooks=uncertain/);
    assert.match(report, /valid=clawd\.json/);
    assert.match(report, /opencode issue: directory-missing/);
    assert.ok(!report.includes("Alice"));
    assert.ok(report.includes("~/.cursor"));
  });
});
