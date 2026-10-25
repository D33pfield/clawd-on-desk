"use strict";

// Is Spotify playing? Windows exposes every media player's playback state
// through the System Media Transport Controls; a short PowerShell snippet reads
// it. The detector polls (one process per poll, nothing stays running), debounces
// so a skipped track or a brief pause does not flicker, and reports changes via
// onChange(playing). Any failure counts as "not playing".

const { execFile } = require("child_process");

const DEFAULT_CONFIG = Object.freeze({
  intervalMs: 4000,
  // A poll that takes longer than this is killed (a normal one takes ~1 s).
  timeoutMs: 5000,
  // Consecutive polls needed to flip state. Start fast, stop a little slower.
  startPolls: 1,
  stopPolls: 2,
  // Matches the source app id: "SpotifyAB.SpotifyMusic_...!Spotify" (Store) or "Spotify.exe".
  sourcePattern: /spotify/i,
});

// Prints one "<source app id>|<status>" line per media session.
const MEDIA_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$mgr = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
$task = $asTask.MakeGenericMethod($mgr).Invoke($null, @($mgr::RequestAsync()))
$task.Wait(-1) | Out-Null
foreach ($s in $task.Result.GetSessions()) { $s.SourceAppUserModelId + '|' + $s.GetPlaybackInfo().PlaybackStatus }
`;

function encodeScript(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function parseIsPlaying(stdout, sourcePattern = DEFAULT_CONFIG.sourcePattern) {
  if (typeof stdout !== "string") return false;
  return stdout.split(/\r?\n/).some((line) => {
    const sep = line.lastIndexOf("|");
    if (sep < 0) return false;
    return sourcePattern.test(line.slice(0, sep)) && line.slice(sep + 1).trim() === "Playing";
  });
}

function runMediaScript(callback) {
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeScript(MEDIA_SCRIPT)],
    { windowsHide: true, timeout: DEFAULT_CONFIG.timeoutMs, maxBuffer: 64 * 1024 },
    (err, stdout) => callback(err, stdout),
  );
}

function createMusicDetector(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const platform = options.platform || process.platform;
  const run = options.run || runMediaScript;
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  const log = typeof options.log === "function" ? options.log : () => {};
  const timers = options.timers || { setTimeout, clearTimeout };

  let playing = false;
  let streak = 0; // consecutive polls disagreeing with `playing`
  let timer = null;
  let inFlight = false;
  let running = false;

  function applyPoll(sawPlaying) {
    if (sawPlaying === playing) {
      streak = 0;
      return;
    }
    streak += 1;
    if (streak < (sawPlaying ? config.startPolls : config.stopPolls)) return;
    streak = 0;
    playing = sawPlaying;
    log(`music playing=${playing}`);
    onChange(playing);
  }

  function schedule() {
    if (!running) return;
    timer = timers.setTimeout(poll, config.intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function poll() {
    timer = null;
    if (!running || inFlight) return schedule();
    inFlight = true;
    let finished = false;
    run((err, stdout) => {
      if (finished) return;
      finished = true;
      inFlight = false;
      if (!running) return;
      applyPoll(err ? false : parseIsPlaying(stdout, config.sourcePattern));
      schedule();
    });
  }

  return {
    start() {
      if (running || platform !== "win32") return;
      running = true;
      poll();
    },
    stop() {
      running = false;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      if (playing) {
        playing = false;
        streak = 0;
        onChange(false);
      }
    },
    isPlaying: () => playing,
  };
}

module.exports = { DEFAULT_CONFIG, MEDIA_SCRIPT, parseIsPlaying, createMusicDetector };
