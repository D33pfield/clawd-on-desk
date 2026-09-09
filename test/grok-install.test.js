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
} = require("../hooks/grok-install");

const MARKER = "grok-hook.js";
const tempDirs = [];

function makeTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-grok-home-"));
  tempDirs.push(homeDir);
  return homeDir;
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
    const settings = JSON.parse(fs.readFileSync(configPath, "utf8"));
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

  it("replaces a stale clawd.json from the previous Grok bridge", () => {
    const homeDir = makeTempHome();
    const configPath = resolveGrokConfigPath({ homeDir });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "python3 /tmp/clawd-bridge.py" }] }],
      },
    }, null, 2));
    const result = registerGrokHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
    assert.ok(result.added > 0 || result.updated > 0);
    const settings = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.ok(settings.hooks.Stop[0].hooks[0].command.includes(MARKER));
    assert.ok(!JSON.stringify(settings).includes("clawd-bridge.py"));
  });

  it("uninstall removes the owned clawd.json", () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, ".grok"), { recursive: true });
    registerGrokHooks({ homeDir, silent: true, nodeBin: "/usr/local/bin/node" });
    const configPath = resolveGrokConfigPath({ homeDir });
    assert.strictEqual(fs.existsSync(configPath), true);
    const removed = unregisterGrokHooks({ homeDir, silent: true });
    assert.ok(removed.removed > 0);
    assert.strictEqual(fs.existsSync(configPath), false);
  });
});
