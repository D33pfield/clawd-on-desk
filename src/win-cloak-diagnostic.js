"use strict";

// ── 临时诊断模块（#525 DWM cloak）──────────────────────────────────────
// 只读探测 render/hit 窗口的 DWMWA_CLOAKED flag，并对 APP-cloak 试一次
// DwmSetWindowAttribute(DWMWA_CLOAK=false) 验证 uncloak 原语。best-effort：
// 非 Windows / FFI 加载失败时返回 no-op，绝不影响正式逻辑。
// 日志写 userData/cloak-diagnostic.log。
//
//   ⚠ 用完即删：删本文件 + main.js 里 "临时诊断（#525）" 整块接入代码。
//
// 验证目标（对应 docs/plans/plan-issue-525-windows-cloak-recovery.md）：
//   §8.6 — 各场景的 cloak flag 是多少；CLOAK=false 能否解除 APP cloak。
//   §8.2 — 虚拟桌面切换时 flag 是否 = SHELL(2) 且与睡眠/锁屏的 flag 可区分。
//          若能区分，IsWindowOnCurrentVirtualDesktop 的 COM 复杂度可省。

const fs = require("fs");

const DWMWA_CLOAK = 13;     // set：让本进程 cloak/uncloak 自己的窗口
const DWMWA_CLOAKED = 14;   // get：读 cloak 状态（0 / APP=1 / SHELL=2 / INHERITED=4）
const POLL_MS = 2000;
const HEARTBEAT_EVERY = 15; // 每 ~30s 打一次心跳，即使 flag 没变（确认诊断在跑 + 稳态值）

function createCloakDiagnostic(options = {}) {
  const isWin = options.isWin != null ? !!options.isWin : process.platform === "win32";
  const getWindows = typeof options.getWindows === "function" ? options.getWindows : () => [];
  const powerMonitor = options.powerMonitor || null;
  const logPath = options.logPath;
  const noop = { start() {}, stop() {} };
  if (!isWin || !logPath) return noop;

  function stamp() {
    return new Date().toISOString().replace("T", " ").replace("Z", "");
  }
  function log(line) {
    try { fs.appendFileSync(logPath, `${stamp()} [cloak-diag] ${line}\n`); } catch {}
  }

  let koffi;
  let dwmGet;
  let dwmSet;
  let ptrSize;
  try {
    koffi = require("koffi");
    const dwmapi = koffi.load("dwmapi.dll");
    dwmGet = dwmapi.func("int __stdcall DwmGetWindowAttribute(void *hwnd, uint dwAttribute, void *pvAttribute, uint cbAttribute)");
    dwmSet = dwmapi.func("int __stdcall DwmSetWindowAttribute(void *hwnd, uint dwAttribute, void *pvAttribute, uint cbAttribute)");
    ptrSize = koffi.sizeof("void *");
  } catch (err) {
    log(`init FAILED: ${err && err.message}`);
    return noop;
  }

  const lastFlag = new Map();
  let timer = null;
  let ticks = 0;

  function hwndOf(win) {
    try {
      const buf = win.getNativeWindowHandle();
      if (!buf || buf.length < ptrSize) return null;
      return koffi.decode(buf, "void *"); // §8.1 候选 A：buffer → 指针对象
    } catch {
      return null;
    }
  }

  function readCloaked(hwnd) {
    try {
      const out = Buffer.alloc(4);
      const hr = dwmGet(hwnd, DWMWA_CLOAKED, out, 4);
      return { hr, flag: hr === 0 ? out.readInt32LE(0) : null };
    } catch (err) {
      return { hr: `throw:${err && err.message}`, flag: null };
    }
  }

  function tryUncloak(hwnd) {
    try {
      const f = Buffer.alloc(4); // BOOL FALSE（全 0）
      return dwmSet(hwnd, DWMWA_CLOAK, f, 4);
    } catch (err) {
      return `throw:${err && err.message}`;
    }
  }

  function tick() {
    ticks += 1;
    const heartbeat = ticks % HEARTBEAT_EVERY === 0;
    for (const entry of getWindows()) {
      const name = entry && entry.name;
      const win = entry && entry.win;
      if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) continue;
      const hwnd = hwndOf(win);
      if (!hwnd) { if (heartbeat) log(`${name}: no hwnd`); continue; }
      const { hr, flag } = readCloaked(hwnd);
      const visible = typeof win.isVisible === "function" ? win.isVisible() : "?";
      const prev = lastFlag.get(name);
      if (flag !== prev) {
        log(`${name}: flag ${prev} -> ${flag} (hr=${hr}, isVisible=${visible})`);
        lastFlag.set(name, flag);
        // 仅对 APP(1) 自动试 uncloak，避免干扰虚拟桌面(SHELL=2)的观察。
        if (flag === 1) {
          const setHr = tryUncloak(hwnd);
          const after = readCloaked(hwnd);
          log(`${name}: APP uncloak -> setHr=${setHr}, flag now=${after.flag} (hr=${after.hr})`);
        }
      } else if (heartbeat) {
        log(`${name}: heartbeat flag=${flag} (hr=${hr}, isVisible=${visible})`);
      }
    }
  }

  return {
    start() {
      log(`=== start poll=${POLL_MS}ms ptrSize=${ptrSize} ===`);
      if (powerMonitor && typeof powerMonitor.on === "function") {
        for (const ev of ["suspend", "resume", "lock-screen", "unlock-screen"]) {
          powerMonitor.on(ev, () => { log(`*** powerMonitor:${ev} ***`); tick(); });
        }
      }
      timer = setInterval(tick, POLL_MS);
      tick();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      log("=== stop ===");
    },
  };
}

module.exports = { createCloakDiagnostic };
