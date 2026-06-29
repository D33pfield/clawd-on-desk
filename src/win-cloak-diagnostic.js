"use strict";

// ── 临时诊断模块（#525 宠物消失根因）────────────────────────────────────
// 采集 render/hit 窗口的完整可见性快照：DWMWA_CLOAKED flag + HRESULT、
// isVisible、bounds、isAlwaysOnTop，外加 display 快照。在 flag 变化、电源
// 事件(suspend/resume/lock/unlock)、显示器变化时各 dump 一次完整快照；并对
// APP-cloak(flag=1) 试一次 DwmSetWindowAttribute(DWMWA_CLOAK=false) 验证
// uncloak 原语是否有效。best-effort：非 Windows / FFI 失败时 no-op，绝不
// 影响正式逻辑。日志写 userData/cloak-diagnostic.log。
//
//   ⚠ 用完即删：删本文件 + main.js 里 "临时诊断（#525）" 整块接入代码。
//
// 判读（宠物消失瞬间看日志）：
//   • flag 非 0 → 确实 DWM cloak；看值 APP=1 / SHELL=2 / INHERITED=4。
//   • flag = 0  → 不是 cloak；看 bounds（被挪出屏幕?）、isVisible、aot、
//                 display 快照（拓扑/DPI 变化?）定位真因。

const fs = require("fs");

const DWMWA_CLOAK = 13;     // set：让本进程 cloak/uncloak 自己的窗口
const DWMWA_CLOAKED = 14;   // get：读 cloak 状态(0 / APP=1 / SHELL=2 / INHERITED=4)
const POLL_MS = 2000;
const HEARTBEAT_EVERY = 15; // 每 ~30s 打一次单行心跳，即使 flag 没变

function createCloakDiagnostic(options = {}) {
  const isWin = options.isWin != null ? !!options.isWin : process.platform === "win32";
  const getWindows = typeof options.getWindows === "function" ? options.getWindows : () => [];
  const powerMonitor = options.powerMonitor || null;
  const screen = options.screen || null;
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
      return koffi.decode(buf, "void *");
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

  // 单窗口完整状态：cloak flag/hr + isVisible + alwaysOnTop + bounds
  function winSnapshot(name, win) {
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) {
      return `${name}: <destroyed/null>`;
    }
    const hwnd = hwndOf(win);
    if (!hwnd) return `${name}: no hwnd`;
    const { hr, flag } = readCloaked(hwnd);
    const vis = typeof win.isVisible === "function" ? win.isVisible() : "?";
    const aot = typeof win.isAlwaysOnTop === "function" ? win.isAlwaysOnTop() : "?";
    let b = "?";
    try {
      const r = win.getBounds();
      b = `${r.x},${r.y} ${r.width}x${r.height}`;
    } catch {}
    return `${name}: flag=${flag} hr=${hr} visible=${vis} aot=${aot} bounds=[${b}]`;
  }

  function displaySnapshot() {
    if (!screen || typeof screen.getAllDisplays !== "function") return "";
    try {
      const ds = screen.getAllDisplays().map((d) => {
        const b = d.bounds || {};
        const w = d.workArea || {};
        return `#${d.id}{b:${b.x},${b.y} ${b.width}x${b.height} wa:${w.x},${w.y} ${w.width}x${w.height} sf:${d.scaleFactor}}`;
      });
      return `displays=${ds.join(" ")}`;
    } catch (err) {
      return `displays:err ${err && err.message}`;
    }
  }

  // flag 变化 / 电源 / 显示器事件时 dump 两窗口 + display 完整快照
  function dumpFull(reason) {
    log(`--- snapshot (${reason}) ---`);
    for (const entry of getWindows()) {
      log(`  ${winSnapshot(entry && entry.name, entry && entry.win)}`);
    }
    const ds = displaySnapshot();
    if (ds) log(`  ${ds}`);
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
      const { flag } = readCloaked(hwnd);
      const prev = lastFlag.get(name);
      if (flag !== prev) {
        lastFlag.set(name, flag);
        dumpFull(`${name} flag ${prev} -> ${flag}`);
        // 仅对 APP(1) 试 uncloak：验证 DwmSetWindowAttribute(CLOAK=false) 原语
        if (flag === 1) {
          const setHr = tryUncloak(hwnd);
          const after = readCloaked(hwnd);
          log(`  ${name}: APP uncloak -> setHr=${setHr}, flag now=${after.flag} (hr=${after.hr})`);
        }
      } else if (heartbeat) {
        log(winSnapshot(name, win));
      }
    }
  }

  return {
    start() {
      log(`=== start poll=${POLL_MS}ms ptrSize=${ptrSize} ===`);
      dumpFull("startup");
      if (powerMonitor && typeof powerMonitor.on === "function") {
        for (const ev of ["suspend", "resume", "lock-screen", "unlock-screen"]) {
          powerMonitor.on(ev, () => { log(`*** powerMonitor:${ev} ***`); dumpFull(`power:${ev}`); });
        }
      }
      if (screen && typeof screen.on === "function") {
        for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) {
          screen.on(ev, () => { log(`*** screen:${ev} ***`); dumpFull(`screen:${ev}`); });
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
