"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const CLAUDE_AUTO_MODE_NOTICE_STRINGS = {
  en: {
    message: "Claude Code auto mode limits permission bubbles",
    detail:
      "Claude Code auto mode auto-approves many tool calls. Clawd will still show working animations, but permission bubbles only appear when Claude Code asks for manual approval.",
    ok: "Got it",
  },
  zh: {
    message: "Claude Code 自动模式下权限气泡会减少",
    detail:
      "Claude Code 的 auto 模式会自动批准许多工具调用。Clawd 仍会显示工作状态动画，但只有 Claude Code 进入人工确认时才会弹权限气泡。",
    ok: "知道了",
  },
  ko: {
    message: "Claude Code 자동 모드에서는 권한 말풍선이 줄어듭니다",
    detail:
      "Claude Code auto 모드는 많은 도구 호출을 자동 승인합니다. Clawd는 작업 상태 애니메이션을 계속 표시하지만, 권한 말풍선은 Claude Code가 수동 승인을 요청할 때만 나타납니다.",
    ok: "확인",
  },
};

function getClaudeSettingsPath(options = {}) {
  if (typeof options.settingsPath === "string" && options.settingsPath) {
    return options.settingsPath;
  }
  const osApi = options.os || os;
  const homeDir = typeof options.homeDir === "string" && options.homeDir
    ? options.homeDir
    : osApi.homedir();
  return path.join(homeDir, ".claude", "settings.json");
}

function readClaudeDefaultMode(options = {}) {
  const fsApi = options.fs || fs;
  let raw;
  try {
    raw = fsApi.readFileSync(getClaudeSettingsPath(options), "utf8");
  } catch {
    return null;
  }

  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    return null;
  }

  const permissions = settings && typeof settings === "object" ? settings.permissions : null;
  const mode = permissions && typeof permissions === "object" ? permissions.defaultMode : null;
  return typeof mode === "string" && mode ? mode : null;
}

function shouldShowClaudeAutoModeNotice({ defaultMode, noticeShown } = {}) {
  // Intentionally auto-only for #163; dontAsk/bypassPermissions need separate wording.
  return noticeShown !== true && defaultMode === "auto";
}

async function maybeShowClaudeAutoModeNotice(options = {}) {
  const settingsController = options.settingsController;
  if (!settingsController || typeof settingsController.get !== "function") {
    return { shown: false, reason: "missing-settings-controller" };
  }

  if (settingsController.get("claudeAutoModeNoticeShown") === true) {
    return { shown: false, reason: "already-shown" };
  }

  const defaultMode = readClaudeDefaultMode(options);
  if (!shouldShowClaudeAutoModeNotice({
    defaultMode,
    noticeShown: settingsController.get("claudeAutoModeNoticeShown"),
  })) {
    return { shown: false, reason: "not-auto-mode", defaultMode };
  }

  const dialogApi = options.dialog;
  if (!dialogApi || typeof dialogApi.showMessageBox !== "function") {
    return { shown: false, reason: "missing-dialog", defaultMode };
  }

  const langValue = typeof options.lang === "function" ? options.lang() : options.lang;
  const strings = CLAUDE_AUTO_MODE_NOTICE_STRINGS[langValue] || CLAUDE_AUTO_MODE_NOTICE_STRINGS.en;
  const parent = typeof options.getParent === "function" ? options.getParent() : null;

  try {
    await dialogApi.showMessageBox(parent, {
      type: "info",
      buttons: [strings.ok],
      defaultId: 0,
      cancelId: 0,
      message: strings.message,
      detail: strings.detail,
      noLink: true,
    });
  } catch (err) {
    if (typeof options.warn === "function") {
      options.warn("Clawd: failed to show Claude auto mode notice:", err && err.message);
    }
    return { shown: false, reason: "dialog-failed", defaultMode };
  }

  const result = settingsController.applyUpdate("claudeAutoModeNoticeShown", true);
  const saved = result && typeof result.then === "function" ? await result : result;
  if (!saved || saved.status !== "ok") {
    return {
      shown: true,
      persisted: false,
      reason: "persist-failed",
      message: saved && saved.message,
      defaultMode,
    };
  }

  return { shown: true, persisted: true, defaultMode };
}

module.exports = {
  CLAUDE_AUTO_MODE_NOTICE_STRINGS,
  getClaudeSettingsPath,
  maybeShowClaudeAutoModeNotice,
  readClaudeDefaultMode,
  shouldShowClaudeAutoModeNotice,
};
