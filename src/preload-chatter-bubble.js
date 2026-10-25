const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatterBubbleAPI", {
  onShow: (cb) => ipcRenderer.on("chatter-bubble-show", (_, data) => cb(data)),
  onHide: (cb) => ipcRenderer.on("chatter-bubble-hide", () => cb()),
  // The window takes clicks only while the pointer is over the bubble.
  setInteractive: (interactive) => ipcRenderer.send("chatter-bubble-interactive", interactive === true),
  dismiss: () => ipcRenderer.send("chatter-bubble-dismiss"),
});
