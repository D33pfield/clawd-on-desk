const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { describe, it } = require("node:test");

const pluginDir = path.join(__dirname, "..", "hooks", "hermes-plugin");

function readPluginSource() {
  return fs.readFileSync(path.join(pluginDir, "__init__.py"), "utf8");
}

function readManifestHooks() {
  const text = fs.readFileSync(path.join(pluginDir, "plugin.yaml"), "utf8");
  const hooks = [];
  let inHooks = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^hooks:\s*$/.test(line)) {
      inHooks = true;
      continue;
    }
    if (inHooks && /^\S/.test(line)) break;
    const match = line.match(/^\s*-\s*([A-Za-z0-9_]+)\s*$/);
    if (inHooks && match) hooks.push(match[1]);
  }
  return hooks;
}

describe("Hermes plugin", () => {
  it("keeps manifest hook declarations aligned with registered hooks", () => {
    const source = readPluginSource();
    const hooks = readManifestHooks();
    for (const hook of hooks) {
      assert.match(source, new RegExp(`"${hook}"\\s*:`), `${hook} should be mapped in HOOK_TO_STATE`);
    }
    assert.ok(hooks.includes("on_session_finalize"));
    assert.ok(hooks.includes("on_session_reset"));
    assert.ok(!hooks.includes("subagent_stop"));
    assert.ok(!hooks.includes("pre_approval_request"));
    assert.ok(!hooks.includes("post_approval_response"));
  });

  it("maps verified Hermes session boundary hooks to Clawd lifecycle events", () => {
    const source = readPluginSource();
    assert.match(source, /"on_session_finalize": \("sleeping", "SessionEnd"\)/);
    assert.match(source, /"on_session_reset": \("idle", "SessionStart"\)/);
    assert.match(source, /def _finish_session_boundary/);
  });
});
