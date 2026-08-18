"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..");
const { PET_ACCESSORY_CATALOG } = require(path.join(ROOT, "src", "pet-customization-catalog"));
const { computeDynamicAccessoryLayout } = require(path.join(ROOT, "src", "pet-accessory-layout"));
const { BUILTIN_ACCESSORY_MOTION_PADDING } = require(path.join(ROOT, "src", "pet-accessory-hitbox"));

const BUILTINS = [
  { id: "clawd", theme: path.join(ROOT, "themes", "clawd", "theme.json"), assets: path.join(ROOT, "assets", "svg") },
  { id: "cloudling", theme: path.join(ROOT, "themes", "cloudling", "theme.json"), assets: path.join(ROOT, "themes", "cloudling", "assets") },
];
const ACCESSORIES = PET_ACCESSORY_CATALOG.filter((entry) => entry.id !== "none");
const EPSILON = 0.15;

function rectFor(frame, accessory, themeId) {
  const themeWidthScale = accessory.themeWidthScales && accessory.themeWidthScales[themeId];
  const widthScale = Number.isFinite(themeWidthScale) ? themeWidthScale : accessory.widthScale;
  const width = frame.width * widthScale;
  const height = width / (accessory.viewBox.width / accessory.viewBox.height);
  return {
    left: frame.cx - width / 2,
    top: frame.baseY + accessory.offsetY - height,
    right: frame.cx + width / 2,
    bottom: frame.baseY + accessory.offsetY,
    width,
    height,
    widthScale,
  };
}

function emptyPadding() {
  return { left: 0, top: 0, right: 0, bottom: 0 };
}

function maxPadding(a, b) {
  return {
    left: Math.max(a.left || 0, b.left || 0),
    top: Math.max(a.top || 0, b.top || 0),
    right: Math.max(a.right || 0, b.right || 0),
    bottom: Math.max(a.bottom || 0, b.bottom || 0),
  };
}

async function sampleMatrices(win, targetId, scriptedCloudling) {
  return win.webContents.executeJavaScript(`(async () => {
    const root = document.documentElement;
    const target = document.getElementById(${JSON.stringify(targetId)});
    if (!root || !target) throw new Error("missing accessory follow target: ${targetId}");
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const snapshot = () => {
      const rootM = root.getScreenCTM();
      const targetM = target.getScreenCTM();
      if (!rootM || !targetM) throw new Error("getScreenCTM returned null");
      const m = rootM.inverse().multiply(targetM);
      return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
    };
    const out = [];

    if (${scriptedCloudling ? "true" : "false"}) {
      if (typeof window.__cloudlingSetPointer !== "function") {
        throw new Error("cloudling scripted pointer hook is unavailable");
      }
      const probes = [
        { x: -1000, y: -1000, inside: true },
        { x: 1000, y: -1000, inside: true },
        { x: -1000, y: 1000, inside: true },
        { x: 1000, y: 1000, inside: true },
      ];
      for (const probe of probes) {
        window.__cloudlingSetPointer(probe);
        await wait(2600);
        for (let i = 0; i < 12; i++) {
          out.push(snapshot());
          await wait(16);
        }
      }
      return out;
    }

    const animations = document.getAnimations({ subtree: true });
    const durations = [];
    for (const animation of animations) {
      animation.pause();
      const timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
      const duration = timing && Number(timing.duration);
      if (Number.isFinite(duration) && duration > 0) durations.push({ animation, duration });
    }
    if (durations.length === 0) return [snapshot()];

    const horizon = Math.min(12000, Math.max(4000, ...durations.map(({ duration }) => duration * 4)));
    for (let t = 0; t <= horizon; t += 25) {
      for (const { animation, duration } of durations) animation.currentTime = t % duration;
      out.push(snapshot());
    }
    return out;
  })()`);
}

async function auditTheme(win, builtin) {
  const raw = JSON.parse(fs.readFileSync(builtin.theme, "utf8"));
  const files = raw.customization && raw.customization.accessories && raw.customization.accessories.files;
  if (!files) return [];
  const failures = [];

  for (const [file, descriptor] of Object.entries(files)) {
    if (!descriptor || !descriptor.followTarget || !descriptor.staticFrame) continue;
    const svgPath = path.join(builtin.assets, file);
    if (!fs.existsSync(svgPath)) throw new Error(`missing SVG for motion audit: ${svgPath}`);
    await win.loadFile(svgPath);
    const matrices = await sampleMatrices(
      win,
      descriptor.followTarget.id,
      builtin.id === "cloudling" && file === "cloudling-idle.svg"
    );
    const authored = descriptor.hitBoxPadding || emptyPadding();
    const measured = (BUILTIN_ACCESSORY_MOTION_PADDING[builtin.id] || {})[file] || emptyPadding();
    const configured = maxPadding(authored, measured);
    const required = emptyPadding();

    for (const accessory of ACCESSORIES) {
      const staticRect = rectFor(descriptor.staticFrame, accessory, builtin.id);
      const followRect = rectFor(descriptor.followTarget.frame, accessory, builtin.id);
      const normalizedAccessory = {
        aspect: accessory.viewBox.width / accessory.viewBox.height,
        widthScale: staticRect.widthScale,
        offsetY: accessory.offsetY,
      };
      for (const matrix of matrices) {
        const layout = computeDynamicAccessoryLayout({
          matrix,
          frame: descriptor.followTarget.frame,
          accessory: normalizedAccessory,
          mediaOffset: { x: 0, y: 0 },
          stageSize: { width: 1000, height: 1000 },
        });
        if (!layout) throw new Error(`${builtin.id}/${file}/${accessory.id}: dynamic layout rejected sampled CTM`);
        const b = layout.bounds;
        required.left = Math.max(required.left, staticRect.left - b.x);
        required.top = Math.max(required.top, staticRect.top - b.y);
        required.right = Math.max(required.right, b.x + b.width - staticRect.right);
        required.bottom = Math.max(required.bottom, b.y + b.height - staticRect.bottom);
      }
    }

    for (const side of ["left", "top", "right", "bottom"]) {
      const need = Math.max(0, required[side]);
      if (need > configured[side] + EPSILON) {
        failures.push(`${builtin.id}/${file} ${side}: need ${need.toFixed(3)}, configured ${configured[side].toFixed(3)}`);
      }
    }
    process.stdout.write(`${builtin.id}/${file}: required=${JSON.stringify(required)} configured=${JSON.stringify(configured)}\n`);
  }
  return failures;
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 800,
    webPreferences: { backgroundThrottling: false },
  });
  const failures = [];
  try {
    for (const builtin of BUILTINS) failures.push(...await auditTheme(win, builtin));
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  if (failures.length > 0) throw new Error(`Accessory motion audit failed:\n${failures.join("\n")}`);
}

main()
  .then(() => app.quit())
  .catch((err) => {
    console.error(err && err.stack || err);
    app.exit(1);
  });
