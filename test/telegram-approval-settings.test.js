"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const settings = require("../src/telegram-approval-settings");

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-tg-approval-"));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test("normalizeTelegramApproval trims ids and accepts numeric chat id shorthand", () => {
  assert.deepEqual(settings.normalizeTelegramApproval({
    enabled: true,
    allowedTgUserId: " 123456789 ",
    targetSessionKey: "987654321",
  }), {
    enabled: true,
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:987654321",
  });
});

test("validateTelegramApproval requires user and target only when enabled", () => {
  assert.equal(settings.validateTelegramApproval({
    enabled: false,
    allowedTgUserId: "",
    targetSessionKey: "",
  }).status, "ok");
  assert.equal(settings.validateTelegramApproval({
    enabled: true,
    allowedTgUserId: "",
    targetSessionKey: "telegram:987654321",
  }).status, "error");
  assert.equal(settings.validateTelegramApproval({
    enabled: true,
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:987654321",
  }).status, "ok");
  assert.equal(settings.validateTelegramApproval({
    enabled: true,
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:0",
  }).status, "error");
  assert.equal(settings.validateTelegramApproval({
    enabled: false,
    allowedTgUserId: "",
    targetSessionKey: "",
    botToken: "123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
  }).status, "error");
});

test("buildBridgeConfigToml writes sidecar config without bot token fields", () => {
  const toml = settings.buildBridgeConfigToml({
    enabled: true,
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:987654321",
    botToken: "123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
  });
  assert.match(toml, /enabled = true/);
  assert.match(toml, /allowed_tg_user_id = "123456789"/);
  assert.match(toml, /target_session_key = "telegram:987654321"/);
  assert.doesNotMatch(toml, /bot_token/i);
  assert.doesNotMatch(toml, /ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
});

test("writeTokenEnvFile validates and stores token outside prefs", () => {
  const filePath = path.join(tempDir(), "telegram-approval.env");
  const token = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_jklmnop";
  const result = settings.writeTokenEnvFile({ fs, path, filePath, token, platform: "linux" });
  assert.equal(result.status, "ok");
  const text = fs.readFileSync(filePath, "utf8");
  assert.equal(text, `CLAWD_TG_BOT_TOKEN=${token}\n`);
});

test("tokenStatus checks env/file presence without reading the token file", () => {
  const calls = [];
  const fakeFs = {
    existsSync(filePath) {
      calls.push(["existsSync", filePath]);
      return true;
    },
    statSync(filePath) {
      calls.push(["statSync", filePath]);
      return { mtimeMs: 1234 };
    },
    readFileSync() {
      calls.push(["readFileSync"]);
      throw new Error("should not read token file");
    },
  };
  const status = settings.tokenStatus({
    fs: fakeFs,
    filePath: "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk\\telegram-approval.env",
    env: {},
  });
  assert.deepEqual(status, {
    tokenConfigured: true,
    tokenStored: true,
    envTokenConfigured: false,
    tokenFileMtimeMs: 1234,
  });
  assert.deepEqual(calls, [
    ["existsSync", "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk\\telegram-approval.env"],
    ["statSync", "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk\\telegram-approval.env"],
  ]);
});

test("redactionSecretsForTelegramApproval includes whole session key and numeric parts", () => {
  assert.deepEqual(settings.redactionSecretsForTelegramApproval({
    enabled: true,
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:-100987654321:55",
  }), [
    "123456789",
    "telegram:-100987654321:55",
    "-100987654321",
    "55",
  ]);
});
