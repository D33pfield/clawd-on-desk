const assert = require("assert");
const { spawnSync } = require("child_process");
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

function runPluginPython(code) {
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(pythonCmd, ["-"], {
    cwd: path.join(__dirname, ".."),
    input: code,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.strictEqual(
    result.status,
    0,
    `${pythonCmd} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result.stdout.trim();
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

  it("clears stale tool mappings on reset and drops orphan post-tool events", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

posts = []
def fake_post_state(payload):
    posts.append(dict(payload))
def fake_append_log(*args, **kwargs):
    return None

mod._post_state = fake_post_state
mod._append_log = fake_append_log
mod._active_session_id = ""
mod._task_session_ids.clear()

mod._handle_hook("pre_llm_call", session_id="old-session")
mod._handle_hook("pre_tool_call", task_id="old-task", tool_name="terminal")
assert posts[-1]["session_id"] == "old-session"
assert "old-task" in mod._task_session_ids

mod._handle_hook("on_session_reset", session_id="new-session")
assert posts[-1]["event"] == "SessionStart"
assert posts[-1]["session_id"] == "new-session"
assert mod._active_session_id == "new-session"
assert mod._task_session_ids == {}

count = len(posts)
mod._handle_hook("post_tool_call", task_id="old-task", tool_name="terminal", result='{"exit_code": 0}')
assert len(posts) == count

mod._handle_hook("on_session_finalize", session_id="new-session")
assert posts[-1]["event"] == "SessionEnd"
assert mod._active_session_id == ""

print(json.dumps([{"event": item["event"], "session_id": item["session_id"]} for item in posts]))
`);
    const events = JSON.parse(output);
    assert.deepStrictEqual(events, [
      { event: "UserPromptSubmit", session_id: "old-session" },
      { event: "PreToolUse", session_id: "old-session" },
      { event: "SessionStart", session_id: "new-session" },
      { event: "SessionEnd", session_id: "new-session" },
    ]);
  });

  it("resolves Hermes process metadata without guessing wrapper-only chains", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod._platform_key = lambda: "win32"
cases = {}

def run_case(tree, start):
    def fake_query(pid):
        row = tree.get(pid)
        if not row:
            return None
        name, parent = row
        return {"pid": pid, "parent_pid": parent, "name": name, "path": "", "cmdline": ""}
    mod._query_process_info = fake_query
    return mod._resolve_process_metadata(start)

cases["terminal"] = run_case({
    10: ("python.exe", 20),
    20: ("uv.exe", 30),
    30: ("hermes.exe", 40),
    40: ("pwsh.exe", 50),
    50: ("WindowsTerminal.exe", 60),
    60: ("explorer.exe", 4),
}, 10)

cases["editor"] = run_case({
    10: ("python.exe", 20),
    20: ("hermes.exe", 30),
    30: ("pwsh.exe", 40),
    40: ("Cursor.exe", 50),
    50: ("explorer.exe", 4),
}, 10)

cases["wrapper_only"] = run_case({
    10: ("python.exe", 20),
    20: ("uv.exe", 30),
    30: ("hermes.exe", 40),
    40: ("explorer.exe", 4),
}, 10)

cases["failure"] = run_case({}, 10)

print(json.dumps(cases, sort_keys=True))
`);
    const cases = JSON.parse(output);
    assert.strictEqual(cases.terminal.source_pid, 50);
    assert.deepStrictEqual(cases.terminal.pid_chain, [10, 20, 30, 40, 50, 60]);
    assert.strictEqual(cases.editor.source_pid, 40);
    assert.strictEqual(cases.editor.editor, "cursor");
    assert.deepStrictEqual(cases.editor.pid_chain, [10, 20, 30, 40, 50]);
    assert.strictEqual(cases.wrapper_only.source_pid, undefined);
    assert.deepStrictEqual(cases.wrapper_only.pid_chain, [10, 20, 30, 40]);
    assert.deepStrictEqual(cases.failure, {});
  });

  it("attaches cached Hermes process metadata to state payloads without hot-path lookups", () => {
    const output = runPluginPython(String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermes_plugin", r"hooks/hermes-plugin/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod._platform_key = lambda: "win32"
tree = {
    10: ("python.exe", 20),
    20: ("hermes.exe", 30),
    30: ("pwsh.exe", 40),
    40: ("Code.exe", 50),
    50: ("explorer.exe", 4),
}
calls = []
def fake_query(pid):
    calls.append(pid)
    row = tree.get(pid)
    if not row:
        return None
    name, parent = row
    return {"pid": pid, "parent_pid": parent, "name": name, "path": "", "cmdline": ""}

posts = []
mod._query_process_info = fake_query
mod._append_log = lambda *args, **kwargs: None
mod._post_state = lambda payload: posts.append(dict(payload))
mod.os.getpid = lambda: 10

mod._resolve_process_meta_background()
resolved_calls = list(calls)

mod._handle_hook("pre_llm_call", session_id="cached-session")
mod._handle_hook("post_llm_call", session_id="cached-session")

print(json.dumps({
    "resolved_calls": resolved_calls,
    "all_calls": calls,
    "posts": [{
        "event": item["event"],
        "source_pid": item.get("source_pid"),
        "pid_chain": item.get("pid_chain"),
        "editor": item.get("editor"),
        "agent_pid": item.get("agent_pid"),
    } for item in posts],
}, sort_keys=True))
`);
    const result = JSON.parse(output);
    assert.deepStrictEqual(result.resolved_calls, [10, 20, 30, 40, 50]);
    assert.deepStrictEqual(result.all_calls, result.resolved_calls);
    assert.deepStrictEqual(result.posts, [
      {
        event: "UserPromptSubmit",
        source_pid: 40,
        pid_chain: [10, 20, 30, 40, 50],
        editor: "code",
        agent_pid: 10,
      },
      {
        event: "Stop",
        source_pid: 40,
        pid_chain: [10, 20, 30, 40, 50],
        editor: "code",
        agent_pid: 10,
      },
    ]);
  });
});
