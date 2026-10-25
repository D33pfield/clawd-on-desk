"use strict";

// Wires desktop awareness (src/desktop-awareness.js) to the app: builds the
// capturer, reads the prefs, and keeps the two toggles honest. Armed is
// a pref only so the Settings page can bind to it; this module treats it as
// runtime state: it is forced off at every launch, and whenever awareness itself
// is switched off. Kept out of main.js on purpose.

const { createDesktopAwareness } = require("./desktop-awareness");
const { createDesktopCapturer } = require("./desktop-capture");

// deps: { settings (controller: get, applyUpdate, subscribeKey), electron, getChatter,
//         getChatterSettings, canSpeak, getPetCenter, log, fetch?, now?, capturer? }
function createAwarenessRuntime(deps) {
  const { settings, getChatter, getChatterSettings, canSpeak } = deps;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const get = (key) => settings.get(key);

  const capturer = deps.capturer || createDesktopCapturer({ electron: deps.electron, getPetCenter: deps.getPetCenter });

  const awareness = createDesktopAwareness({
    capturer,
    fetch: deps.fetch,
    now: deps.now,
    log,
    canSpeak,
    resolveModel: (chatterSettings) => getChatter().resolveModel(chatterSettings),
    getSettings: () => ({
      enabled: get("desktopAwareness") === true,
      armed: get("desktopAwarenessArmed") === true,
      scope: get("desktopAwarenessScope") === "screen" ? "screen" : "window",
      monitor: get("desktopAwarenessMonitor") || "pet",
      chatterEnabled: get("chatterEnabled") === true,
      // resolveModel reads .model from what it is given
      model: get("chatterModel") || "",
    }),
  });

  // Disarmed at every launch, whatever the saved pref says.
  if (get("desktopAwarenessArmed") === true) settings.applyUpdate("desktopAwarenessArmed", false);

  settings.subscribeKey("desktopAwareness", (on) => {
    if (on !== true) {
      if (get("desktopAwarenessArmed") === true) settings.applyUpdate("desktopAwarenessArmed", false);
      awareness.clearLastSeen();
    }
    // Every request now uses a different context size: load the model that way ahead of time.
    void getChatter().warm();
  });
  settings.subscribeKey("desktopAwarenessArmed", (armed) => {
    if (armed === true && get("desktopAwareness") !== true) {
      settings.applyUpdate("desktopAwarenessArmed", false);
      return;
    }
    if (armed !== true) awareness.clearLastSeen();
    log(`awareness armed=${armed === true}`);
  });

  return {
    // For chatter's getScreen option: a one-sentence description or "".
    getScreen: async (mode, name) => (await awareness.describe(mode, name)) || "",
    // For the Settings page.
    async status() {
      const result = await awareness.visionStatus();
      return { ok: true, model: result.model, vision: result.vision, lastSeen: awareness.getLastSeen() };
    },
  };
}

module.exports = { createAwarenessRuntime };
