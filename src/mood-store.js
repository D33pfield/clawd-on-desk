"use strict";

// Persists the mood tracker's stored state under ~/.clawd/mood.json. Writes
// are atomic (temp file + rename) and debounced so a burst of hook events
// causes at most one write per interval. Failures never reach callers: mood is
// decoration, losing a save only means the pet forgets how it felt.

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_SAVE_DELAY_MS = 30 * 1000;

function defaultMoodFilePath(homeDir = os.homedir()) {
  return path.join(homeDir, ".clawd", "mood.json");
}

function loadMoodState(filePath = defaultMoodFilePath(), fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function createMoodStore(options = {}) {
  const filePath = options.filePath || defaultMoodFilePath();
  const fsApi = options.fs || fs;
  const getState = options.getState;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : DEFAULT_SAVE_DELAY_MS;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const log = typeof options.log === "function" ? options.log : () => {};
  let timer = null;

  function writeNow() {
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
      fsApi.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fsApi.writeFileSync(tmpPath, JSON.stringify(getState()), { encoding: "utf8", mode: 0o600 });
      fsApi.renameSync(tmpPath, filePath);
    } catch (err) {
      log(`mood save failed: ${err && err.message}`);
      try { fsApi.unlinkSync(tmpPath); } catch {}
    }
  }

  return {
    filePath,
    scheduleSave() {
      if (timer) return;
      timer = setTimer(() => {
        timer = null;
        writeNow();
      }, delayMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    },
    flush() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      writeNow();
    },
  };
}

module.exports = {
  DEFAULT_SAVE_DELAY_MS,
  defaultMoodFilePath,
  loadMoodState,
  createMoodStore,
};
