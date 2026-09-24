const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  installMinimaxPlugin,
  unregisterMinimaxPlugin,
  readOwnership,
  resolveMinimaxDataDir,
  desiredManifest,
  buildDesiredHooksDocument,
  buildOwnerMarker,
  resolveHookScriptPath,
  MINIMAX_HOOK_EVENTS,
  OWNER_MARKER_FILE,
  PLUGIN_DIR_NAME,
} = require("../hooks/minimax-install");
const { writeJsonAtomic } = require("../hooks/json-utils");

const MARKER = "minimax-hook.js";
const tempDirs = [];

function makeTempDataDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-"));
  tempDirs.push(tmpDir);
  return tmpDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

// What the first (pre-marker) MiniMax build wrote: manifest + hooks, no marker.
function writePreMarkerInstall(pluginRoot, hooks) {
  writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), desiredManifest());
  writeJsonFile(
    path.join(pluginRoot, "hooks", "hooks.json"),
    hooks || buildDesiredHooksDocument(resolveHookScriptPath(), "/usr/local/bin/node")
  );
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("MiniMax plugin installer", () => {
  it("writes the Clawd-owned plugin directory with a compatible manifest and CLAUDE-format hooks", () => {
    const dataDir = makeTempDataDir();
    const result = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });

    assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length);

    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    // Ownership is a structured marker (the Pi extension's convention), never
    // a directory name, manifest name or basename.
    assert.deepStrictEqual(readJson(path.join(pluginRoot, OWNER_MARKER_FILE)), {
      app: "clawd-on-desk",
      integration: "minimax",
      managed: true,
      version: 1,
    });
    const manifest = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
    assert.strictEqual(manifest.name, PLUGIN_DIR_NAME);
    assert.deepStrictEqual(manifest.hooks, ["hooks/hooks.json"]);

    const hooks = readJson(path.join(pluginRoot, "hooks", "hooks.json"));
    for (const event of MINIMAX_HOOK_EVENTS) {
      assert.ok(Array.isArray(hooks.hooks[event]), `missing hooks for ${event}`);
      assert.strictEqual(hooks.hooks[event].length, 1);
      const group = hooks.hooks[event][0];
      assert.strictEqual(group.matcher, undefined, "matcher omitted must match all tools");
      assert.ok(Array.isArray(group.hooks));
      const handler = group.hooks[0];
      assert.strictEqual(handler.type, "command");
      // Exec-form args: command is the bare node path, the hook script rides
      // in args — spawned directly, no shell, no quoting pitfalls.
      assert.strictEqual(handler.command, "/usr/local/bin/node");
      assert.deepStrictEqual(handler.args, [
        path.resolve(__dirname, "../hooks/minimax-hook.js").replace(/\\/g, "/"),
      ]);
      assert.ok(handler.args[0].includes(MARKER), `handler must reference the ${MARKER} marker`);
      assert.ok(Number.isInteger(handler.timeout) && handler.timeout >= 1 && handler.timeout <= 10,
        `timeout must be whole seconds within MiniMax's 1–10 clamp, got ${handler.timeout}`);
    }
    // PermissionRequest must never be registered (state-only Phase 1).
    assert.strictEqual(hooks.hooks.PermissionRequest, undefined);
    assert.strictEqual(hooks.hooks.Notification, undefined);
  });

  it("is idempotent on second run (skipped, bytes unchanged)", () => {
    const dataDir = makeTempDataDir();
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const hooksPath = path.join(dataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json");
    const before = fs.readFileSync(hooksPath, "utf8");

    const result = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, MINIMAX_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), before);
  });

  it("refreshes the node path on an owned install (updated)", () => {
    const dataDir = makeTempDataDir();
    installMinimaxPlugin({ dataDir, nodeBin: "/old/node", silent: true });

    const result = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });

    assert.strictEqual(result.updated, MINIMAX_HOOK_EVENTS.length);
    const hooks = readJson(path.join(dataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json"));
    assert.strictEqual(hooks.hooks.Stop[0].hooks[0].command, "/usr/local/bin/node");
  });

  it("fails closed when a directory claims our manifest name but carries no ownership marker", () => {
    // A manifest name is not ownership. Without the structured marker (or the
    // exact pre-marker document), any directory claiming our name could be
    // silently overwritten or recursively deleted.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: PLUGIN_DIR_NAME }),
      "utf8"
    );
    // Parseable hooks document but no minimax-hook.js reference anywhere.
    fs.writeFileSync(
      path.join(pluginRoot, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
      "utf8"
    );

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    const uninstalled = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(uninstalled.removed, 0, "uninstall must refuse without the marker");
    assert.ok(fs.existsSync(path.join(pluginRoot, "hooks", "hooks.json")), "directory must be untouched");
  });

  it("fails closed when the hooks document is corrupt in an owned-manifest directory", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: PLUGIN_DIR_NAME }),
      "utf8"
    );
    fs.writeFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "{corrupt", "utf8");

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    assert.strictEqual(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"), "{corrupt");
  });

  it("fails closed on an existing foreign directory and leaves its content untouched", () => {
    const dataDir = makeTempDataDir();
    const foreignRoot = path.join(dataDir, "plugins", "other-plugin");
    fs.mkdirSync(foreignRoot, { recursive: true });
    fs.writeFileSync(path.join(foreignRoot, "user.txt"), "keep me", "utf8");

    assert.throws(
      () => installMinimaxPlugin({ pluginRoot: foreignRoot, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    assert.strictEqual(fs.readFileSync(path.join(foreignRoot, "user.txt"), "utf8"), "keep me");
  });

  it("fails closed on a foreign MINIMAX-kind plugin (different manifest path)", () => {
    const dataDir = makeTempDataDir();
    const foreignRoot = path.join(dataDir, "plugins", "someone-else");
    fs.mkdirSync(path.join(foreignRoot, ".minimax-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(foreignRoot, ".minimax-plugin", "plugin.json"),
      JSON.stringify({ name: "someone-else" }),
      "utf8"
    );

    assert.throws(
      () => installMinimaxPlugin({ pluginRoot: foreignRoot, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    assert.ok(fs.existsSync(path.join(foreignRoot, ".minimax-plugin", "plugin.json")));
  });

  it("fails closed when the owned manifest is renamed to a foreign plugin name", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "not-clawd" }),
      "utf8"
    );

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
  });

  it("fails closed when the manifest file is unreadable", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "not json", "utf8");

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
  });

  it("skips install when the MiniMax data directory does not exist (not installed)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-home-"));
    tempDirs.push(homeDir);
    const result = installMinimaxPlugin({ homeDir, nodeBin: "/usr/local/bin/node", silent: true });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(fs.existsSync(path.join(homeDir, ".minimax")), false);
  });

  it("honors MINIMAX_DATA_DIR over ~/.minimax", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-home2-"));
    const envDataDir = path.join(homeDir, "custom-data");
    fs.mkdirSync(envDataDir, { recursive: true });
    tempDirs.push(homeDir);

    const previous = process.env.MINIMAX_DATA_DIR;
    process.env.MINIMAX_DATA_DIR = envDataDir;
    try {
      assert.strictEqual(resolveMinimaxDataDir(homeDir), envDataDir);
      const result = installMinimaxPlugin({ nodeBin: "/usr/local/bin/node", silent: true });
      assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length);
      assert.ok(fs.existsSync(path.join(envDataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json")));
    } finally {
      if (previous === undefined) delete process.env.MINIMAX_DATA_DIR;
      else process.env.MINIMAX_DATA_DIR = previous;
    }
  });

  it("falls back to MAVIS_DATA_DIR when MINIMAX_DATA_DIR is unset (upstream v0.5.1 precedence)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-home3-"));
    const mavisDataDir = path.join(homeDir, "mavis-data");
    fs.mkdirSync(mavisDataDir, { recursive: true });
    tempDirs.push(homeDir);

    const previousMinimax = process.env.MINIMAX_DATA_DIR;
    const previousMavis = process.env.MAVIS_DATA_DIR;
    delete process.env.MINIMAX_DATA_DIR;
    process.env.MAVIS_DATA_DIR = mavisDataDir;
    try {
      assert.strictEqual(resolveMinimaxDataDir(homeDir), mavisDataDir);
      const result = installMinimaxPlugin({ nodeBin: "/usr/local/bin/node", silent: true });
      assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length);
      assert.ok(fs.existsSync(path.join(mavisDataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json")));
    } finally {
      if (previousMinimax === undefined) delete process.env.MINIMAX_DATA_DIR;
      else process.env.MINIMAX_DATA_DIR = previousMinimax;
      if (previousMavis === undefined) delete process.env.MAVIS_DATA_DIR;
      else process.env.MAVIS_DATA_DIR = previousMavis;
    }
  });

  it("round-trips a custom data dir through install → unregister using the SAME resolution", () => {
    // Regression for the review finding: install honored MINIMAX_DATA_DIR but
    // the cleanup path hardcoded ~/.minimax, leaving the plugin behind. The
    // uninstaller must resolve through the identical helper.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-home4-"));
    const envDataDir = path.join(homeDir, "envdata");
    fs.mkdirSync(envDataDir, { recursive: true });
    tempDirs.push(homeDir);

    const pluginRoot = path.join(envDataDir, "plugins", PLUGIN_DIR_NAME);
    let result = installMinimaxPlugin({
      homeDir,
      env: { MINIMAX_DATA_DIR: envDataDir },
      nodeBin: "/usr/local/bin/node",
      silent: true,
    });
    assert.strictEqual(result.added, MINIMAX_HOOK_EVENTS.length);
    assert.ok(fs.existsSync(pluginRoot));

    result = unregisterMinimaxPlugin({
      homeDir,
      env: { MINIMAX_DATA_DIR: envDataDir },
      silent: true,
    });
    assert.strictEqual(result.removed, MINIMAX_HOOK_EVENTS.length);
    assert.strictEqual(fs.existsSync(pluginRoot), false);
  });

  it("never overwrites or deletes a same-name foreign plugin (manifest claims clawd-state but no marker)", () => {
    const dataDir = makeTempDataDir();
    const foreignRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.join(foreignRoot, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(foreignRoot, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(foreignRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: PLUGIN_DIR_NAME, description: "someone else's plugin" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(foreignRoot, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo third-party" }] }] } }),
      "utf8"
    );
    const before = fs.readFileSync(path.join(foreignRoot, "hooks", "hooks.json"), "utf8");

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    const removed = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(removed.removed, 0);
    assert.strictEqual(fs.readFileSync(path.join(foreignRoot, "hooks", "hooks.json"), "utf8"), before);
  });

  it("unregister removes the owned plugin directory", () => {
    const dataDir = makeTempDataDir();
    installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });

    assert.strictEqual(result.removed, MINIMAX_HOOK_EVENTS.length);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(fs.existsSync(pluginRoot), false);
  });

  it("unregister leaves foreign directories untouched", () => {
    const dataDir = makeTempDataDir();
    const foreignRoot = path.join(dataDir, "plugins", "other-plugin");
    fs.mkdirSync(foreignRoot, { recursive: true });
    fs.writeFileSync(path.join(foreignRoot, "user.txt"), "keep me", "utf8");

    const result = unregisterMinimaxPlugin({ pluginRoot: foreignRoot, silent: true });

    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(fs.readFileSync(path.join(foreignRoot, "user.txt"), "utf8"), "keep me");
  });

  it("unregister is a no-op when the plugin directory is absent", () => {
    const dataDir = makeTempDataDir();
    const result = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.changed, false);
  });

  it("never adopts a same-name plugin that only mentions minimax-hook.js in an unrelated field", () => {
    // #1038 follow-up: the basename anywhere in the hooks JSON used to count
    // as ownership, which let Uninstall recursively delete a foreign plugin.
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
      name: PLUGIN_DIR_NAME,
      description: "unrelated plugin",
    });
    writeJsonFile(path.join(pluginRoot, "hooks", "hooks.json"), {
      note: "minimax-hook.js is an example filename",
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo third-party" }] }] },
    });
    const before = fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8");

    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason: "missing-marker" });
    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /not a Clawd plugin/
    );
    const removed = unregisterMinimaxPlugin({ dataDir, silent: true });
    assert.strictEqual(removed.removed, 0);
    assert.strictEqual(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"), before);
  });

  it("writes the ownership marker first, so an install interrupted between writes is repaired, not stranded", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
    const failHooksWrite = (filePath, data) => {
      if (filePath === hooksPath) {
        const err = new Error("ENOSPC: no space left on device");
        err.code = "ENOSPC";
        throw err;
      }
      return writeJsonAtomic(filePath, data);
    };

    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true, writeJsonAtomic: failHooksWrite }),
      /ENOSPC/
    );
    assert.ok(fs.existsSync(path.join(pluginRoot, OWNER_MARKER_FILE)), "the marker must land before the other files");
    assert.strictEqual(fs.existsSync(hooksPath), false);
    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: true, via: "marker" });

    // The next sync / Settings Install repairs the half-written directory...
    const repaired = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });
    assert.strictEqual(repaired.updated, MINIMAX_HOOK_EVENTS.length);
    assert.strictEqual(readJson(hooksPath).hooks.Stop[0].hooks[0].command, "/usr/local/bin/node");
    // ...and Uninstall can always remove what Clawd itself created.
    assert.strictEqual(unregisterMinimaxPlugin({ dataDir, silent: true }).removed, MINIMAX_HOOK_EVENTS.length);
    assert.strictEqual(fs.existsSync(pluginRoot), false);
  });

  it("uninstall removes a half-written directory that holds only the ownership marker", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writeJsonFile(path.join(pluginRoot, OWNER_MARKER_FILE), buildOwnerMarker());

    const result = unregisterMinimaxPlugin({ dataDir, silent: true });

    assert.strictEqual(result.changed, true);
    assert.strictEqual(fs.existsSync(pluginRoot), false);
  });

  it("adopts a pre-marker install only when it is exactly the generated document, then adds the marker", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writePreMarkerInstall(pluginRoot);
    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: true, via: "legacy" });

    const result = installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true });

    assert.strictEqual(result.ownerMarkerAdded, true);
    assert.strictEqual(result.skipped, MINIMAX_HOOK_EVENTS.length, "hooks were already current");
    assert.deepStrictEqual(readJson(path.join(pluginRoot, OWNER_MARKER_FILE)), buildOwnerMarker());
    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: true, via: "marker" });
  });

  it("refuses a pre-marker lookalike whose hooks document differs from the generated one in any way", () => {
    const script = resolveHookScriptPath();
    const variants = {
      "an extra foreign handler": (doc) => {
        doc.hooks.PreToolUse[0].hooks.push({ type: "command", command: "echo audit" });
      },
      "a matcher on a group": (doc) => {
        doc.hooks.PreToolUse[0].matcher = "Bash";
      },
      "a foreign script path": (doc) => {
        doc.hooks.Stop[0].hooks[0].args = ["/opt/other/hook.js"];
      },
      "a different timeout": (doc) => {
        doc.hooks.Stop[0].hooks[0].timeout = 5;
      },
      "a missing event": (doc) => {
        delete doc.hooks.PostCompact;
      },
      "an extra top-level key": (doc) => {
        doc.description = "mine";
      },
      "an extra field on a handler": (doc) => {
        doc.hooks.Stop[0].hooks[0] = { ...doc.hooks.Stop[0].hooks[0], env: { AUDIT: "1" } };
      },
      "a different command on one handler": (doc) => {
        doc.hooks.Stop[0].hooks[0] = { ...doc.hooks.Stop[0].hooks[0], command: "/opt/other/node" };
      },
    };
    for (const [label, mutate] of Object.entries(variants)) {
      const dataDir = makeTempDataDir();
      const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
      const doc = buildDesiredHooksDocument(script, "/usr/local/bin/node");
      mutate(doc);
      writePreMarkerInstall(pluginRoot, doc);

      assert.strictEqual(readOwnership(pluginRoot).owned, false, label);
      assert.throws(
        () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
        /not a Clawd plugin/,
        label
      );
      assert.strictEqual(unregisterMinimaxPlugin({ dataDir, silent: true }).removed, 0, label);
      assert.deepStrictEqual(readJson(path.join(pluginRoot, "hooks", "hooks.json")), doc, label);
    }
  });

  it("refuses an ownership marker that belongs to another integration", () => {
    const dataDir = makeTempDataDir();
    const pluginRoot = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    writePreMarkerInstall(pluginRoot);
    writeJsonFile(path.join(pluginRoot, OWNER_MARKER_FILE), { app: "clawd-on-desk", integration: "pi", managed: true });

    assert.deepStrictEqual(readOwnership(pluginRoot), { owned: false, reason: "foreign-owner-marker" });
    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/usr/local/bin/node", silent: true }),
      /foreign-owner-marker/
    );
    assert.strictEqual(unregisterMinimaxPlugin({ dataDir, silent: true }).removed, 0);
    assert.ok(fs.existsSync(path.join(pluginRoot, "hooks", "hooks.json")));
  });

  it("treats a symlinked plugin root as foreign and never writes or deletes through it", {
    skip: process.platform === "win32",
  }, () => {
    const dataDir = makeTempDataDir();
    const target = path.join(dataDir, "elsewhere", PLUGIN_DIR_NAME);
    installMinimaxPlugin({ pluginRoot: target, nodeBin: "/usr/local/bin/node", silent: true });
    const before = fs.readFileSync(path.join(target, "hooks", "hooks.json"), "utf8");
    const link = path.join(dataDir, "plugins", PLUGIN_DIR_NAME);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, "dir");

    assert.deepStrictEqual(readOwnership(link), { owned: false, reason: "symlink-root" });
    assert.throws(
      () => installMinimaxPlugin({ dataDir, nodeBin: "/other/node", silent: true }),
      /symlink-root/
    );
    assert.strictEqual(unregisterMinimaxPlugin({ dataDir, silent: true }).removed, 0);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "the link itself must survive");
    assert.strictEqual(fs.readFileSync(path.join(target, "hooks", "hooks.json"), "utf8"), before);
  });

  it("keeps the recorded absolute node path when node detection fails", () => {
    const dataDir = makeTempDataDir();
    const recordedNode = path.join(dataDir, "node-bin", "node");
    fs.mkdirSync(path.dirname(recordedNode), { recursive: true });
    fs.writeFileSync(recordedNode, "", "utf8");
    installMinimaxPlugin({ dataDir, nodeBin: recordedNode, silent: true });
    const hooksPath = path.join(dataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json");

    // nodeBin: null is what resolveNodeBin() returns when detection fails.
    const result = installMinimaxPlugin({ dataDir, nodeBin: null, silent: true });

    assert.strictEqual(result.skipped, MINIMAX_HOOK_EVENTS.length, "nothing to rewrite");
    for (const event of MINIMAX_HOOK_EVENTS) {
      assert.strictEqual(readJson(hooksPath).hooks[event][0].hooks[0].command, recordedNode, event);
    }
  });

  it("falls back to bare node only when the recorded node path no longer exists", () => {
    const dataDir = makeTempDataDir();
    installMinimaxPlugin({ dataDir, nodeBin: path.join(dataDir, "removed", "node"), silent: true });

    const result = installMinimaxPlugin({ dataDir, nodeBin: null, silent: true });

    assert.strictEqual(result.updated, MINIMAX_HOOK_EVENTS.length);
    const hooks = readJson(path.join(dataDir, "plugins", PLUGIN_DIR_NAME, "hooks", "hooks.json"));
    assert.strictEqual(hooks.hooks.Stop[0].hooks[0].command, "node");
  });

  it("registers exactly the 10 state events and never PermissionRequest", () => {
    assert.deepStrictEqual([...MINIMAX_HOOK_EVENTS].sort(), [
      "PostCompact",
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStart",
      "SubagentStop",
      "UserPromptSubmit",
    ]);
    assert.ok(!MINIMAX_HOOK_EVENTS.includes("PermissionRequest"));
    assert.ok(!MINIMAX_HOOK_EVENTS.includes("Notification"));
  });
});
