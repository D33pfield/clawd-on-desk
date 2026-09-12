const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerGrokHooks,
  unregisterGrokHooks,
  GROK_HOOK_EVENTS,
  resolveGrokConfigPath,
  resolveGrokHome,
  desiredHookCommand,
} = require("../hooks/grok-install");
const { detectAgentInstallation } = require("../src/agent-installation-detector");
const { getAgentDescriptor } = require("../src/doctor-detectors/agent-descriptors");
const { buildCleanupOptionsForHome, cleanupIntegrations } = require("../hooks/cleanup-integrations");

const MARKER = "grok-hook.js";
const tempDirs = [];

function makeTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-grok-home-"));
  tempDirs.push(homeDir);
  return homeDir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Grok hook installer", () => {
  it("skips registration when ~/.grok is missing", () => {
    const homeDir = makeTempHome();
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
    assert.strictEqual(result.added, 0);
    assert.strictEqual(fs.existsSync(resolveGrokConfigPath({ homeDir })), false);
  });

  it("writes nested Claude-compatible hooks into ~/.grok/hooks/clawd.json", () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, ".grok"), { recursive: true });
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
    assert.strictEqual(result.added, GROK_HOOK_EVENTS.length);
    const configPath = resolveGrokConfigPath({ homeDir });
    const settings = readJson(configPath);
    for (const event of GROK_HOOK_EVENTS) {
      const command = settings.hooks[event][0].hooks[0].command;
      assert.ok(command.includes(MARKER));
      assert.ok(command.includes("/usr/local/bin/node"));
    }
  });

  it("is idempotent when the owned file is already current", () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, ".grok"), { recursive: true });
    registerGrokHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
    const second = registerGrokHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.skipped, GROK_HOOK_EVENTS.length);
  });

  it("preserves foreign handlers in a mixed clawd.json", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      env: { KEEP: "yes" },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "python3 /tmp/user-audit.py" }] }],
      },
    });
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
    assert.ok(result.added > 0);
    const settings = readJson(configPath);
    assert.strictEqual(settings.env.KEEP, "yes");
    const stopCommands = settings.hooks.Stop.flatMap((entry) => (entry.hooks || []).map((hook) => hook.command));
    assert.ok(stopCommands.some((command) => command.includes("user-audit.py")));
    assert.ok(stopCommands.some((command) => command.includes(MARKER)));
  });

  it("does not delete a foreign clawd.json on uninstall", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "python3 /tmp/user-audit.py" }] }],
      },
    });
    const removed = unregisterGrokHooks({ homeDir, silent: true });
    assert.strictEqual(removed.removed, 0);
    assert.strictEqual(removed.changed, false);
    assert.strictEqual(fs.existsSync(configPath), true);
    const settings = readJson(configPath);
    assert.strictEqual(settings.hooks.Stop[0].hooks[0].command, "python3 /tmp/user-audit.py");
  });

  it("replaces the legacy python bridge command without dropping sibling hooks", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    writeJson(configPath, {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "python3 /tmp/clawd-bridge.py" }] },
          { hooks: [{ type: "command", command: "python3 /tmp/user-audit.py" }] },
        ],
      },
    });
    registerGrokHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
    const settings = readJson(configPath);
    const stopCommands = settings.hooks.Stop.flatMap((entry) => (entry.hooks || []).map((hook) => hook.command));
    assert.ok(!stopCommands.some((command) => command.includes("clawd-bridge.py")));
    assert.ok(stopCommands.some((command) => command.includes("user-audit.py")));
    assert.ok(stopCommands.some((command) => command.includes(MARKER)));
  });

  it("uninstall removes only managed hooks and deletes an owned empty file", () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, ".grok"), { recursive: true });
    registerGrokHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
    const configPath = resolveGrokConfigPath({ homeDir });
    assert.strictEqual(fs.existsSync(configPath), true);
    const removed = unregisterGrokHooks({ homeDir, silent: true });
    assert.ok(removed.removed > 0);
    assert.strictEqual(fs.existsSync(configPath), false);
  });

  it("prefers GROK_HOME over homeDir/.grok for install and uninstall", () => {
    const homeDir = makeTempHome();
    const grokHome = path.join(homeDir, "custom-grok");
    fs.mkdirSync(grokHome, { recursive: true });
    const env = { GROK_HOME: grokHome };
    assert.strictEqual(resolveGrokHome({ homeDir, env }), grokHome);
    const result = registerGrokHooks({ homeDir, env, silent: true, nodeBin: "/usr/local/bin/node" });
    const customPath = resolveGrokConfigPath({ homeDir, env });
    assert.ok(customPath.startsWith(grokHome));
    assert.strictEqual(fs.existsSync(customPath), true);
    assert.strictEqual(fs.existsSync(path.join(homeDir, ".grok", "hooks", "clawd.json")), false);
    const removed = unregisterGrokHooks({ homeDir, env, silent: true });
    assert.ok(removed.removed > 0);
    assert.strictEqual(fs.existsSync(customPath), false);
    assert.strictEqual(result.configPath, customPath);
  });

  it("detects and cleans GROK_HOME instead of homeDir/.grok", async () => {
    const homeDir = makeTempHome();
    const grokHome = path.join(homeDir, "custom-grok");
    fs.mkdirSync(grokHome, { recursive: true });
    const env = { GROK_HOME: grokHome };
    registerGrokHooks({ homeDir, env, silent: true, nodeBin: "/usr/local/bin/node" });
    const customPath = resolveGrokConfigPath({ homeDir, env });
    const detected = detectAgentInstallation(getAgentDescriptor("grok"), { homeDir, env });
    assert.strictEqual(detected.paths.parentDir, grokHome);
    assert.strictEqual(detected.paths.configPath, customPath);
    assert.strictEqual(detected.detectedInstalled, true);
    const plan = buildCleanupOptionsForHome(homeDir, { env, silent: true, hermesCommand: false });
    assert.strictEqual(plan.byAgent.grok.configPath, customPath);
    await cleanupIntegrations({ homeDir, env, silent: true, backup: true, hermesCommand: false });
    assert.strictEqual(fs.existsSync(customPath), false);
  });

  it("emits a PowerShell call operator for Windows hook commands", () => {
    const command = desiredHookCommand(
      "C:/Program Files/nodejs/node.exe",
      "C:/Clawd on Desk/hooks/grok-hook.js",
      { platform: "win32" }
    );
    assert.ok(command.startsWith("& "));
    assert.ok(command.includes('"C:/Program Files/nodejs/node.exe"'));
    assert.ok(command.includes('"C:/Clawd on Desk/hooks/grok-hook.js"'));
  });
});
