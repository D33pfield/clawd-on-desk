"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_CONFIG,
  parseSpotifyTitles,
  createSpotifyTitleReader,
  createMusicDetector,
} = require("../src/music");

describe("parseSpotifyTitles", () => {
  it("is playing when a window title is 'Artist - Song', and returns the song", () => {
    assert.deepStrictEqual(parseSpotifyTitles(["Example Artist - Example Song"]), { playing: true, song: "Example Artist - Example Song" });
    // The same shapes seen on a real Spotify while playing, skipping and minimized
    // (invented names here): a long title, and a title with a parenthesised remix.
    assert.strictEqual(parseSpotifyTitles(["The Placeholders - A Much Longer Song Title In Between"]).playing, true);
    assert.strictEqual(parseSpotifyTitles(["Some Singer - Another Song (Somebody Remix)"]).playing, true);
  });

  it("is not playing for Spotify's idle titles in any edition", () => {
    for (const idle of ["Spotify Premium", "Spotify Free", "Spotify", "spotify premium"]) {
      assert.deepStrictEqual(parseSpotifyTitles([idle]), { playing: false, song: null }, idle);
    }
  });

  it("ignores the helper windows Spotify owns, whatever order they arrive in", () => {
    const junk = ["GDI+ Window (Spotify.exe)", "MSCTFIME UI", "Default IME"];
    assert.strictEqual(parseSpotifyTitles(junk).playing, false);
    assert.deepStrictEqual(parseSpotifyTitles([...junk, "Example Artist - Example Song", "Spotify Premium"]), { playing: true, song: "Example Artist - Example Song" });
    assert.deepStrictEqual(parseSpotifyTitles(["Spotify Premium", ...junk, "Example Artist - Example Song"]), { playing: true, song: "Example Artist - Example Song" });
  });

  it("treats an advertisement as playing, with no song", () => {
    assert.deepStrictEqual(parseSpotifyTitles(["Advertisement"]), { playing: true, song: null });
  });

  it("is not playing for nothing, nonsense or a title that merely starts with Spotify", () => {
    assert.strictEqual(parseSpotifyTitles([]).playing, false);
    assert.strictEqual(parseSpotifyTitles(undefined).playing, false);
    assert.strictEqual(parseSpotifyTitles([null, 7, "", "   "]).playing, false);
    assert.strictEqual(parseSpotifyTitles(["Spotify - Web Player"]).playing, false);
  });
});

describe("createMusicDetector", () => {
  function fakeTimers() {
    const pending = [];
    return {
      pending,
      setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; pending.push(h); return h; },
      clearTimeout: (h) => { if (h) h.cleared = true; },
      tick() { const h = pending.find((x) => !x.cleared && !x.fired); if (h) { h.fired = true; h.fn(); } },
    };
  }

  // `reads` is consumed one check at a time: an array of titles, or an Error to throw.
  function setup(reads, extra = {}) {
    const timers = fakeTimers();
    const changes = [];
    const logs = [];
    const queue = [...reads];
    let closed = 0;
    let readCount = 0;
    const reader = {
      read: () => {
        readCount += 1;
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next === undefined ? [] : next;
      },
      close: () => { closed += 1; },
    };
    const detector = createMusicDetector({
      platform: "win32",
      timers,
      makeReader: () => reader,
      onChange: (playing) => changes.push(playing),
      log: (msg) => logs.push(msg),
      ...extra,
    });
    return { detector, timers, changes, logs, reader, closedCount: () => closed, readCount: () => readCount };
  }

  const playing = ["Example Artist - Example Song", "Spotify Premium"];
  const paused = ["Spotify Premium"];

  it("does nothing off Windows", () => {
    const { detector, readCount } = setup([playing], { platform: "linux" });
    detector.start();
    assert.strictEqual(readCount(), 0);
    assert.strictEqual(detector.isPlaying(), false);
  });

  it("reports playing on the first check that sees a track, and exposes the song", () => {
    const { detector, changes } = setup([playing]);
    detector.start();
    assert.deepStrictEqual(changes, [true]);
    assert.strictEqual(detector.isPlaying(), true);
    assert.strictEqual(detector.getSong(), "Example Artist - Example Song");
  });

  it("needs two idle checks to stop, so a blip does not flicker", () => {
    const { detector, timers, changes } = setup([playing, paused, playing, paused, paused]);
    detector.start();
    timers.tick(); // paused (1 of 2)
    assert.strictEqual(detector.isPlaying(), true);
    timers.tick(); // playing again resets the streak
    timers.tick(); // paused (1 of 2)
    assert.strictEqual(detector.isPlaying(), true);
    timers.tick(); // paused (2 of 2)
    assert.strictEqual(detector.isPlaying(), false);
    assert.deepStrictEqual(changes, [true, false]);
    assert.strictEqual(detector.getSong(), null);
  });

  it("follows the song through skips without reporting a change", () => {
    const { detector, timers, changes } = setup([["A - One"], ["B - Two"]]);
    detector.start();
    assert.strictEqual(detector.getSong(), "A - One");
    timers.tick();
    assert.strictEqual(detector.getSong(), "B - Two");
    assert.deepStrictEqual(changes, [true]);
  });

  it("checks again after the configured interval", () => {
    const { detector, timers } = setup([playing]);
    detector.start();
    assert.strictEqual(timers.pending.at(-1).ms, DEFAULT_CONFIG.intervalMs);
  });

  it("treats a failing read as not playing and says so once", () => {
    const { detector, timers, changes, logs } = setup([playing, new Error("boom"), new Error("boom"), new Error("boom")]);
    detector.start();
    timers.tick();
    timers.tick();
    timers.tick();
    assert.deepStrictEqual(changes, [true, false]);
    assert.strictEqual(logs.filter((m) => m.startsWith("music read failed")).length, 1);
  });

  it("is simply off when the reader cannot be created, and says so once", () => {
    const logs = [];
    const detector = createMusicDetector({
      platform: "win32",
      makeReader: () => { throw new Error("no koffi"); },
      log: (m) => logs.push(m),
    });
    detector.start();
    detector.start();
    assert.strictEqual(detector.isPlaying(), false);
    assert.deepStrictEqual(logs, ["music detector unavailable: no koffi"]);
  });

  it("stop() cancels checks, releases the reader and clears the playing state", () => {
    const { detector, timers, changes, closedCount, readCount } = setup([playing, playing]);
    detector.start();
    detector.stop();
    timers.tick();
    assert.strictEqual(readCount(), 1);
    assert.strictEqual(closedCount(), 1);
    assert.deepStrictEqual(changes, [true, false]);
    assert.strictEqual(detector.getSong(), null);
    detector.start(); // can be started again with a fresh reader
    assert.strictEqual(readCount(), 2);
  });

  it("keeps the song title out of its log lines", () => {
    const { detector, logs } = setup([playing]);
    detector.start();
    assert.deepStrictEqual(logs, ["music playing=true"]);
  });
});

describe("createSpotifyTitleReader (the FFI layer, against a fake koffi)", () => {
  // Fake windows: [title, pid]. Pids 100 and 101 are Spotify.exe; 200 is something else.
  function fakeKoffi(windows) {
    const calls = { openProcess: [], registered: 0, unregistered: 0, enumerations: 0 };
    const exeByPid = { 100: "C:\\Spotify\\Spotify.exe", 101: "C:\\Spotify\\Spotify.exe", 200: "C:\\Windows\\notepad.exe" };
    let callback = null;
    const put = (units, text) => { for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i); return text.length; };
    const handles = new Map();
    const koffi = {
      proto: () => "proto",
      pointer: () => "pointer",
      register: (fn) => { calls.registered += 1; callback = fn; return fn; },
      unregister: () => { calls.unregistered += 1; },
      load: (lib) => lib === "user32.dll"
        ? {
          func: (decl) => {
            if (decl.includes("EnumWindows")) return (cb) => { calls.enumerations += 1; windows.forEach((w, i) => { handles.set(i, w); cb(i); }); return true; };
            if (decl.includes("GetWindowTextW")) return (hwnd, buf) => put(buf, handles.get(hwnd)[0]);
            if (decl.includes("GetWindowThreadProcessId")) return (hwnd, out) => { out[0] = handles.get(hwnd)[1]; return 1; };
            throw new Error(`unexpected user32 function ${decl}`);
          },
        }
        : {
          func: (decl) => {
            if (decl.includes("OpenProcess")) return (_access, _inherit, pid) => { calls.openProcess.push(pid); return pid; };
            if (decl.includes("QueryFullProcessImageNameW")) return (handle, _flags, buf, size) => { size[0] = put(buf, exeByPid[handle]); return true; };
            if (decl.includes("CloseHandle")) return () => true;
            throw new Error(`unexpected kernel32 function ${decl}`);
          },
        },
    };
    return { koffi, calls, run: () => callback };
  }

  it("returns only the titles of Spotify's own windows, skipping windows with no text", () => {
    const { koffi } = fakeKoffi([["Notes - Notepad", 200], ["", 100], ["Example Artist - Example Song", 100], ["MSCTFIME UI", 101]]);
    const reader = createSpotifyTitleReader({ koffi });
    assert.deepStrictEqual(reader.read(), ["Example Artist - Example Song", "MSCTFIME UI"]);
  });

  it("registers its native callback once, looks each process up once, and releases it on close", () => {
    const { koffi, calls } = fakeKoffi([["Example Artist - Example Song", 100], ["Notes - Notepad", 200]]);
    const reader = createSpotifyTitleReader({ koffi });
    for (let i = 0; i < 5; i++) reader.read();
    assert.strictEqual(calls.registered, 1, "a callback per read would leak native slots");
    assert.strictEqual(calls.enumerations, 5);
    assert.deepStrictEqual(calls.openProcess.sort(), [100, 200], "each pid is queried once, then cached");
    reader.close();
    assert.strictEqual(calls.unregistered, 1);
    assert.deepStrictEqual(reader.read(), [], "a closed reader reads nothing and does not touch native code");
    assert.strictEqual(calls.enumerations, 5);
  });

  it("forgets cached pids after a while, so a reused pid cannot mislead", () => {
    let clock = 0;
    const { koffi, calls } = fakeKoffi([["Example Artist - Example Song", 100]]);
    const reader = createSpotifyTitleReader({ koffi, now: () => clock });
    reader.read();
    clock += DEFAULT_CONFIG.pidCacheMs + 1;
    reader.read();
    assert.deepStrictEqual(calls.openProcess, [100, 100]);
  });
});

describe("music wiring", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");

  it("no longer launches PowerShell, and loads koffi lazily inside a try", () => {
    const source = read("music.js");
    assert.doesNotMatch(source, /powershell|execFile|child_process|EncodedCommand/i);
    assert.match(source, /options\.koffi \|\| require\("koffi"\)/);
    assert.match(source, /try \{\s*reader = makeReader\(\);\s*\} catch/);
  });

  it("preload exposes the channel, and the page and styles carry the slot and bob", () => {
    assert.match(read("preload.js"), /onMusicState: \(cb\) => ipcRenderer\.on\("music-state"/);
    assert.match(read("index.html"), /<object id="clawd-music-accessory"/);
    const html = read("index.html");
    assert.ok(
      html.indexOf('id="pet-music-accessory-layer"') < html.indexOf('id="pet-media-layer"'),
      "the headphones layer must sit behind the pet so eyes and props draw over it"
    );
    assert.match(read("styles.css"), /#pet-container\.music-bob:not\(\.roam-walk\) #pet-motion-stage/);
  });
});
