"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildTelegramApprovalStatus,
  isNativeTelegramApprovalSelected,
} = require("../src/telegram-approval-runtime-status");

const COMPLETE_CONFIG_DISABLED = {
  enabled: false,
  allowedTgUserId: "123456789",
  targetSessionKey: "telegram:123456789",
};
const TOKEN_STORED = { tokenConfigured: true, tokenStored: true };

test("native active status ignores the legacy enabled flag and sidecar stopped state", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    sidecarStatus: { status: "stopped" },
    migrationSnapshot: { state: "NATIVE_ACTIVE", transport: "native" },
    nativePolling: true,
  });

  assert.deepEqual(status, {
    status: "running",
    transport: "native",
    native: true,
    enabled: true,
    configured: true,
    reason: "",
    message: "",
    tokenStored: true,
    nativePolling: true,
    migrationState: "NATIVE_ACTIVE",
  });
});

test("native active status reports native inactive instead of legacy sidecar unavailable", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    sidecarStatus: { status: "stopped" },
    migrationSnapshot: { state: "NATIVE_ACTIVE", transport: "native" },
    nativePolling: false,
  });

  assert.equal(status.status, "stopped");
  assert.equal(status.transport, "native");
  assert.equal(status.configured, true);
  assert.equal(status.reason, "native-inactive");
  assert.equal(status.message, "Native Telegram approval is not active");
});

test("native testing status carries a native reason instead of falling through to sidecar copy", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    sidecarStatus: { status: "stopped" },
    migrationSnapshot: { state: "TESTING_NATIVE" },
    nativePolling: true,
  });

  assert.equal(status.status, "starting");
  assert.equal(status.transport, "native");
  assert.equal(status.enabled, true);
  assert.equal(status.configured, true);
  assert.equal(status.reason, "native-testing");
  assert.equal(status.message, "Native Telegram approval test is already in progress");
});

test("native transport setup debt uses native copy without showing as enabled", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    sidecarStatus: { status: "stopped" },
    migrationSnapshot: { state: "NEEDS_SETUP", transport: "native" },
    nativePolling: false,
  });

  assert.equal(status.status, "stopped");
  assert.equal(status.transport, "native");
  assert.equal(status.enabled, false);
  assert.equal(status.configured, true);
  assert.equal(status.reason, "native-inactive");
  assert.equal(status.message, "Native Telegram approval is not active");
});

test("off transport keeps the legacy disabled reason after USER_DISABLE", () => {
  const status = buildTelegramApprovalStatus({
    config: COMPLETE_CONFIG_DISABLED,
    token: TOKEN_STORED,
    sidecarStatus: { status: "stopped" },
    migrationSnapshot: { state: "IDLE", transport: "off" },
    nativePolling: false,
  });

  assert.equal(status.transport, "legacy");
  assert.equal(status.configured, false);
  assert.equal(status.reason, "disabled");
  assert.equal(status.message, "");
});

test("native selection includes persisted native transport while excluding off", () => {
  assert.equal(isNativeTelegramApprovalSelected({ state: "NATIVE_ACTIVE" }), true);
  assert.equal(isNativeTelegramApprovalSelected({ state: "TESTING_NATIVE" }), true);
  assert.equal(isNativeTelegramApprovalSelected({ state: "NEEDS_SETUP", transport: "native" }), true);
  assert.equal(isNativeTelegramApprovalSelected({ state: "IDLE", transport: "off" }), false);
});
