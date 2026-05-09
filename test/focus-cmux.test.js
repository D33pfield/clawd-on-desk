// test/focus-cmux.test.js — Tests for cmux workspace switching
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { loadFocusWithMock } = require("./helpers/load-focus-with-mock");

function writeMockSessionFile(workspaces, bundleId = "com.cmuxterm.app") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-test-"));
  const cmuxDir = path.join(tmpDir, "Library/Application Support/cmux");
  fs.mkdirSync(cmuxDir, { recursive: true });
  const sessionPath = path.join(cmuxDir, `session-${bundleId}.json`);
  const sessionData = {
    windows: [{
      tabManager: { selectedWorkspaceIndex: 0, workspaces }
    }]
  };
  fs.writeFileSync(sessionPath, JSON.stringify(sessionData));
  return { tmpDir, sessionPath, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function mockExecFileForCmux(opts = {}) {
  const { ttyOutput, commOutput, osascriptSucceeds = true } = opts;
  const calls = [];
  const mock = function (cmd, args, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    calls.push({ cmd, args: [...args] });
    if (cmd === "osascript") {
      if (osascriptSucceeds) { if (cb) cb(null, "", ""); }
      else { if (cb) cb(new Error("osascript failed"), "", ""); }
      return;
    }
    if (cmd === "ps") {
      const a = args.join(" ");
      if (a.includes("comm=")) {
        if (cb) cb(null, commOutput || "501 /bin/zsh\n502 /Applications/cmux.app/Contents/MacOS/cmux\n", "");
        return;
      }
      if (a.includes("tty=")) {
        if (cb) cb(null, ttyOutput || "501 ttys007\n", "");
        return;
      }
    }
    if (cb) cb(null, "", "");
  };
  return { calls, mock };
}

describe("cmux workspace switching (macOS)", () => {

  it("should match TTY to workspace and focus via AppleScript", (t, done) => {
    const { tmpDir, cleanup: cleanupFile } = writeMockSessionFile([
      { panels: [{ ttyName: "ttys001" }] },
      { panels: [{ ttyName: "ttys007" }] },
    ]);
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    const { calls, mock } = mockExecFileForCmux();
    const { initFocus, cleanup } = loadFocusWithMock(mock);

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, [501, 502]);

    setTimeout(() => {
      cleanup();
      cleanupFile();
      process.env.HOME = origHome;

      // Should call osascript twice: once for legacy focus, once for cmux tab focus
      const osaCalls = calls.filter(c => c.cmd === "osascript");
      assert.ok(osaCalls.length >= 2, `Expected >= 2 osascript calls, got ${osaCalls.length}`);

      // The cmux AppleScript should reference tab 2 (0-based index 1 + 1)
      const cmuxOsa = osaCalls.find(c => c.args.some(a => a.includes("cmux") && a.includes("tab 2")));
      assert.ok(cmuxOsa, "Should run AppleScript to focus cmux tab 2");

      done();
    }, 2500);
  });

  it("should NOT call cmux when no cmux process found in pidChain", (t, done) => {
    const { calls, mock } = mockExecFileForCmux({
      commOutput: "100 /bin/zsh\n200 /Applications/Terminal.app/Contents/MacOS/Terminal\n",
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock);

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(100, "/test/cwd", null, [100, 200]);

    setTimeout(() => {
      cleanup();

      const osaCalls = calls.filter(c => c.cmd === "osascript");
      const cmuxOsa = osaCalls.find(c => c.args.some(a => a.includes("cmux")));
      assert.ok(!cmuxOsa, "Should NOT run cmux AppleScript when no cmux process found");

      done();
    }, 2000);
  });

  it("should not focus cmux tab when TTY not found in session file", (t, done) => {
    const { tmpDir, cleanup: cleanupFile } = writeMockSessionFile([
      { panels: [{ ttyName: "ttys001" }] },
    ]);
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    const { calls, mock } = mockExecFileForCmux({ ttyOutput: "501 ttys099\n" });
    const { initFocus, cleanup } = loadFocusWithMock(mock);

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, [501, 502]);

    setTimeout(() => {
      cleanup();
      cleanupFile();
      process.env.HOME = origHome;

      const osaCalls = calls.filter(c => c.cmd === "osascript");
      const cmuxOsa = osaCalls.find(c => c.args.some(a => a.includes("cmux")));
      assert.ok(!cmuxOsa, "Should NOT run cmux AppleScript when TTY not matched");

      done();
    }, 2000);
  });

  it("should handle AppleScript errors gracefully", (t, done) => {
    const { tmpDir, cleanup: cleanupFile } = writeMockSessionFile([
      { panels: [{ ttyName: "ttys007" }] },
    ]);
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    const { calls, mock } = mockExecFileForCmux({ osascriptSucceeds: false });
    const { initFocus, cleanup } = loadFocusWithMock(mock);

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, [501, 502]);

    setTimeout(() => {
      cleanup();
      cleanupFile();
      process.env.HOME = origHome;

      const osaCalls = calls.filter(c => c.cmd === "osascript");
      const cmuxOsa = osaCalls.find(c => c.args.some(a => a.includes("cmux")));
      assert.ok(cmuxOsa, "Should attempt cmux AppleScript");

      done();
    }, 2500);
  });

  it("should skip cmux detection on non-macOS platforms", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function (cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cb) cb(null, "", "");
    }, { platform: "linux" });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, [501, 502]);

    setTimeout(() => {
      cleanup();

      const psCommCalls = calls.filter(c => c.cmd === "ps" && c.args.join(" ").includes("comm="));
      assert.strictEqual(psCommCalls.length, 0, "Should not call ps -o comm= on non-macOS");

      done();
    }, 1000);
  });

  it("should skip cmux detection when pidChain is empty", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function (cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, []);

    setTimeout(() => {
      cleanup();

      const psCommCalls = calls.filter(c => c.cmd === "ps" && c.args.join(" ").includes("comm="));
      assert.strictEqual(psCommCalls.length, 0, "Should not attempt cmux detection with empty pidChain");

      done();
    }, 1000);
  });
});
