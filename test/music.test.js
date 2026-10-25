"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { MEDIA_SCRIPT, parseIsPlaying, createMusicDetector } = require("../src/music");

const SPOTIFY = "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify";

describe("parseIsPlaying", () => {
  it("is true when a Spotify session is Playing", () => {
    assert.strictEqual(parseIsPlaying(`${SPOTIFY}|Playing\r\n`), true);
    assert.strictEqual(parseIsPlaying("Spotify.exe|Playing"), true);
  });

  it("is false when Spotify is paused or stopped", () => {
    assert.strictEqual(parseIsPlaying(`${SPOTIFY}|Paused`), false);
    assert.strictEqual(parseIsPlaying(`${SPOTIFY}|Stopped`), false);
  });

  it("ignores other players and finds Spotify among several sessions", () => {
    assert.strictEqual(parseIsPlaying("Chrome|Playing\n"), false);
    assert.strictEqual(parseIsPlaying(`Chrome|Paused\n${SPOTIFY}|Playing\n`), true);
  });

  it("is false for empty or non-string output", () => {
    assert.strictEqual(parseIsPlaying(""), false);
    assert.strictEqual(parseIsPlaying(undefined), false);
    assert.strictEqual(parseIsPlaying("garbage"), false);
  });
});

describe("media script", () => {
  it("keeps the generic AsTask type-name backtick intact", () => {
    assert.ok(MEDIA_SCRIPT.includes("'IAsyncOperation`1'"));
    assert.ok(MEDIA_SCRIPT.startsWith("\n$ProgressPreference = 'SilentlyContinue'"));
  });
});

describe("createMusicDetector", () => {
  function fakeTimers() {
    const pending = [];
    return {
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, cleared: false };
        pending.push(handle);
        return handle;
      },
      clearTimeout: (handle) => { handle.cleared = true; },
      // Run the next scheduled poll.
      tick() {
        const handle = pending.shift();
        if (handle && !handle.cleared) handle.fn();
      },
    };
  }

  // `results` is consumed one poll at a time: a string is stdout, an Error fails the poll.
  function setup(results, extra = {}) {
    const timers = fakeTimers();
    const changes = [];
    const queue = [...results];
    let runs = 0;
    const detector = createMusicDetector({
      platform: "win32",
      timers,
      run: (cb) => {
        runs += 1;
        const next = queue.shift();
        if (next instanceof Error) cb(next);
        else cb(null, next);
      },
      onChange: (playing) => changes.push(playing),
      ...extra,
    });
    return { detector, timers, changes, runs: () => runs };
  }

  const playing = `${SPOTIFY}|Playing`;
  const paused = `${SPOTIFY}|Paused`;

  it("does nothing off Windows", () => {
    const { detector, runs } = setup([playing], { platform: "linux" });
    detector.start();
    assert.strictEqual(runs(), 0);
    assert.strictEqual(detector.isPlaying(), false);
  });

  it("reports playing after the first Playing poll", () => {
    const { detector, changes } = setup([playing]);
    detector.start();
    assert.deepStrictEqual(changes, [true]);
    assert.strictEqual(detector.isPlaying(), true);
  });

  it("needs two non-playing polls to stop, so a blip does not flicker", () => {
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
  });

  it("treats a failed poll as not playing", () => {
    const { detector, timers, changes } = setup([playing, new Error("boom"), new Error("boom")]);
    detector.start();
    timers.tick();
    timers.tick();
    assert.deepStrictEqual(changes, [true, false]);
  });

  it("does not start a poll while one is still running", () => {
    const timers = fakeTimers();
    const callbacks = [];
    const detector = createMusicDetector({ platform: "win32", timers, run: (cb) => callbacks.push(cb) });
    detector.start();
    assert.strictEqual(callbacks.length, 1);
    timers.tick(); // never scheduled yet: the first poll has not finished
    assert.strictEqual(callbacks.length, 1);
    callbacks[0](null, "");
    timers.tick();
    assert.strictEqual(callbacks.length, 2);
  });

  it("stop() cancels polling and clears the playing state", () => {
    const { detector, timers, changes, runs } = setup([playing, playing]);
    detector.start();
    detector.stop();
    timers.tick();
    assert.strictEqual(runs(), 1);
    assert.deepStrictEqual(changes, [true, false]);
    assert.strictEqual(detector.isPlaying(), false);
  });

  it("ignores a poll that finishes after stop()", () => {
    const timers = fakeTimers();
    const changes = [];
    let pending;
    const detector = createMusicDetector({
      platform: "win32",
      timers,
      run: (cb) => { pending = cb; },
      onChange: (p) => changes.push(p),
    });
    detector.start();
    detector.stop();
    pending(null, playing);
    assert.deepStrictEqual(changes, []);
  });
});

describe("music wiring", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");

  it("main starts and stops the detector and resends the state after a renderer load", () => {
    const main = read("main.js");
    assert.match(main, /sendToRenderer\("music-state", playing\)/);
    assert.match(main, /musicDetector\.start\(\)/);
    assert.match(main, /musicDetector\.stop\(\)/);
    assert.match(main, /if \(musicDetector\.isPlaying\(\)\) sendToRenderer\("music-state", true\)/);
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
