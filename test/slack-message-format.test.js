"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const fmt = require("../src/slack-message-format");

test("buildCompletionMessage renders a done card with fallback text", () => {
  const msg = fmt.buildCompletionMessage(
    { id: "abc123def", displayTitle: "Build", badge: "done", cwd: "/x/proj", agentId: "claude" },
    { lang: "en" },
  );
  assert.ok(msg.text.startsWith("✅"));
  assert.equal(msg.blocks[0].type, "header");
  assert.ok(msg.blocks[0].text.text.includes("Build"));
  // metadata line includes the folder + short id
  const section = msg.blocks[1].text.text;
  assert.ok(section.includes("proj"));
  assert.ok(section.includes("#abc123"));
});

test("interrupted sessions use the warning icon", () => {
  const msg = fmt.buildCompletionMessage({ id: "s1", badge: "interrupted", displayTitle: "T" }, { lang: "en" });
  assert.ok(msg.text.startsWith("⚠️"));
});

test("includeOutput appends a fenced, redacted, fence-safe code block", () => {
  const msg = fmt.buildCompletionMessage(
    {
      id: "s1",
      badge: "done",
      displayTitle: "T",
      assistantLastOutput: "token xoxb-123456789-abcdefghij and ```danger``` here",
    },
    { lang: "en", includeOutput: true },
  );
  const joined = msg.blocks.map((b) => (b.text ? b.text.text : "")).join("\n");
  assert.ok(joined.includes("```")); // a code block was added
  assert.ok(joined.includes("<redacted:token>")); // secret scrubbed
  assert.ok(!joined.includes("xoxb-123456789-abcdefghij"));
  // The embedded fence must be broken so it can't terminate our block early.
  assert.ok(!joined.includes("```danger```"));
});

test("output is omitted when includeOutput is false", () => {
  const withOut = fmt.buildCompletionMessage(
    { id: "s1", badge: "done", displayTitle: "T", assistantLastOutput: "hello" },
    { lang: "en", includeOutput: false },
  );
  const joined = withOut.blocks.map((b) => (b.text ? b.text.text : "")).join("\n");
  assert.ok(!joined.includes("hello"));
});

test("buildPermissionMessage announces and points at the desktop app", () => {
  const msg = fmt.buildPermissionMessage(
    { title: "claude needs approval", toolName: "Bash", agentId: "claude", folder: "/x/proj", detail: "rm -rf" },
    { lang: "en" },
  );
  assert.ok(msg.text.startsWith("⏳"));
  const joined = msg.blocks.map((b) => {
    if (b.text) return b.text.text;
    if (b.elements) return b.elements.map((e) => e.text).join(" ");
    return "";
  }).join("\n");
  assert.ok(joined.includes("Bash"));
  assert.ok(/desktop app/i.test(joined));
});

test("mrkdwn special characters are escaped", () => {
  const msg = fmt.buildCompletionMessage({ id: "s1", badge: "done", displayTitle: "a<b>&c" }, { lang: "en" });
  const header = msg.blocks[0].text.text; // plain_text header is not escaped
  assert.ok(header.includes("a<b>&c"));
  assert.equal(fmt.escapeMrkdwn("a<b>&c"), "a&lt;b&gt;&amp;c");
});

test("truncateMiddle keeps both ends and marks truncation", () => {
  const long = "A".repeat(100) + "B".repeat(100);
  const out = fmt.truncateMiddle(long, 60);
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 60);
  assert.ok(out.text.startsWith("A"));
  assert.ok(out.text.endsWith("B"));
  assert.ok(out.text.includes("[truncated]"));
});

test("locales fall back to English and translate the status word", () => {
  assert.equal(fmt.getLocale("zz").done, "done");
  const zh = fmt.buildCompletionMessage({ id: "s1", badge: "done", displayTitle: "T" }, { lang: "zh" });
  assert.ok(zh.blocks[1].text.text.includes("已完成"));
});

test("buildTestMessage produces a simple two-block card", () => {
  const msg = fmt.buildTestMessage({ lang: "en" });
  assert.equal(msg.blocks.length, 2);
  assert.equal(msg.blocks[0].type, "header");
});

test("null entry yields null (caller skips)", () => {
  assert.equal(fmt.buildCompletionMessage(null, { lang: "en" }), null);
});
