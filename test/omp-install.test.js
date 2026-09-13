"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ompInstall = require("../hooks/omp-install");
const piInstall = require("../hooks/pi-install");

describe("omp-install", () => {
  let parentDir;
  let extensionsDir;
  let extensionDir;

  beforeEach(() => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-omp-install-"));
    extensionsDir = path.join(parentDir, "extensions");
    extensionDir = path.join(extensionsDir, "clawd-on-desk");
    fs.mkdirSync(extensionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  const install = (options = {}) =>
    ompInstall.registerOmpExtension({ parentDir, silent: true, ...options });
  const uninstall = (options = {}) =>
    ompInstall.unregisterOmpExtension({ parentDir, silent: true, ...options });
  const readMarker = () =>
    JSON.parse(fs.readFileSync(path.join(extensionDir, ompInstall.MARKER_FILE), "utf8"));

  describe("paths", () => {
    it("installs under ~/.omp, never ~/.pi", () => {
      assert.ok(ompInstall.DEFAULT_PARENT_DIR.endsWith(path.join(".omp", "agent")));
      assert.notStrictEqual(ompInstall.DEFAULT_PARENT_DIR, piInstall.DEFAULT_PARENT_DIR);
      assert.notStrictEqual(ompInstall.DEFAULT_EXTENSION_DIR, piInstall.DEFAULT_EXTENSION_DIR);
      assert.strictEqual(ompInstall.CORE_FILE, "omp-extension-core.js");
    });
  });

  describe("install", () => {
    it("writes the extension, its core and a managed marker", () => {
      const result = install();
      assert.strictEqual(result.installed, true);
      assert.strictEqual(result.updated, true);

      assert.deepStrictEqual(
        fs.readdirSync(extensionDir).sort(),
        [ompInstall.MARKER_FILE, ompInstall.CORE_FILE, ompInstall.EXTENSION_FILE].sort()
      );
      const marker = readMarker();
      assert.strictEqual(marker.integration, "omp");
      assert.strictEqual(marker.managed, true);

      // The installed entry point must pull in the OMP core, not Pi's.
      const entry = fs.readFileSync(path.join(extensionDir, ompInstall.EXTENSION_FILE), "utf8");
      assert.ok(entry.includes("omp-extension-core.js"));
      assert.ok(!entry.includes("pi-extension-core.js"));
      assert.ok(entry.includes("@oh-my-pi/pi-coding-agent"));
    });

    it("is idempotent", () => {
      install();
      const second = install();
      assert.strictEqual(second.installed, true);
      assert.strictEqual(second.updated, false, "an unchanged reinstall is not an update");
    });

    it("reports an update when the shipped source changes", () => {
      install();
      fs.writeFileSync(path.join(extensionDir, ompInstall.EXTENSION_FILE), "// stale\n");
      assert.strictEqual(install().updated, true);
    });

    it("skips when OMP is not installed and no extensions tree exists", () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-omp-absent-"));
      try {
        const result = ompInstall.registerOmpExtension({
          parentDir: path.join(empty, "agent"),
          silent: true,
          ompCommandAvailable: false,
        });
        assert.strictEqual(result.installed, false);
        assert.strictEqual(result.reason, "omp-not-found");
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  // The community bridge (github.com/Crosery/clawd-on-desk-omp) is a single
  // sibling file reporting the same events through the custom-application
  // channel. Installing alongside it would make OMP load both and POST twice.
  describe("community bridge", () => {
    const bridgePath = () => path.join(extensionsDir, ompInstall.STANDALONE_BRIDGE_FILE);

    it("refuses to install next to it", () => {
      fs.writeFileSync(bridgePath(), "// clawd-on-desk-omp\n");
      const result = install();
      assert.strictEqual(result.installed, false);
      assert.strictEqual(result.reason, "standalone-bridge-present");
      assert.strictEqual(result.standaloneBridge, bridgePath());
      assert.ok(!fs.existsSync(extensionDir), "nothing may be written while it is present");
    });

    it("installs once it is removed", () => {
      fs.writeFileSync(bridgePath(), "// clawd-on-desk-omp\n");
      assert.strictEqual(install().installed, false);
      fs.unlinkSync(bridgePath());
      assert.strictEqual(install().installed, true);
    });

    it("finds it only as a direct sibling of the extension directory", () => {
      assert.strictEqual(ompInstall.findStandaloneBridge({ parentDir }), null);
      fs.writeFileSync(bridgePath(), "// bridge\n");
      assert.strictEqual(ompInstall.findStandaloneBridge({ parentDir }), bridgePath());
    });
  });

  describe("ownership", () => {
    it("never clobbers an extension directory Clawd does not own", () => {
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "index.ts"), "// someone else's\n");

      const result = install();
      assert.strictEqual(result.installed, false);
      assert.strictEqual(result.reason, "unmanaged-existing-extension");
      assert.strictEqual(
        fs.readFileSync(path.join(extensionDir, "index.ts"), "utf8"),
        "// someone else's\n"
      );
    });

    it("does not accept Pi's marker as its own", () => {
      assert.strictEqual(ompInstall.isManagedMarker(ompInstall.buildMarker()), true);
      assert.strictEqual(
        ompInstall.isManagedMarker(piInstall.buildMarker()),
        false,
        "a Pi-managed directory must not be treated as OMP's"
      );
      assert.strictEqual(piInstall.isManagedMarker(ompInstall.buildMarker()), false);
    });
  });

  describe("uninstall", () => {
    it("removes a Clawd-managed extension", () => {
      install();
      const result = uninstall();
      assert.strictEqual(result.removed, true);
      assert.ok(!fs.existsSync(extensionDir));
    });

    it("leaves an unmanaged directory alone", () => {
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "index.ts"), "// someone else's\n");
      const result = uninstall();
      assert.strictEqual(result.removed, false);
      assert.strictEqual(result.reason, "unmanaged-existing-extension");
      assert.ok(fs.existsSync(path.join(extensionDir, "index.ts")));
    });

    it("reports a missing extension without failing", () => {
      const result = uninstall();
      assert.strictEqual(result.removed, false);
      assert.strictEqual(result.reason, "missing");
    });
  });
});
