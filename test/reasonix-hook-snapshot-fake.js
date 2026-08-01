// Test preloader: replaces the resolver's full-machine WMI process snapshot
// with a three-process tree — this hook's real parent pid, parented under
// reasonix.exe (pid 4000), parented under explorer.exe (pid 5000, a system
// boundary). Lets PID-attribution tests assert stablePid/agentPid without
// spawning PowerShell or depending on the host's real process list. Any
// execFileSync call that is NOT the snapshot passes through to the real one.
const childProcess = require("child_process");
const fs = require("fs");

const realExecFileSync = childProcess.execFileSync;
const hookParentPid = process.ppid;

const SNAPSHOT = {
  processes: [
    {
      ProcessId: hookParentPid,
      ParentProcessId: 4000,
      Name: "node.exe",
      CommandLine: "node hooks/reasonix-hook.js",
      StartIdentity: "100",
    },
    {
      ProcessId: 4000,
      ParentProcessId: 5000,
      Name: "reasonix.exe",
      CommandLine: "reasonix.exe",
      StartIdentity: "90",
    },
    {
      ProcessId: 5000,
      ParentProcessId: 0,
      Name: "explorer.exe",
      CommandLine: "explorer.exe",
      StartIdentity: "1",
    },
  ],
  foreground: { hwnd: null, pid: 0, className: "" },
};

childProcess.execFileSync = function (file, args, options) {
  const text = [file, ...(Array.isArray(args) ? args : [])].join(" ");
  if (/powershell(\.exe)?/i.test(String(file)) && text.includes("Win32_Process")) {
    const recordPath = process.env.CLAWD_TEST_REASONIX_SNAPSHOT_RECORD;
    if (recordPath) {
      try {
        fs.appendFileSync(recordPath, JSON.stringify({
          timeout: options && options.timeout,
          at: Date.now(),
        }) + "\n");
      } catch {}
    }
    const delayMs = Number(process.env.CLAWD_TEST_REASONIX_SNAPSHOT_DELAY_MS) || 0;
    if (delayMs > 0) {
      // Deliberately synchronous: this reproduces the exact property under
      // review — JS safety timers cannot run while execFileSync/WMI is blocked.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
    return JSON.stringify(SNAPSHOT);
  }
  return realExecFileSync.apply(this, arguments);
};
