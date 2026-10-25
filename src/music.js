"use strict";

// Is Spotify playing? Spotify's own window title says so: "Artist - Song" while
// something plays, "Spotify Premium" (or "Free") when it does not, and the title
// keeps updating while the window is minimized. The titles are read in-process
// through koffi, the FFI the app already ships for Windows calls, so there is no
// helper program and no process launch: one enumeration of the top-level windows
// takes milliseconds. The detector checks every second and a half, debounces so a
// skipped track or a brief pause does not flicker, and reports changes through
// onChange(playing). Any failure counts as "not playing".
//
// The FFI is the thin readSpotifyTitles() below; the rules are pure functions
// (parseSpotifyTitles) and the reader is injectable, so tests run anywhere.

const DEFAULT_CONFIG = Object.freeze({
  intervalMs: 1500,
  // Consecutive checks needed to flip state. Start fast, stop a little slower.
  startPolls: 1,
  stopPolls: 2,
  // Cached pid -> "is Spotify" answers are forgotten after this long, so a reused pid cannot mislead.
  pidCacheMs: 60 * 1000,
});

// Spotify's idle title starts with "Spotify"; a playing track is "Artist - Song".
// An advertisement is audio too, but has no song.
function parseSpotifyTitles(titles) {
  if (!Array.isArray(titles)) return { playing: false, song: null };
  for (const raw of titles) {
    const title = typeof raw === "string" ? raw.trim() : "";
    if (!title || /^spotify\b/i.test(title)) continue;
    if (/^advertisement$/i.test(title)) return { playing: true, song: null };
    if (title.includes(" - ")) return { playing: true, song: title };
  }
  return { playing: false, song: null };
}

// Windows only. Returns { read(), close() }, or throws if koffi/user32 is unavailable.
// The window-enumeration callback is registered once and reused for every read
// (a new one per read would leak native callback slots), and released by close().
function createSpotifyTitleReader(options = {}) {
  const koffi = options.koffi || require("koffi");
  const now = options.now || Date.now;
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const EnumProc = koffi.proto("bool ClawdEnumWindowsProc(void *hwnd, intptr_t lparam)");
  const EnumWindows = user32.func("bool EnumWindows(ClawdEnumWindowsProc *cb, intptr_t lparam)");
  const GetWindowTextW = user32.func("int GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int max)");
  const GetWindowThreadProcessId = user32.func("uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)");
  const OpenProcess = kernel32.func("void *OpenProcess(uint32 access, bool inherit, uint32 pid)");
  const QueryFullProcessImageNameW = kernel32.func(
    "bool QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ uint16_t *buf, _Inout_ uint32 *size)"
  );
  const CloseHandle = kernel32.func("bool CloseHandle(void *h)");
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const decode = (units, length) => String.fromCharCode(...units.slice(0, length));

  const spotifyPids = new Map(); // pid -> boolean, so each process is looked up once
  let cacheStartedAt = now();
  let titles = [];

  function isSpotifyProcess(pid) {
    if (spotifyPids.has(pid)) return spotifyPids.get(pid);
    let spotify = false;
    const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle) {
      const buffer = new Uint16Array(520);
      const size = [520];
      if (QueryFullProcessImageNameW(handle, 0, buffer, size)) {
        spotify = /\\spotify\.exe$/i.test(decode(buffer, size[0]));
      }
      CloseHandle(handle);
    }
    spotifyPids.set(pid, spotify);
    return spotify;
  }

  let callback = koffi.register((hwnd) => {
    // Read the text first: most windows have none, and those cost nothing more.
    const text = new Uint16Array(512);
    const length = GetWindowTextW(hwnd, text, 512);
    if (!length) return true;
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (isSpotifyProcess(pid[0])) titles.push(decode(text, length));
    return true;
  }, koffi.pointer(EnumProc));

  return {
    read() {
      if (!callback) return [];
      if (now() - cacheStartedAt > DEFAULT_CONFIG.pidCacheMs) {
        spotifyPids.clear();
        cacheStartedAt = now();
      }
      titles = [];
      EnumWindows(callback, 0);
      return titles;
    },
    close() {
      if (callback) koffi.unregister(callback);
      callback = null;
      spotifyPids.clear();
    },
  };
}

function createMusicDetector(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const platform = options.platform || process.platform;
  const makeReader = options.makeReader || createSpotifyTitleReader;
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  const log = typeof options.log === "function" ? options.log : () => {};
  const timers = options.timers || { setTimeout, clearTimeout };

  let reader = options.reader || null; // injected for tests; otherwise created on start()
  let playing = false;
  let song = null;
  let streak = 0; // consecutive checks disagreeing with `playing`
  let timer = null;
  let running = false;
  let warnedUnavailable = false;
  let warnedReadFailure = false;

  function applyCheck(result) {
    // The song can change while still playing; keep it current without a state change.
    song = result.playing ? result.song : null;
    if (result.playing === playing) {
      streak = 0;
      return;
    }
    streak += 1;
    if (streak < (result.playing ? config.startPolls : config.stopPolls)) return;
    streak = 0;
    playing = result.playing;
    if (!playing) song = null;
    // The song title stays out of the log line; chatter logs what it was told.
    log(`music playing=${playing}`);
    onChange(playing);
  }

  function schedule() {
    if (!running) return;
    timer = timers.setTimeout(check, config.intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function check() {
    timer = null;
    if (!running) return;
    let result = { playing: false, song: null };
    try {
      result = parseSpotifyTitles(reader.read());
    } catch (err) {
      if (!warnedReadFailure) {
        warnedReadFailure = true;
        log(`music read failed: ${err && err.message}`);
      }
    }
    applyCheck(result);
    schedule();
  }

  return {
    start() {
      if (running || platform !== "win32") return;
      if (!reader) {
        try {
          reader = makeReader();
        } catch (err) {
          // No koffi or no user32: music detection is simply off.
          if (!warnedUnavailable) {
            warnedUnavailable = true;
            log(`music detector unavailable: ${err && err.message}`);
          }
          return;
        }
      }
      running = true;
      check();
    },
    stop() {
      running = false;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      if (reader && typeof reader.close === "function" && !options.reader) {
        try { reader.close(); } catch {}
        reader = null;
      }
      song = null;
      if (playing) {
        playing = false;
        streak = 0;
        onChange(false);
      }
    },
    isPlaying: () => playing,
    // "Artist - Song" while something plays, else null.
    getSong: () => (playing ? song : null),
  };
}

module.exports = { DEFAULT_CONFIG, parseSpotifyTitles, createSpotifyTitleReader, createMusicDetector };
