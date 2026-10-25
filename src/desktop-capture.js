"use strict";

// The only file that touches the screen. Windows only. Takes one capture for
// desktop awareness (src/desktop-awareness.js): the foreground window, or whole
// monitors, as small in-memory JPEGs. Nothing is written to disk. It refuses
// instead of widening: no foreground window, the app's own window, a minimized
// window or the desktop itself all mean "no capture", never "capture the screen".
//
// Electron's desktopCapturer renders every display it is asked for (its API has
// no way to ask for one), so the other displays are produced in memory for an
// instant and dropped unused. The choosing and cropping maths are pure functions
// (exported, tested); the rest takes injected Electron and koffi so it can be
// tested with fakes.

const MAX_EDGE = 1024; // longest side of what the vision model gets (about 600 tokens)
const JPEG_QUALITY = 70;

// ── Pure helpers ──

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// The display holding most of a rectangle (DIP coordinates), or null when it is on none.
function displayHolding(displays, rect) {
  let best = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = overlapArea(display.bounds, rect);
    if (area > bestArea) { best = display; bestArea = area; }
  }
  return best;
}

// Which displays a whole-screen capture covers. `petCenter` is a DIP point.
function pickDisplays(displays, monitor, { primaryId, petCenter } = {}) {
  if (!Array.isArray(displays) || displays.length === 0) return [];
  if (monitor === "all") return displays;
  if (monitor === "primary") {
    const primary = displays.find((display) => display.id === primaryId) || displays[0];
    return [primary];
  }
  if (petCenter) {
    const containing = displays.find((d) => (
      petCenter.x >= d.bounds.x && petCenter.x < d.bounds.x + d.bounds.width
      && petCenter.y >= d.bounds.y && petCenter.y < d.bounds.y + d.bounds.height
    ));
    if (containing) return [containing];
  }
  const primary = displays.find((display) => display.id === primaryId) || displays[0];
  return [primary];
}

// Crop rectangle in the pixels of one display's capture, for a window rectangle in
// DIP. `captureSize` is the size of the capture actually obtained (it may be a
// little smaller than the display's pixel size). Returns null for an empty result.
function cropForWindow(display, windowDip, captureSize) {
  const b = display.bounds;
  const left = Math.max(windowDip.x, b.x);
  const top = Math.max(windowDip.y, b.y);
  const right = Math.min(windowDip.x + windowDip.width, b.x + b.width);
  const bottom = Math.min(windowDip.y + windowDip.height, b.y + b.height);
  if (right <= left || bottom <= top) return null;
  const sx = captureSize.width / b.width;
  const sy = captureSize.height / b.height;
  const crop = {
    x: Math.round((left - b.x) * sx),
    y: Math.round((top - b.y) * sy),
    width: Math.round((right - left) * sx),
    height: Math.round((bottom - top) * sy),
  };
  return crop.width >= 2 && crop.height >= 2 ? crop : null;
}

// Size that fits the longest edge into `max`, never enlarging.
function fitSize(width, height, max = MAX_EDGE) {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const k = max / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

// ── Windows foreground window (koffi) ──

function createForegroundReader(options = {}) {
  const koffi = options.koffi || require("koffi");
  const user32 = koffi.load("user32.dll");
  const dwmapi = koffi.load("dwmapi.dll");
  const GetForegroundWindow = user32.func("void *GetForegroundWindow()");
  const IsIconic = user32.func("bool IsIconic(void *hwnd)");
  const IsWindowVisible = user32.func("bool IsWindowVisible(void *hwnd)");
  const GetWindowRect = user32.func("bool GetWindowRect(void *hwnd, _Out_ int32_t *rect)");
  const GetWindowThreadProcessId = user32.func("uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)");
  const GetWindowTextW = user32.func("int GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int max)");
  const DwmGetWindowAttribute = dwmapi.func("int DwmGetWindowAttribute(void *hwnd, uint32 attr, _Out_ int32_t *value, uint32 size)");
  const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

  // { ok, rect (physical pixels), pid, title } or { ok: false, reason }.
  return function readForeground() {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return { ok: false, reason: "no-foreground-window" };
    if (IsIconic(hwnd)) return { ok: false, reason: "foreground-minimized" };
    if (!IsWindowVisible(hwnd)) return { ok: false, reason: "foreground-not-visible" };
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    const text = new Uint16Array(256);
    const length = GetWindowTextW(hwnd, text, 256);
    const title = length > 0 ? String.fromCharCode(...text.slice(0, length)) : "";
    // The frame without the invisible resize border; GetWindowRect as a fallback.
    const frame = [0, 0, 0, 0];
    let rect = null;
    if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, frame, 16) === 0) {
      rect = { left: frame[0], top: frame[1], right: frame[2], bottom: frame[3] };
    } else {
      const raw = [0, 0, 0, 0];
      if (GetWindowRect(hwnd, raw)) rect = { left: raw[0], top: raw[1], right: raw[2], bottom: raw[3] };
    }
    if (!rect || rect.right <= rect.left || rect.bottom <= rect.top) return { ok: false, reason: "foreground-empty-rect" };
    return { ok: true, rect, pid: pid[0], title };
  };
}

// ── The capturer ──

function createDesktopCapturer(options = {}) {
  const electron = options.electron || require("electron");
  const { desktopCapturer, screen } = electron;
  const platform = options.platform || process.platform;
  const ownPid = options.ownPid || process.pid;
  const readForeground = options.readForeground || (platform === "win32" ? createForegroundReader() : null);
  // The pet window's centre in DIP, to choose "the monitor the pet is on".
  const getPetCenter = options.getPetCenter || (() => null);

  function encode(image, crop) {
    let work = image;
    if (crop) work = work.crop(crop);
    const size = work.getSize();
    const fit = fitSize(size.width, size.height);
    if (fit.width !== size.width || fit.height !== size.height) work = work.resize({ width: fit.width, height: fit.height, quality: "good" });
    return work.toJPEG(JPEG_QUALITY);
  }

  async function sourcesFor(displays, thumbnailSize) {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
    return displays.map((display) => ({
      display,
      source: sources.find((candidate) => String(candidate.display_id) === String(display.id)),
    }));
  }

  // scope "window": the foreground window only. scope "screen": whole monitors.
  async function capture({ scope, monitor } = {}) {
    if (platform !== "win32" || !readForeground) return { ok: false, reason: "unsupported-platform" };
    try {
      const displays = screen.getAllDisplays();
      if (scope === "window") {
        const fg = readForeground();
        if (!fg.ok) return { ok: false, reason: fg.reason };
        if (fg.pid === ownPid) return { ok: false, reason: "foreground-is-own-window" };
        if (fg.title === "Program Manager") return { ok: false, reason: "foreground-is-desktop" };
        const windowDip = screen.screenToDipRect(null, {
          x: fg.rect.left, y: fg.rect.top, width: fg.rect.right - fg.rect.left, height: fg.rect.bottom - fg.rect.top,
        });
        const display = displayHolding(displays, windowDip);
        if (!display) return { ok: false, reason: "window-off-screen" };
        const full = { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) };
        const [entry] = await sourcesFor([display], full);
        if (!entry.source || entry.source.thumbnail.isEmpty()) return { ok: false, reason: "capture-empty" };
        const crop = cropForWindow(display, windowDip, entry.source.thumbnail.getSize());
        if (!crop) return { ok: false, reason: "window-off-screen" };
        return { ok: true, images: [{ buffer: encode(entry.source.thumbnail, crop), displayId: display.id }] };
      }
      const chosen = pickDisplays(displays, monitor, { primaryId: screen.getPrimaryDisplay().id, petCenter: getPetCenter() });
      if (chosen.length === 0) return { ok: false, reason: "no-display" };
      const entries = await sourcesFor(chosen, { width: MAX_EDGE, height: MAX_EDGE });
      const images = [];
      for (const { display, source } of entries) {
        if (!source || source.thumbnail.isEmpty()) continue;
        images.push({ buffer: encode(source.thumbnail, null), displayId: display.id });
      }
      return images.length > 0 ? { ok: true, images } : { ok: false, reason: "capture-empty" };
    } catch (err) {
      return { ok: false, reason: `capture-error:${err && err.message}` };
    }
  }

  return { capture };
}

module.exports = { MAX_EDGE, overlapArea, displayHolding, pickDisplays, cropForWindow, fitSize, createForegroundReader, createDesktopCapturer };
