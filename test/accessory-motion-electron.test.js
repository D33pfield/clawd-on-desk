"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function electronExecutable() {
  try {
    const value = require("electron");
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

test("real SVG getCTM motion stays inside the declared accessory envelope", { timeout: 90_000 }, (t) => {
  const executable = electronExecutable();
  if (!executable) return t.skip("Electron executable is not installed");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return t.skip("Electron SVG audit needs an X11/Wayland display (CI can use xvfb-run)");
  }

  const fixture = path.join(__dirname, "fixtures", "accessory-motion-electron.js");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [fixture, "--disable-gpu"], {
    env,
    encoding: "utf8",
    timeout: 85_000,
  });

  assert.strictEqual(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n") || `Electron exited ${result.status}`
  );
});
