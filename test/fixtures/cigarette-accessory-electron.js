"use strict";

const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const HTML = path.join(__dirname, "cigarette-accessory-electron.html");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForObjects(win) {
  return win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const objects = [document.getElementById("pet"), document.getElementById("cigarette")];
    const ready = () => objects.every((object) => object.contentDocument && object.contentDocument.documentElement);
    if (ready()) return resolve(true);
    const timer = setTimeout(() => reject(new Error("stacked object load timed out")), 5000);
    for (const object of objects) {
      object.addEventListener("load", () => {
        if (!ready()) return;
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    }
  })`);
}

async function assertProductionStack(win) {
  const layout = await win.webContents.executeJavaScript(`(() => {
    const pet = document.getElementById("pet");
    const cigarette = document.getElementById("cigarette");
    const petRoot = pet.contentDocument.documentElement;
    const cigaretteRoot = cigarette.contentDocument.documentElement;
    if (typeof petRoot.pauseAnimations === "function") petRoot.pauseAnimations();
    if (typeof cigaretteRoot.pauseAnimations === "function") cigaretteRoot.pauseAnimations();
    const outer = cigarette.getBoundingClientRect();
    const inner = cigaretteRoot.getBoundingClientRect();
    return {
      outer: { width: outer.width, height: outer.height },
      inner: { width: inner.width, height: inner.height },
    };
  })()`);
  assert(Math.abs(layout.outer.width - layout.inner.width) < 0.1, "cigarette SVG root did not fill object width");
  assert(Math.abs(layout.outer.height - layout.inner.height) < 0.1, "cigarette SVG root did not fill object height");

  await win.webContents.executeJavaScript(`document.getElementById("cigarette").style.visibility = "hidden"`);
  const baseline = await win.webContents.capturePage({ x: 60, y: 45, width: 1, height: 1 });
  await win.webContents.executeJavaScript(`document.getElementById("cigarette").style.visibility = "visible"`);
  const stacked = await win.webContents.capturePage({ x: 60, y: 45, width: 1, height: 1 });
  assert(
    baseline.toDataURL() === stacked.toDataURL(),
    "transparent mouth object canvas obscured the real pet layer beneath it"
  );
}

async function inspect(win, seconds) {
  return win.webContents.executeJavaScript(`(async () => {
    const object = document.getElementById("cigarette");
    const doc = object.contentDocument;
    const root = doc && doc.documentElement;
    if (!root || typeof root.setCurrentTime !== "function") {
      throw new Error("cigarette SVG timeline is unavailable");
    }
    root.pauseAnimations();
    root.setCurrentTime(${JSON.stringify(seconds)});
    await Promise.resolve();
    const rects = doc.querySelectorAll("rect");
    if (rects.length !== 5) throw new Error("unexpected cigarette rect structure");
    const style = (element) => doc.defaultView.getComputedStyle(element);
    const smokeMatrix = rects[2].getCTM();
    return {
      documentUrl: doc.URL,
      currentTime: root.getCurrentTime(),
      emberFill: style(rects[1]).fill,
      emberOpacity: Number(style(rects[1]).opacity),
      smokeOpacity: Number(style(rects[2]).opacity),
      smokeTransform: [smokeMatrix.a, smokeMatrix.b, smokeMatrix.c, smokeMatrix.d, smokeMatrix.e, smokeMatrix.f],
    };
  })()`);
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 160,
    height: 160,
    webPreferences: { backgroundThrottling: false },
  });
  try {
    await win.loadFile(HTML);
    await waitForObjects(win);
    await assertProductionStack(win);
    const start = await inspect(win, 0);
    const emberPeak = await inspect(win, 0.8);
    const smokeRise = await inspect(win, 1.6);

    assert(start.emberFill !== emberPeak.emberFill, "cigarette ember fill did not animate");
    assert(start.emberOpacity !== emberPeak.emberOpacity, "cigarette ember opacity did not animate");
    assert(
      start.smokeOpacity !== smokeRise.smokeOpacity
        || JSON.stringify(start.smokeTransform) !== JSON.stringify(smokeRise.smokeTransform),
      "cigarette smoke did not animate"
    );

    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const object = document.getElementById("cigarette");
      const timer = setTimeout(() => reject(new Error("cigarette re-entry timed out")), 5000);
      object.addEventListener("load", () => { clearTimeout(timer); resolve(true); }, { once: true });
      object.data = "../../assets/accessories/cigarette.svg?_t=second";
    })`);
    const restarted = await inspect(win, 0);
    assert(restarted.documentUrl.includes("_t=second"), "cigarette re-entry kept the old document");
    assert(restarted.emberFill === start.emberFill, "cigarette re-entry did not restart the ember timeline");
    assert(restarted.smokeOpacity === start.smokeOpacity, "cigarette re-entry did not restart the smoke timeline");

    const timing = await win.webContents.executeJavaScript(`(async () => {
      const root = document.getElementById("cigarette").contentDocument.documentElement;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      root.unpauseAnimations();
      await wait(120);
      root.pauseAnimations();
      const pausedAt = root.getCurrentTime();
      await wait(250);
      const heldAt = root.getCurrentTime();
      root.unpauseAnimations();
      let resumedAt = heldAt;
      let resumeWaitMs = 0;
      while (resumedAt - heldAt <= 0.1 && resumeWaitMs < 2000) {
        await wait(100);
        resumeWaitMs += 100;
        resumedAt = root.getCurrentTime();
      }
      return { pausedAt, heldAt, resumedAt, resumeWaitMs };
    })()`);
    assert(Math.abs(timing.heldAt - timing.pausedAt) < 0.03, "cigarette timeline advanced while paused");
    assert(timing.resumedAt - timing.heldAt > 0.1, "cigarette timeline did not resume");
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error && error.stack || error);
    app.exit(1);
  });
