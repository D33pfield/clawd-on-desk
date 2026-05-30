"use strict";

const telegramApprovalSettings = require("./telegram-approval-settings");

function isNativeTelegramApprovalSelected(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  return snapshot.state === "NATIVE_ACTIVE"
    || snapshot.state === "TESTING_NATIVE"
    || snapshot.transport === "native";
}

function buildNativeTelegramApprovalStatus({ config, token, migrationSnapshot, nativePolling }) {
  if (!isNativeTelegramApprovalSelected(migrationSnapshot)) return null;

  const ready = telegramApprovalSettings.readiness(
    { ...config, enabled: true },
    token,
  );
  const polling = nativePolling === true;
  const migrationState = migrationSnapshot && migrationSnapshot.state
    ? migrationSnapshot.state
    : "";
  const active = migrationState === "NATIVE_ACTIVE" && polling;
  const testing = migrationState === "TESTING_NATIVE";
  const status = active
    ? "running"
    : (testing ? "starting" : "stopped");
  let reason = ready.reason || "";
  let message = ready.message || "";
  if (ready.ready === true) {
    if (testing) {
      reason = "native-testing";
      message = "Native Telegram approval test is already in progress";
    } else if (!active) {
      reason = "native-inactive";
      message = "Native Telegram approval is not active";
    } else {
      reason = "";
      message = "";
    }
  }

  return {
    status,
    transport: "native",
    native: true,
    enabled: active || testing,
    configured: ready.ready === true,
    reason,
    message,
    tokenStored: token && token.tokenStored === true,
    nativePolling: polling,
    migrationState,
  };
}

function buildTelegramApprovalStatus({
  config,
  token,
  sidecarStatus,
  migrationSnapshot,
  nativePolling,
}) {
  const nativeStatus = buildNativeTelegramApprovalStatus({
    config,
    token,
    migrationSnapshot,
    nativePolling,
  });
  if (nativeStatus) return nativeStatus;

  const ready = telegramApprovalSettings.readiness(config, token);
  const legacyStatus = sidecarStatus || { status: "stopped" };
  return {
    ...legacyStatus,
    transport: "legacy",
    enabled: config && config.enabled === true,
    configured: ready.ready === true,
    reason: ready.reason || "",
    message: legacyStatus.message || ready.message || "",
    tokenStored: token && token.tokenStored === true,
  };
}

module.exports = {
  isNativeTelegramApprovalSelected,
  buildNativeTelegramApprovalStatus,
  buildTelegramApprovalStatus,
};
