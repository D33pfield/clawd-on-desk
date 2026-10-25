"use strict";

// Small window that shows the pet's mood channels as horizontal bars. It never
// shows numbers: the bars are the whole point. The page polls over IPC because
// the channels decay continuously, with no event to push on.

const path = require("path");

const MOOD_GET_CHANNEL = "mood:get";
const WINDOW_WIDTH = 340;
const WINDOW_HEIGHT = 330;
const BACKGROUND_LIGHT = "#f5f5f7";
const BACKGROUND_DARK = "#1c1c1f";

function createMoodWindow(options = {}) {
  const electron = options.electron || require("electron");
  const { BrowserWindow, ipcMain, nativeTheme } = electron;
  const getValues = typeof options.getValues === "function" ? options.getValues : () => ({});
  let win = null;
  let ipcRegistered = false;

  function registerIpcOnce() {
    if (ipcRegistered) return;
    ipcRegistered = true;
    ipcMain.handle(MOOD_GET_CHANNEL, () => getValues());
  }

  function create() {
    registerIpcOnce();
    const windowOptions = {
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      useContentSize: true,
      show: false,
      frame: true,
      resizable: false,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: "Mood",
      backgroundColor: nativeTheme && nativeTheme.shouldUseDarkColors ? BACKGROUND_DARK : BACKGROUND_LIGHT,
      webPreferences: {
        preload: path.join(__dirname, "preload-mood.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    };
    if (options.iconPath) windowOptions.icon = options.iconPath;

    win = new BrowserWindow(windowOptions);
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, "mood.html"));
    win.once("ready-to-show", () => {
      if (!win || win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    win.on("closed", () => {
      win = null;
    });
    return win;
  }

  function open() {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return win;
    }
    return create();
  }

  return {
    open,
    getWindow: () => win,
  };
}

module.exports = {
  MOOD_GET_CHANNEL,
  createMoodWindow,
};
