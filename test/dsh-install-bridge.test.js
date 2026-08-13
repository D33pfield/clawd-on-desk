"use strict";

// Tests for the DSH interactive-bridge lifecycle in hooks/dsh-install.js:
// detection (zero-touch, unchanged), bridge registration/removal through the
// `dsh plugin` CLI (idempotent, fail-closed), and the manifest checks that
// gate both.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BRIDGE_PACKAGE_NAME,
  installDeepSeekHarnessBridge,
  isBridgeInstalled,
  isDshInstalled,
  registerDeepSeekHarness,
  unregisterDeepSeekHarness,
  uninstallDeepSeekHarnessBridge,
} = require("../hooks/dsh-install");

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-test-"));
}

// A minimal DSH home: profiles/web/package.json carrying the harness layout
// marker (profiles/ exists → isDshInstalled's home check passes).
function makeDshHome({ withBridge = false } = {}) {
  const home = makeHome();
  const profileDir = path.join(home, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  const manifest = {
    name: "dsh-profile-web",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
  };
  if (withBridge) {
    manifest.dependencies[BRIDGE_PACKAGE_NAME] = "link:external/dsh-clawd-bridge";
    manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
  }
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify(manifest, null, 2));
  return home;
}

function makeOptions(home, execFileSync) {
  return { dshHome: home, execFileSync };
}

test("isDshInstalled: home layout (profiles/) is authoritative", () => {
  const home = makeDshHome();
  assert.strictEqual(isDshInstalled({ dshHome: home }), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("isDshInstalled: empty home without a dsh command is not installed", () => {
  const home = makeHome();
  assert.strictEqual(isDshInstalled({ dshHome: home, dshCommandAvailable: false }), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("isBridgeInstalled: false without bridge rows, true with them", () => {
  const plain = makeDshHome();
  assert.strictEqual(isBridgeInstalled({ dshHome: plain }), false);
  const bridged = makeDshHome({ withBridge: true });
  assert.strictEqual(isBridgeInstalled({ dshHome: bridged }), true);
  fs.rmSync(plain, { recursive: true, force: true });
  fs.rmSync(bridged, { recursive: true, force: true });
});

test("registerDeepSeekHarness stays zero-touch (never writes the bridge)", () => {
  const home = makeDshHome();
  const calls = [];
  const options = makeOptions(home, (...args) => { calls.push(args); return ""; });
  const result = registerDeepSeekHarness(options);
  assert.deepStrictEqual(result, { installed: true, skipped: false, updated: false });
  assert.strictEqual(calls.length, 0, "detection must not shell out");
  assert.strictEqual(isBridgeInstalled({ dshHome: home }), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("installDeepSeekHarnessBridge: skips when DSH is not installed", () => {
  const home = makeHome();
  const result = installDeepSeekHarnessBridge(makeOptions(home, () => {
    throw new Error("must not run dsh");
  }));
  assert.deepStrictEqual(result, { status: "skipped", reason: "dsh-not-found" });
  fs.rmSync(home, { recursive: true, force: true });
});

test("installDeepSeekHarnessBridge: idempotent when already registered", () => {
  const home = makeDshHome({ withBridge: true });
  const calls = [];
  const result = installDeepSeekHarnessBridge(makeOptions(home, (...args) => {
    calls.push(args);
    return "";
  }));
  assert.deepStrictEqual(result, { status: "ok", updated: false });
  assert.strictEqual(calls.length, 0, "already-registered bridge must not re-run dsh");
  fs.rmSync(home, { recursive: true, force: true });
});

test("installDeepSeekHarnessBridge: runs dsh plugin add and re-verifies", () => {
  const home = makeDshHome();
  const seen = [];
  const options = makeOptions(home, (command, args) => {
    seen.push([command, args]);
    if (command === "where") return ""; // no shim → dsh invoked directly
    // Simulate what `dsh plugin add` does to the manifest: register the
    // dependency and the bundle layer.
    const manifestPath = path.join(home, "profiles", "web", "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.dependencies[BRIDGE_PACKAGE_NAME] = "link:external/dsh-clawd-bridge";
    manifest.dsh.profile.bundles.push(BRIDGE_PACKAGE_NAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return "";
  });
  const result = installDeepSeekHarnessBridge(options);
  assert.deepStrictEqual(result, { status: "ok", updated: true });
  const cliCall = seen.find(([command]) => command === "dsh");
  assert.ok(cliCall, "expected a direct dsh invocation");
  assert.match(cliCall[1].join(" "), /plugin --profile web add/);
  assert.match(cliCall[1].join(" "), /dsh-clawd-bridge/);
  assert.strictEqual(isBridgeInstalled({ dshHome: home }), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("installDeepSeekHarnessBridge: fails closed when dsh plugin add throws", () => {
  const home = makeDshHome();
  const result = installDeepSeekHarnessBridge(makeOptions(home, () => {
    throw new Error("dsh not on PATH");
  }));
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /dsh not on PATH/);
  assert.strictEqual(isBridgeInstalled({ dshHome: home }), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("installDeepSeekHarnessBridge: error when add does not register the bridge", () => {
  const home = makeDshHome();
  const result = installDeepSeekHarnessBridge(makeOptions(home, () => ""));
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /bridge is not registered/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("uninstallDeepSeekHarnessBridge: skips when not installed", () => {
  const home = makeDshHome();
  const result = uninstallDeepSeekHarnessBridge(makeOptions(home, () => {
    throw new Error("must not run dsh");
  }));
  assert.deepStrictEqual(result, { status: "skipped", reason: "bridge-not-installed" });
  fs.rmSync(home, { recursive: true, force: true });
});

test("uninstallDeepSeekHarnessBridge: runs dsh plugin remove and re-verifies", () => {
  const home = makeDshHome({ withBridge: true });
  const seen = [];
  const options = makeOptions(home, (command, args) => {
    seen.push([command, args]);
    if (command === "where") return "";
    const manifestPath = path.join(home, "profiles", "web", "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((b) => b !== BRIDGE_PACKAGE_NAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return "";
  });
  const result = uninstallDeepSeekHarnessBridge(options);
  assert.deepStrictEqual(result, { status: "ok", updated: true });
  const cliCall = seen.find(([command]) => command === "dsh");
  assert.ok(cliCall, "expected a direct dsh invocation");
  assert.match(cliCall[1].join(" "), /plugin --profile web remove/);
  assert.match(cliCall[1].join(" "), /dsh-clawd-bridge/);
  assert.strictEqual(isBridgeInstalled({ dshHome: home }), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("uninstallDeepSeekHarnessBridge: fails closed when dsh plugin remove throws", () => {
  const home = makeDshHome({ withBridge: true });
  const result = uninstallDeepSeekHarnessBridge(makeOptions(home, () => {
    throw new Error("dsh remove failed");
  }));
  assert.strictEqual(result.status, "error");
  assert.strictEqual(isBridgeInstalled({ dshHome: home }), true, "failed removal must leave the manifest intact");
  fs.rmSync(home, { recursive: true, force: true });
});

test("unregisterDeepSeekHarness: reports removed when the bridge was present", () => {
  const home = makeDshHome({ withBridge: true });
  const options = makeOptions(home, () => {
    const manifestPath = path.join(home, "profiles", "web", "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.dependencies[BRIDGE_PACKAGE_NAME];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((b) => b !== BRIDGE_PACKAGE_NAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return "";
  });
  const result = unregisterDeepSeekHarness(options);
  assert.deepStrictEqual(result, { removed: true, skipped: false });
  fs.rmSync(home, { recursive: true, force: true });
});

test("unregisterDeepSeekHarness: no-op when nothing was managed", () => {
  const home = makeDshHome();
  const result = unregisterDeepSeekHarness(makeOptions(home, () => {
    throw new Error("must not run dsh");
  }));
  assert.deepStrictEqual(result, { removed: false, skipped: true });
  fs.rmSync(home, { recursive: true, force: true });
});
