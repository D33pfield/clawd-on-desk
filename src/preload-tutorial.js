"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const stateListeners = new Set();

ipcRenderer.on("tutorial:state", (_event, state) => {
  for (const cb of stateListeners) {
    try { cb(state); } catch (err) { console.warn("tutorial state listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("tutorialAPI", {
  // Pull the full wizard payload (i18n, platform, detected agents, shortcuts).
  getState: () => ipcRenderer.invoke("tutorial:get-state"),
  // Step 2 actions — each resolves to { status, message? } and triggers a fresh
  // tutorial:state push so the list re-renders with the new install state.
  installAgent: (agentId) => ipcRenderer.invoke("tutorial:install-agent", agentId),
  uninstallAgent: (agentId) => ipcRenderer.invoke("tutorial:uninstall-agent", agentId),
  // Deep-links into Settings (e.g. the Agents or Shortcuts tab).
  openSettingsTab: (tab) => ipcRenderer.send("tutorial:open-settings-tab", tab),
  openShortcuts: () => ipcRenderer.send("tutorial:open-shortcuts"),
  // Finish = persist "seen" and close. markSeen persists without closing (used
  // defensively if the user dismisses via the window chrome mid-flow).
  finish: () => ipcRenderer.send("tutorial:finish"),
  markSeen: () => ipcRenderer.send("tutorial:mark-seen"),
  onState: (cb) => {
    if (typeof cb !== "function") return () => {};
    stateListeners.add(cb);
    return () => stateListeners.delete(cb);
  },
});
