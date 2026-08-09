"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const settings = require("../src/slack-notify-settings");

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-slack-notify-"));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test("normalizeSlackNotify fills defaults and coerces types", () => {
  assert.deepEqual(settings.normalizeSlackNotify(undefined), {
    enabled: false,
    channelId: "",
    notifyOnDone: true,
    notifyOnError: true,
    notifyOnPermission: true,
    outputMode: "off",
  });
  assert.deepEqual(settings.normalizeSlackNotify({
    enabled: true,
    channelId: "  C123  ",
    notifyOnDone: false,
    outputMode: "tail", // legacy alias -> full
  }), {
    enabled: true,
    channelId: "C123",
    notifyOnDone: false,
    notifyOnError: true,
    notifyOnPermission: true,
    outputMode: "full",
  });
});

test("validateSlackNotify rejects unknown keys and bad types", () => {
  assert.equal(settings.validateSlackNotify({ enabled: false }).status, "ok");
  assert.equal(settings.validateSlackNotify({ enabled: "no" }).status, "error");
  assert.equal(settings.validateSlackNotify({ enabled: false, nope: 1 }).status, "error");
  assert.equal(settings.validateSlackNotify({ enabled: false, outputMode: "tail" }).status, "error");
  assert.equal(settings.validateSlackNotify("x").status, "error");
});

test("isValidWebhookUrl pins the Slack host over https", () => {
  assert.ok(settings.isValidWebhookUrl("https://hooks.slack.com/services/T/B/xxx"));
  assert.ok(!settings.isValidWebhookUrl("http://hooks.slack.com/services/T/B/xxx"));
  assert.ok(!settings.isValidWebhookUrl("https://evil.example.com/services/T/B/xxx"));
  assert.ok(!settings.isValidWebhookUrl("https://hooks.slack.com.evil.com/x"));
  assert.ok(!settings.isValidWebhookUrl("not a url"));
  assert.ok(!settings.isValidWebhookUrl(""));
});

test("isValidBotToken accepts documented prefixes only", () => {
  assert.ok(settings.isValidBotToken("xoxb-123456789-abcdefghij"));
  assert.ok(settings.isValidBotToken("xoxp-123456789-abcdefghij"));
  assert.ok(!settings.isValidBotToken("xoxr-123"));
  assert.ok(!settings.isValidBotToken("https://hooks.slack.com/services/T/B/x"));
  assert.ok(!settings.isValidBotToken(""));
});

test("resolveSlackTransport prefers webhook, falls back to bot+channel", () => {
  const webhook = "https://hooks.slack.com/services/T/B/xxx";
  const bot = "xoxb-123456789-abcdefghij";
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, { webhookUrl: webhook, botToken: bot }), "webhook");
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, { botToken: bot }), "bot");
  assert.equal(settings.resolveSlackTransport({ channelId: "" }, { botToken: bot }), null); // bot without channel
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, {}), null);
});

test("readiness reports the right stable reason at each stage", () => {
  const webhook = "https://hooks.slack.com/services/T/B/xxx";
  assert.equal(settings.readiness({ enabled: false }, { webhookUrl: webhook }).reason, "disabled");
  assert.equal(settings.readiness({ enabled: true }, {}).reason, "missing-secret");
  // webhook present but malformed -> invalid-secret
  assert.equal(settings.readiness({ enabled: true }, { webhookUrl: "https://evil.com/x" }).reason, "invalid-secret");
  // bot token present but no channel -> invalid-config
  assert.equal(
    settings.readiness({ enabled: true, channelId: "" }, { botToken: "xoxb-1-abcdefghij" }).reason,
    "invalid-config",
  );
  const ok = settings.readiness({ enabled: true }, { webhookUrl: webhook });
  assert.equal(ok.ready, true);
  assert.equal(ok.transport, "webhook");
});

test("writeSecretsEnvFile round-trips, masks, and preserves untouched keys", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);
  assert.ok(filePath.endsWith("slack-notify.env"));

  const webhook = "https://hooks.slack.com/services/T/B/secretpath";
  const write1 = settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: webhook } });
  assert.equal(write1.status, "ok");
  let read = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(read.webhookUrl, webhook);
  assert.equal(read.botToken, "");

  // Writing only the bot token must not wipe the stored webhook.
  const bot = "xoxb-123456789-abcdefghij";
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { botToken: bot } });
  read = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(read.webhookUrl, webhook);
  assert.equal(read.botToken, bot);

  const masked = settings.readMaskedSecrets({ fs, filePath });
  assert.equal(masked.configured, true);
  assert.ok(masked.webhookUrl.includes("......"));
  assert.ok(!masked.webhookUrl.includes("secretpath"));

  // Explicit empty string clears a field.
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: "" } });
  read = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(read.webhookUrl, "");
  assert.equal(read.botToken, bot);
});

test("readSecretsEnvFile degrades gracefully when the file is missing", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir); // never written
  assert.deepEqual(settings.readSecretsEnvFile({ fs, filePath }), { webhookUrl: "", botToken: "" });
  assert.equal(settings.readMaskedSecrets({ fs, filePath }).configured, false);
});

test("redactionSecretsForSlackNotify lists non-empty secrets", () => {
  assert.deepEqual(
    settings.redactionSecretsForSlackNotify({}, { webhookUrl: "w", botToken: "" }),
    ["w"],
  );
});
