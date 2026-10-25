"use strict";

// Pet chatter: a local LLM (Ollama) writes one short speech-bubble line. The
// code decides WHEN to speak and WHAT the model may know; the model only writes
// the words. Each line is a fresh, stateless chat built from a small fact sheet.
//
//  - Facts are whitelisted named fields (see backgroundFacts). Hook payloads are
//    never passed through: observe() keeps only a coarse activity category, so
//    command text, file names and prompts cannot reach the prompt.
//  - A timer plus a few forced triggers (tests passing after failures, a stop
//    failure, the user returning, music starting) ask for a line. Cooldowns, a
//    global minimum gap and a single in-flight request keep it from nagging.
//  - Output is filtered (length, quotes, numbers, repeats, copied examples) and
//    retried; any failure is silent. Lines go out through onLine; showing them
//    is the caller's business.
// Everything takes an explicit clock, fetch, timers and random source for tests.

const MINUTE_MS = 60 * 1000;

const DEFAULT_CONFIG = Object.freeze({
  baseUrl: "http://127.0.0.1:11434",
  model: "baytout3/qwen3.5-uncensored:9b",
  // At least the longest timer gap, so the model stays loaded between lines.
  keepAlive: "30m",
  temperature: 0.8,
  numCtx: 2048,
  numPredict: 60,
  requestTimeoutMs: 30 * 1000,
  listTimeoutMs: 3 * 1000,
  // The first load from disk can take over a minute.
  warmTimeoutMs: 120 * 1000,
  maxTries: 3,
  maxWords: 12,
  // Words shared with a recent line or an example above this share are a repeat.
  similarity: 0.5,
  recentLines: 8,
  // Random check-in timer: [min, max] between rolls, only while the user is around.
  intervalMs: Object.freeze([8 * MINUTE_MS, 15 * MINUTE_MS]),
  presenceMs: 30 * MINUTE_MS,
  // Global limits. A forced line that arrives later than staleMs is dropped.
  minGapMs: 90 * 1000,
  staleMs: 45 * 1000,
  // First agent event after this long a gap counts as the user returning.
  awayMs: 90 * MINUTE_MS,
  // A same-activity run this long (or this many failing tests) becomes a streak fact.
  activityStreak: 5,
  testStreak: 2,
  // How many optional background facts a prompt gets (fewer facts, less latching).
  backgroundCount: 2,
  triggers: Object.freeze({
    "tests-pass-after-fails": Object.freeze({ chance: 0.8, cooldownMs: 5 * MINUTE_MS }),
    "stop-failure": Object.freeze({ chance: 0.5, cooldownMs: 10 * MINUTE_MS }),
    "user-returned": Object.freeze({ chance: 0.7, cooldownMs: 30 * MINUTE_MS }),
    "music-started": Object.freeze({ chance: 0.5, cooldownMs: 20 * MINUTE_MS }),
  }),
});

const CAST = (
  "Cast: you are Clawd, the desktop pet. The USER is your friend, who sits at the computer. "
  + "Claude is an AI coding assistant the user works with; it is not you and not the user. "
  + "Speak to the user or to yourself, never to Claude. Call Claude by name or say it; never he or she."
);

const RULES = (
  "You write ONE short thing the pet says out loud in a speech bubble.\n"
  + "Rules: at most 12 words. One sentence. No emoji. No hashtags. No quotation marks. "
  + "Never say you are an AI or a language model. Never explain. "
  + "React mainly to the TRIGGER. Mention at most ONE other fact, and usually none. "
  + "Do not list facts. Do not repeat the fact sheet back. Never invent facts that are not listed. "
  + "Never mention hours, minutes, days or any numbers. Do not name a mood as a status; show the feeling instead."
);

const PERSONA_INTRO = "You are Clawd, a small orange pixel creature living on the desktop.";

// Each personality is a voice line plus a pool of example lines. Examples are
// sampled a few at a time so the model learns the voice without memorizing it.
const PERSONALITIES = Object.freeze({
  deadpan: Object.freeze({
    persona: `${PERSONA_INTRO} Dry, deadpan, understated. Mildly sarcastic, never mean.`,
    examples: Object.freeze([
      "Compiled on the first try. Suspicious.",
      "Nobody asked, but the cursor and I are doing fine.",
      "Oh good, another red test. My favorite color.",
      "Back already? I barely missed you.",
      "Another file edited. The suspense is unbearable.",
      "I would help, but watching is my whole job.",
      "Reading code again. Thrilling stuff.",
      "That was fast. I assume it is broken.",
      "Still here. Still orange. Still judging gently.",
      "I have learned nothing today and I am calm.",
    ]),
  }),
  wholesome: Object.freeze({
    persona: `${PERSONA_INTRO} Warm, encouraging, a little goofy.`,
    examples: Object.freeze([
      "Look at that, it all worked! Proud of us.",
      "Take a sip of water, friend. I will hold the fort.",
      "You came back! The desk felt too quiet.",
      "Ooh, a new song. I am swaying a little.",
      "Claude is typing away. Go team!",
      "A little stretch might feel nice right about now.",
      "Every red test is just a green one in disguise.",
      "I like it when we work together like this.",
      "Good morning! Today feels like a good one.",
      "Look how much we got done. Gold star.",
    ]),
  }),
  anxious: Object.freeze({
    persona: `${PERSONA_INTRO} Nervous and a bit dramatic, but sweet and loyal.`,
    examples: Object.freeze([
      "Is that red text normal? Please say it is normal.",
      "It passed? Really? Okay. Okay! Breathing again.",
      "It is very late. I am only mentioning it gently.",
      "Did the window just blink? I saw it blink.",
      "So many files changing. I am fine. Totally fine.",
      "Claude is running commands again. I am watching closely.",
      "Please tell me that was a warning and not an error.",
      "It has been quiet for too long. Too quiet.",
      "You are back! I only panicked a little.",
      "Another command? I trust Claude. I mostly trust Claude.",
    ]),
  }),
});
const DEFAULT_PERSONALITY = "deadpan";
// Which settings.triggers switch controls each kind of line.
const TRIGGER_SWITCH = Object.freeze({
  "idle-check": "checkin",
  "tests-pass-after-fails": "tests",
  "stop-failure": "error",
  "user-returned": "return",
  "music-started": "music",
});

function triggerEnabled(settings, name) {
  const key = TRIGGER_SWITCH[name];
  return !(settings && settings.triggers && key && settings.triggers[key] === false);
}
const MAX_CUSTOM_PERSONALITY_CHARS = 300;

// ── Pure helpers ──

// Coarse category from a hook's tool name; the name itself is not kept.
function activityFromTool(toolName) {
  if (typeof toolName !== "string" || !toolName) return null;
  switch (toolName) {
    case "Read": case "Grep": case "Glob": case "LS":
      return "reading and searching the code";
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit":
      return "editing files";
    case "Bash": case "BashOutput":
      return "running commands in the terminal";
    case "Task": case "Agent":
      return "waiting on a helper agent";
    case "WebFetch": case "WebSearch":
      return "looking things up online";
    case "TodoWrite":
      return "planning the next steps";
    default:
      return "using a tool";
  }
}

function timeBucket(date) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  if (hour >= 21) return "late evening";
  return "the middle of the night";
}

// Mood channels (0..1) become plain words; calm channels are left out entirely.
function moodWords(values) {
  if (!values || typeof values !== "object") return null;
  const bands = [
    ["stress", "a little stressed", "very stressed"],
    ["satisfaction", "pleased", "very pleased"],
    ["fatigue", "sleepy", "very tired"],
    ["boredom", "bored", "very bored"],
  ];
  const words = [];
  for (const [name, mild, strong] of bands) {
    const value = values[name];
    if (!Number.isFinite(value) || value < 0.35) continue;
    words.push(value >= 0.7 ? strong : mild);
  }
  return words.length > 0 ? words.join(", ") : null;
}

function countWord(n) {
  return { 2: "two", 3: "three", 4: "four" }[n] || "many";
}

// The only way text reaches the prompt: named fields in, formatted lines out.
function backgroundFacts(fields = {}) {
  const lines = [];
  if (fields.mood) lines.push(`Mood: ${fields.mood}`);
  if (fields.claude) {
    lines.push(`Claude: ${fields.claude}${fields.activity ? `, currently ${fields.activity}` : ""}`);
  }
  if (fields.time) lines.push(`Time: ${fields.time}`);
  if (fields.music) lines.push("Music: playing");
  if (fields.streak) lines.push(`Streak: ${fields.streak}`);
  return lines;
}

function buildFactSheet({ trigger, background = [] }) {
  const lines = [`TRIGGER: ${trigger}`];
  if (background.length > 0) {
    lines.push("Other facts (optional background):");
    for (const fact of background) lines.push(`- ${fact}`);
  }
  return lines.join("\n");
}

function words(text) {
  return new Set(String(text).toLowerCase().match(/[a-z']+/g) || []);
}

function tooSimilar(text, others, threshold) {
  const mine = words(text);
  if (mine.size === 0) return false;
  for (const other of others) {
    const theirs = words(other);
    if (theirs.size === 0) continue;
    let shared = 0;
    for (const word of mine) if (theirs.has(word)) shared++;
    if (shared / (mine.size + theirs.size - shared) > threshold) return true;
  }
  return false;
}

// Turn raw model output into a bubble line, or say why it was rejected.
function cleanLine(raw, options = {}) {
  const maxWords = options.maxWords || DEFAULT_CONFIG.maxWords;
  const threshold = options.similarity || DEFAULT_CONFIG.similarity;
  let text = String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  text = (text.split(/\r?\n/)[0] || "")
    .replace(/[\u{1F000}-\u{1FAFF}☀-➿]/gu, "")
    .replace(/^["'`*_\s]+|["'`*_\s]+$/g, "")
    .trim();
  if (!text) return { text: "", reason: "empty" };
  if (text.split(/\s+/).length > maxWords) return { text, reason: "too-long" };
  if (/\d/.test(text)) return { text, reason: "number" };
  if (/\b(ai|language model)\b/i.test(text)) return { text, reason: "ai-mention" };
  if (/^claude[,!:]/i.test(text) || /,\s*claude[.!?]*$/i.test(text)) return { text, reason: "addresses-claude" };
  const history = [...(options.recent || []), ...(options.examples || [])];
  if (tooSimilar(text, history, threshold)) return { text, reason: "repeat" };
  return { text, reason: null };
}

function resolvePersonality(settings = {}) {
  // Custom text applies only when "custom" is the chosen personality, so text
  // left in the box never overrides a built-in choice.
  const custom = settings.personality === "custom" && typeof settings.customPersonality === "string"
    ? settings.customPersonality.replace(/\s+/g, " ").trim().slice(0, MAX_CUSTOM_PERSONALITY_CHARS)
    : "";
  if (custom) {
    // Custom text only replaces the voice line; cast, rules and filters stay fixed.
    return { id: "custom", persona: `${PERSONA_INTRO} Personality: ${custom}`, examples: [] };
  }
  const id = PERSONALITIES[settings.personality] ? settings.personality : DEFAULT_PERSONALITY;
  return { id, ...PERSONALITIES[id] };
}

function buildSystemPrompt(personality, random = Math.random) {
  const pool = [...personality.examples];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const shots = pool.slice(0, 4);
  let prompt = `${personality.persona}\n${CAST}\n${RULES}`;
  if (shots.length > 0) {
    prompt += `\nExamples of your voice (other situations, never copy them):\n${shots.map((s) => `- ${s}`).join("\n")}`;
  }
  return prompt;
}

function triggerText(name, details, ctx) {
  switch (name) {
    case "tests-pass-after-fails":
      return `The tests just passed after ${countWord(details.count)} failures in a row.`;
    case "stop-failure":
      return "Claude hit an error and stopped.";
    case "user-returned":
      return "The user just came back after being away for a long time.";
    case "music-started":
      return "Music just started playing.";
    case "hotkey":
      return "The user just asked you to say something.";
    default:
      if (ctx.working && ctx.activity) return `Claude has been busy for a while, ${ctx.activity}.`;
      if (ctx.working) return "Claude has been busy for a while.";
      return "Nothing is happening; a random check-in.";
  }
}

function shuffled(list, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ── Stateful chatter ──

function createChatter(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const fetchFn = options.fetch || globalThis.fetch;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const log = typeof options.log === "function" ? options.log : () => {};
  const onLine = typeof options.onLine === "function" ? options.onLine : () => {};
  // { mood, musicPlaying } at call time; mood comes from the mood tracker.
  const getSnapshot = options.getSnapshot || (() => ({}));
  // { enabled, model, personality, customPersonality }; all optional.
  const getSettings = options.getSettings || (() => ({ enabled: true }));
  const canSpeak = options.canSpeak || (() => true);
  const timers = options.timers || { setTimeout, clearTimeout };

  const recentByPersonality = new Map();
  const lastTriggerAt = new Map();
  let lastSpokeAt = null;
  let lastActivityAt = null;
  let status = "idle";
  let activity = null;
  let activityRun = 0;
  let testFails = 0;
  let inFlight = false;
  const warmedModels = new Set();
  let timer = null;
  let running = false;

  function recentFor(id) {
    if (!recentByPersonality.has(id)) recentByPersonality.set(id, []);
    return recentByPersonality.get(id);
  }

  function claudeStatus(t) {
    if (status === "working" && lastActivityAt != null && t - lastActivityAt > 5 * MINUTE_MS) return "idle for a while";
    return status;
  }

  function buildPrompt(name, details, settings) {
    const t = now();
    const snapshot = getSnapshot() || {};
    const claude = claudeStatus(t);
    const working = claude === "working";
    const trigger = triggerText(name, details, { working, activity: activity && activity.category });
    const fields = {
      mood: moodWords(snapshot.mood),
      claude,
      time: timeBucket(new Date(t)),
      music: snapshot.musicPlaying === true,
      streak: testFails >= config.testStreak
        ? `tests have failed ${countWord(testFails)} times in a row`
        : (activity && activityRun >= config.activityStreak ? `many steps of ${activity.category} in a row` : null),
    };
    const background = shuffled(backgroundFacts(fields), random).slice(0, config.backgroundCount);
    const personality = resolvePersonality(settings);
    return {
      personality,
      factSheet: buildFactSheet({ trigger, background }),
      system: buildSystemPrompt(personality, random),
    };
  }

  async function post(path, body, timeoutMs) {
    const controller = new AbortController();
    const abort = timers.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ollama ${response.status}`);
      return await response.json();
    } finally {
      timers.clearTimeout(abort);
    }
  }

  // One line for a trigger name, or null. No timers or cooldowns: used by the
  // speak path below and directly by the node probe.
  async function generate(name, details = {}, settings = getSettings() || {}) {
    const { personality, factSheet, system } = buildPrompt(name, details, settings);
    const recent = recentFor(personality.id);
    const model = settings.model || config.model;
    for (let attempt = 1; attempt <= config.maxTries; attempt++) {
      const data = await post("/api/chat", {
        model,
        stream: false,
        think: false,
        keep_alive: config.keepAlive,
        options: { temperature: config.temperature, num_predict: config.numPredict, num_ctx: config.numCtx },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${factSheet}\n\nSay your one line.` },
        ],
      }, warmedModels.has(model) ? config.requestTimeoutMs : config.warmTimeoutMs);
      warmedModels.add(model);
      const { text, reason } = cleanLine(data && data.message && data.message.content, {
        maxWords: config.maxWords,
        similarity: config.similarity,
        recent,
        examples: personality.examples,
      });
      if (!reason) return { text, attempt, personality: personality.id, factSheet };
      log(`chatter rejected=${reason} try=${attempt}`);
    }
    return null;
  }

  // `force` is for a line the user asked for: no trigger switch, minimum gap or
  // staleness rule applies (the master switch and a single request at a time do).
  async function speak(name, details = {}, { force = false } = {}) {
    const settings = getSettings() || {};
    if (settings.enabled === false || (!force && !triggerEnabled(settings, name)) || inFlight) return null;
    const t = now();
    if (!force && lastSpokeAt != null && t - lastSpokeAt < config.minGapMs) return null;
    if (!canSpeak()) return null;
    inFlight = true;
    try {
      const result = await generate(name, details, settings);
      if (!result) return null;
      // A line about something that just happened must still be about now.
      if (!force && name !== "idle-check" && now() - t > config.staleMs) {
        log(`chatter stale trigger=${name}`);
        return null;
      }
      lastSpokeAt = now();
      const recent = recentFor(result.personality);
      recent.push(result.text);
      while (recent.length > config.recentLines) recent.shift();
      log(`chatter trigger=${name} persona=${result.personality} try=${result.attempt} line=${result.text} facts=${result.factSheet.replace(/\n/g, " | ")}`);
      onLine({ text: result.text, trigger: name, personality: result.personality });
      return result;
    } catch (err) {
      log(`chatter failed trigger=${name} error=${err && err.name === "AbortError" ? "timeout" : (err && err.message)}`);
      return null;
    } finally {
      inFlight = false;
    }
  }

  // Forced trigger: chance and cooldown first, then the shared limits in speak().
  function notify(name, details = {}) {
    const rule = config.triggers[name];
    if (!rule) return false;
    // A disabled chatter or trigger must not burn chances or cooldowns.
    const settings = getSettings() || {};
    if (settings.enabled === false || !triggerEnabled(settings, name)) return false;
    const t = now();
    const last = lastTriggerAt.get(name);
    if (last != null && t - last < rule.cooldownMs) return false;
    if (random() >= rule.chance) return false;
    lastTriggerAt.set(name, t);
    void speak(name, details);
    return true;
  }

  // Same tap as the mood tracker: { event, testResult, failureKind, toolName }.
  // Only a coarse category is kept from the tool name.
  function observe(input = {}) {
    const t = now();
    const { event, testResult, failureKind, toolName } = input || {};
    const gap = lastActivityAt == null ? 0 : t - lastActivityAt;
    lastActivityAt = t;
    if (gap >= config.awayMs) notify("user-returned");

    const category = activityFromTool(toolName);
    if (category) {
      // Each tool call reports twice (Pre and Post); count the run on Post only.
      if (!activity || activity.category !== category) activityRun = 0;
      activity = { category };
      if (event === "PostToolUse" || event === "PostToolUseFailure") activityRun += 1;
    }
    if (event === "Stop" && failureKind !== "api_error") {
      status = "finished";
      activity = null;
      activityRun = 0;
    } else if (event === "StopFailure" || (event === "Stop" && failureKind === "api_error")) {
      status = "stopped with an error";
      activity = null;
      activityRun = 0;
      notify("stop-failure");
    } else if (event !== "SessionStart" && event !== "SessionEnd") {
      status = "working";
    }

    if (testResult === "fail") {
      testFails += 1;
    } else if (testResult === "pass") {
      const failed = testFails;
      testFails = 0;
      if (failed >= config.testStreak) notify("tests-pass-after-fails", { count: failed });
    }
  }

  function present() {
    return lastActivityAt != null && now() - lastActivityAt <= config.presenceMs;
  }

  // Average minutes between check-ins from settings (spread +-30%), else the config range.
  function intervalRange() {
    const minutes = (getSettings() || {}).checkinMinutes;
    if (Number.isFinite(minutes) && minutes > 0) return [minutes * MINUTE_MS * 0.7, minutes * MINUTE_MS * 1.3];
    return config.intervalMs;
  }

  function schedule() {
    if (!running) return;
    const [min, max] = intervalRange();
    timer = timers.setTimeout(tick, min + random() * (max - min));
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function tick() {
    timer = null;
    if (!running) return;
    // Nobody is around to read it: skip this roll. A switched-off check-in is
    // skipped inside speak().
    if (present()) void speak("idle-check");
    schedule();
  }

  // Free the model's memory (used when chatter is switched off). Errors are ignored.
  async function unload() {
    const settings = getSettings() || {};
    const model = settings.model || config.model;
    warmedModels.delete(model);
    try {
      await post("/api/chat", { model, keep_alive: 0 }, config.requestTimeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  // Installed Ollama models, for the model picker. { ok, models } or { ok: false, error }.
  async function listModels() {
    const controller = new AbortController();
    const abort = timers.setTimeout(() => controller.abort(), config.listTimeoutMs);
    try {
      const response = await fetchFn(`${config.baseUrl}/api/tags`, { signal: controller.signal });
      if (!response.ok) throw new Error(`ollama ${response.status}`);
      const data = await response.json();
      const models = (data && Array.isArray(data.models) ? data.models : [])
        .map((entry) => (entry && typeof entry.name === "string" ? entry.name : ""))
        .filter(Boolean)
        .sort();
      return { ok: true, models, defaultModel: config.model };
    } catch (err) {
      return { ok: false, models: [], defaultModel: config.model, error: err && err.name === "AbortError" ? "timeout" : (err && err.message) || "unreachable" };
    } finally {
      timers.clearTimeout(abort);
    }
  }

  // Load the model before the first line is needed. Errors are ignored.
  async function warm() {
    const settings = getSettings() || {};
    if (settings.enabled === false) return false;
    try {
      // Same num_ctx as real requests: a different context makes Ollama reload the model.
      const model = settings.model || config.model;
      await post("/api/chat", {
        model,
        keep_alive: config.keepAlive,
        options: { num_ctx: config.numCtx },
      }, config.warmTimeoutMs);
      warmedModels.add(model);
      return true;
    } catch {
      return false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
    // Re-read the interval setting: a pending long timer must not outlive a change.
    reschedule() {
      if (!running) return;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      schedule();
    },
    warm,
    unload,
    // A line the user asked for (hotkey). Resolves to the line, or null.
    sayNow: () => speak("hotkey", {}, { force: true }),
    listModels,
    observe,
    notify,
    generate,
    isBusy: () => inFlight,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  PERSONALITIES,
  CAST,
  RULES,
  activityFromTool,
  timeBucket,
  moodWords,
  backgroundFacts,
  buildFactSheet,
  cleanLine,
  resolvePersonality,
  buildSystemPrompt,
  TRIGGER_SWITCH,
  createChatter,
};
