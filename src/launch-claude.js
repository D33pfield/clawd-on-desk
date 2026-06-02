"use strict";

const { spawn, execFileSync } = require("child_process");
const { platform, homedir } = require("os");
const path = require("path");
const fs = require("fs");

function tryLaunch(bin, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, opts);
    } catch (err) {
      resolve({ ok: false, error: err });
      return;
    }
    let resolved = false;
    const onSpawn = () => {
      if (resolved) return;
      resolved = true;
      child.removeListener("error", onError);
      child.on("error", () => {});
      try { child.unref(); } catch {}
      resolve({ ok: true, child });
    };
    const onError = (err) => {
      if (resolved) return;
      resolved = true;
      child.removeListener("spawn", onSpawn);
      resolve({ ok: false, error: err });
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function findClaudeCmd() {
  const plat = platform();

  // 1. Try system PATH lookup
  try {
    const cmd = plat === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["claude"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const lines = out.trim().split(/\r?\n/);
    for (const line of lines) {
      const p = line.trim();
      if (p && fs.existsSync(p)) return p;
    }
  } catch {}

  // 2. Check common npm global install locations
  const candidates = [];
  if (plat === "win32") {
    candidates.push(
      path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
      path.join(process.env.APPDATA || "", "npm", "claude"),
      path.join(process.env.LOCALAPPDATA || "", "npm", "claude.cmd"),
    );
  } else {
    candidates.push(
      path.join(homedir(), ".npm-global", "bin", "claude"),
      "/usr/local/bin/claude",
      path.join(homedir(), ".local", "bin", "claude"),
    );
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // 3. Fallback: return "claude" and let the shell resolve it
  return "claude";
}

function buildClaudeArgs(mode, sessionId) {
  const args = [];
  if (mode === "dangerous" || mode === "resume-dangerous") args.push("--dangerously-skip-permissions");
  if (mode === "continue") args.push("-c");
  if ((mode === "resume" || mode === "resume-dangerous") && sessionId) args.push("--resume", sessionId);
  return args;
}

function buildTerminalCandidates(claudePath, claudeArgs) {
  const plat = platform();
  const cmd = claudeArgs.length > 0
    ? `"${claudePath}" ${claudeArgs.join(" ")}`
    : `"${claudePath}"`;

  if (plat === "win32") {
    return [
      { bin: "wt.exe", args: ["--", claudePath, ...claudeArgs] },
      {
        bin: "cmd.exe",
        args: ["/d", "/v:off", "/s", "/k", [claudePath, ...claudeArgs].join(" ")],
        extraOpts: { shell: false, windowsVerbatimArguments: true },
      },
      {
        bin: "powershell.exe",
        args: ["-NoExit", "-Command", `& "${claudePath}" ${claudeArgs.join(" ")}`],
      },
    ];
  }

  if (plat === "darwin") {
    const escapedArgs = claudeArgs.map((a) => `'${a}'`).join(" ");
    const macCmd = `"${claudePath}" ${escapedArgs}`.trim();
    const appleScript = `tell application "Terminal" to do script "${macCmd.replace(/"/g, '\\"')}"`;
    return [{ bin: "osascript", args: ["-e", appleScript] }];
  }

  // Linux
  return [
    { bin: "x-terminal-emulator", args: ["-e", "bash", "-c", `${cmd}; exec bash`] },
    { bin: "xterm", args: ["-e", "bash", "-c", `${cmd}; exec bash`] },
    { bin: "gnome-terminal", args: ["--", "bash", "-c", `${cmd}; exec bash`] },
    { bin: "konsole", args: ["-e", "bash", "-c", `${cmd}; exec bash`] },
    { bin: "alacritty", args: ["-e", "bash", "-c", `${cmd}; exec bash`] },
    { bin: "kitty", args: ["--", "bash", "-c", `${cmd}; exec bash`] },
  ];
}

async function launchClaudeSession(mode, cwd, sessionId) {
  const claudePath = findClaudeCmd();
  const claudeArgs = buildClaudeArgs(mode, sessionId);
  const workDir = cwd || homedir();
  const opts = { detached: true, stdio: "ignore", windowsHide: false, cwd: workDir };

  const candidates = buildTerminalCandidates(claudePath, claudeArgs);
  for (const candidate of candidates) {
    const result = await tryLaunch(candidate.bin, candidate.args, {
      ...opts,
      ...(candidate.extraOpts || {}),
    });
    if (result.ok) return { ok: true, terminal: candidate.bin };
  }

  return { ok: false, message: "could not spawn terminal" };
}

module.exports = { launchClaudeSession };
