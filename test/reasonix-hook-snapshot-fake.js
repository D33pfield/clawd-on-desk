// Test preloader: replaces the resolver's full-machine WMI process snapshot
// with a three-process tree — this hook's real parent pid, parented under
// reasonix.exe (pid 4000), parented under explorer.exe (pid 5000, a system
// boundary). Lets PID-attribution tests assert stablePid/agentPid without
// spawning PowerShell or depending on the host's real process list. Any
// execFileSync call that is NOT the snapshot passes through to the real one.
const childProcess = require("child_process");

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

childProcess.execFileSync = function (file, args) {
  const text = [file, ...(Array.isArray(args) ? args : [])].join(" ");
  if (/powershell(\.exe)?/i.test(String(file)) && text.includes("Win32_Process")) {
    return JSON.stringify(SNAPSHOT);
  }
  return realExecFileSync.apply(this, arguments);
};
