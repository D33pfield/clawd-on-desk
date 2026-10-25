"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("moodAPI", {
  get: () => ipcRenderer.invoke("mood:get"),
});
