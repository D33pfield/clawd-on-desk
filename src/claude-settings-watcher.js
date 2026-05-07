"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { buildPermissionUrl } = require("../hooks/server-config");

const HOOK_MARKER = "clawd-hook.js";
const SETTINGS_FILENAME = "settings.json";

function entriesContainCommandMarker(entries, marker) {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string" && entry.command.includes(marker)) return true;
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook !== "object") continue;
      if (typeof hook.command === "string" && hook.command.includes(marker)) return true;
    }
  }
  return false;
}

function entriesContainHttpHookUrl(entries, expectedUrl) {
  if (!Array.isArray(entries) || !expectedUrl) return false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "http" && entry.url === expectedUrl) return true;
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook !== "object") continue;
      if (hook.type === "http" && hook.url === expectedUrl) return true;
    }
  }
  return false;
}

function settingsNeedClaudeHookResync(rawSettings, expectedPermissionUrl) {
  if (typeof rawSettings !== "string" || !rawSettings.trim()) return false;

  let parsed;
  try {
    parsed = JSON.parse(rawSettings);
  } catch {
    return false;
  }

  const hooks = parsed && typeof parsed === "object" ? parsed.hooks : null;
  if (!hooks || typeof hooks !== "object") return true;

  const hasManagedCommandHook = Object.values(hooks).some((entries) => (
    entriesContainCommandMarker(entries, HOOK_MARKER)
  ));
  const hasManagedPermissionHook = entriesContainHttpHookUrl(hooks.PermissionRequest, expectedPermissionUrl);
  return !hasManagedCommandHook || !hasManagedPermissionHook;
}

function createClaudeSettingsWatcher(ctx = {}) {
  const fsApi = ctx.fs || fs;
  const pathApi = ctx.path || path;
  const osApi = ctx.os || os;
  const setTimeoutFn = ctx.setTimeout || setTimeout;
  const clearTimeoutFn = ctx.clearTimeout || clearTimeout;
  const nowFn = typeof ctx.now === "function" ? ctx.now : Date.now;
  const settingsWatchDebounceMs = Number.isFinite(ctx.settingsWatchDebounceMs) ? ctx.settingsWatchDebounceMs : 1000;
  const settingsWatchRateLimitMs = Number.isFinite(ctx.settingsWatchRateLimitMs) ? ctx.settingsWatchRateLimitMs : 5000;

  let settingsWatcher = null;
  let settingsWatchDebounceTimer = null;
  let settingsWatchLastSyncTime = 0;

  function getClaudeSettingsDir() {
    return typeof ctx.claudeSettingsDir === "string"
      ? ctx.claudeSettingsDir
      : pathApi.join(osApi.homedir(), ".claude");
  }

  function getClaudeSettingsPath() {
    return typeof ctx.claudeSettingsPath === "string"
      ? ctx.claudeSettingsPath
      : pathApi.join(getClaudeSettingsDir(), SETTINGS_FILENAME);
  }

  function stop() {
    if (settingsWatchDebounceTimer) {
      clearTimeoutFn(settingsWatchDebounceTimer);
      settingsWatchDebounceTimer = null;
    }
    settingsWatchLastSyncTime = 0;
    if (!settingsWatcher) return false;
    try {
      settingsWatcher.close();
    } catch {}
    settingsWatcher = null;
    return true;
  }

  function start() {
    if (settingsWatcher) return false;
    const settingsDir = getClaudeSettingsDir();
    const settingsPath = getClaudeSettingsPath();
    try {
      settingsWatcher = fsApi.watch(settingsDir, (_event, filename) => {
        if (filename && filename !== SETTINGS_FILENAME) return;
        if (settingsWatchDebounceTimer) return;
        settingsWatchDebounceTimer = setTimeoutFn(() => {
          settingsWatchDebounceTimer = null;
          if (typeof ctx.shouldManageClaudeHooks === "function" && !ctx.shouldManageClaudeHooks()) return;
          if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("claude-code")) return;
          // Rate-limit: don't re-sync within 5s to avoid write wars with CC-Switch
          if (nowFn() - settingsWatchLastSyncTime < settingsWatchRateLimitMs) return;
          try {
            const raw = fsApi.readFileSync(settingsPath, "utf-8");
            const port = typeof ctx.getHookServerPort === "function" ? ctx.getHookServerPort() : null;
            const expectedPermissionUrl = buildPermissionUrl(port);
            if (settingsNeedClaudeHookResync(raw, expectedPermissionUrl)) {
              console.log("Clawd: hooks missing from settings.json — re-registering");
              settingsWatchLastSyncTime = nowFn();
              if (typeof ctx.syncClawdHooks === "function") ctx.syncClawdHooks();
            }
          } catch {}
        }, settingsWatchDebounceMs);
      });
      if (settingsWatcher && typeof settingsWatcher.on === "function") settingsWatcher.on("error", (err) => {
        console.warn("Clawd: settings watcher error:", err.message);
      });
      return true;
    } catch (err) {
      console.warn("Clawd: failed to watch settings directory:", err.message);
      settingsWatcher = null;
      return false;
    }
  }

  return {
    start,
    stop,
    getClaudeSettingsDir,
    getClaudeSettingsPath,
  };
}

module.exports = {
  HOOK_MARKER,
  SETTINGS_FILENAME,
  entriesContainCommandMarker,
  entriesContainHttpHookUrl,
  settingsNeedClaudeHookResync,
  createClaudeSettingsWatcher,
};
