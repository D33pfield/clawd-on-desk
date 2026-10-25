"use strict";

// Pet chatter: a local LLM (Ollama) writes a short reply of one to three lines,
// shown as back-to-back speech bubbles. The code decides WHEN to speak and WHAT
// the model may know; the model only writes the words. Each reply is a fresh,
// stateless chat built from a fact sheet with one required FOCUS fact (rotated
// so consecutive replies are about different things) plus a few others.
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
  // Room for two short lines.
  numPredict: 120,
  requestTimeoutMs: 30 * 1000,
  listTimeoutMs: 3 * 1000,
  // The first load from disk can take over a minute.
  warmTimeoutMs: 120 * 1000,
  maxTries: 3,
  maxWords: 12,
  // A reply is split into bubbles: at most this many, each this long, and this long in all.
  maxParts: 2,
  maxWordsPerPart: 16,
  maxTotalWords: 32,
  // Custom personalities get a pool of example lines the model writes once.
  seedExamples: 8,
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
  + "Speak to the user or to yourself, never to Claude."
);

const RULES = (
  "You write what the pet says out loud: two short lines, each on its own line. Each line becomes its own speech bubble.\n"
  + "Rules: each line at most 14 words. No emoji. No hashtags. No quotation marks. No bullets or numbering. "
  + "Never say you are an AI or a language model. Never explain. "
  + "Your reply must be about the FOCUS fact: use its specifics (what, how much, how long) and react to them in character. "
  + "React to the TRIGGER too. You may use one other fact if it fits. "
  + "Do not just greet, and do not just say what time of day it is. Do not list facts or repeat the fact sheet back. "
  + "Speak as dialogue in the first person: no stage directions, no asterisks, no narrating your own body or actions "
  + "(no fur, whiskers, tail, paws, purring or heartbeat). Be concrete about the screen, the code and the desk, "
  + "and skip poetic filler about hums, glows, silence or stillness. "
  + "Never invent facts that are not listed. Use a number only if it appears in the facts. "
  + "Do not name a mood as a status; show the feeling instead."
);

// For a custom personality the user's own words decide who the pet is, so the
// cast only says who the user is and what "Claude" means in the facts.
const CAST_CUSTOM = (
  "Setting: the USER sits at the computer. In the facts below, Claude (or Claude Code) is the AI coding assistant "
  + "doing the user's work. Speak to the user, or to yourself."
);

const { PERSONALITIES, DEFAULT_PERSONALITY } = require("./chatter-personalities");
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

// Short key for the per-session counters; same grouping as activityFromTool.
function categoryKey(toolName) {
  switch (toolName) {
    case "Read": case "Grep": case "Glob": case "LS": return "reads";
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return "edits";
    case "Bash": case "BashOutput": return "commands";
    case "Task": case "Agent": return "helpers";
    case "WebFetch": case "WebSearch": return "lookups";
    default: return typeof toolName === "string" && toolName ? "other" : null;
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

// Facts that can be the required FOCUS, in the order they are rotated through.
const FOCUS_ORDER = Object.freeze([
  "away", "session", "context", "tests", "failures", "turns", "duration", "claude", "streak", "music", "mood", "idle", "time",
]);

// What each situation is mostly about; used as the focus when that fact exists.
const FOCUS_FOR_TRIGGER = Object.freeze({
  "tests-pass-after-fails": ["tests", "streak"],
  "stop-failure": ["failures", "claude"],
  "user-returned": ["away", "idle", "duration"],
  "music-started": ["music"],
});

function pluralize(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function durationWords(ms) {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 60) return pluralize(minutes, "minute", "minutes");
  const hours = Math.round((ms / (60 * MINUTE_MS)) * 2) / 2; // nearest half hour
  return `${hours} hours`;
}

// Strip anything odd from a song title before it goes near the prompt.
function cleanSong(song) {
  if (typeof song !== "string") return "";
  return song.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/["`]/g, "'").trim().slice(0, 80);
}

// The only way text reaches the prompt: named fields in, formatted facts out.
// Returns [{ key, text }] for every fact that has something to say.
function factList(fields = {}) {
  const out = [];
  const add = (key, text) => { if (text) out.push({ key, text }); };
  add("mood", fields.mood && `The pet itself feels: ${fields.mood}`);
  add("claude", fields.claude && `Claude is ${fields.claude}${fields.activity ? `, currently ${fields.activity}` : ""}`);
  add("time", fields.time && `It is ${fields.time}`);
  if (fields.music) {
    const song = cleanSong(fields.song);
    add("music", song ? `Music is playing right now: ${song}` : "Music is playing right now");
  }
  add("streak", fields.streak && `Streak: ${fields.streak}`);
  const s = fields.session;
  if (s && s.toolCalls > 0) {
    const parts = [];
    if (s.edits) parts.push(pluralize(s.edits, "edit", "edits"));
    if (s.commands) parts.push(pluralize(s.commands, "command", "commands"));
    if (s.reads) parts.push(pluralize(s.reads, "file read or search", "file reads and searches"));
    if (s.helpers) parts.push(pluralize(s.helpers, "helper agent", "helper agents"));
    if (s.lookups) parts.push(pluralize(s.lookups, "web lookup", "web lookups"));
    add("session", `This session Claude has made ${pluralize(s.toolCalls, "tool call", "tool calls")}${parts.length ? ` (${parts.join(", ")})` : ""}`);
  }
  if (s && s.testsPassed + s.testsFailed > 0) {
    add("tests", `Test runs this session: ${s.testsPassed} passed, ${s.testsFailed} failed`);
  }
  if (s && s.failures > 0) add("failures", `${pluralize(s.failures, "tool call", "tool calls")} failed this session`);
  if (s && s.turns > 0) add("turns", `Claude has finished ${pluralize(s.turns, "task", "tasks")} this session`);
  if (fields.sessionMs >= 10 * MINUTE_MS) add("duration", `This work session has been going for about ${durationWords(fields.sessionMs)}`);
  if (Number.isFinite(fields.contextPercent)) {
    add("context", `Claude's context window is about ${Math.round(fields.contextPercent / 10) * 10}% full`);
  }
  if (fields.awayMs >= 10 * MINUTE_MS) add("away", `The user was away from the computer for about ${durationWords(fields.awayMs)}`);
  if (fields.idleMs >= 3 * MINUTE_MS) add("idle", `Claude has been idle for about ${durationWords(fields.idleMs)}`);
  return out;
}

// Same facts as plain strings (what the prompt shows).
function backgroundFacts(fields = {}) {
  return factList(fields).map((fact) => fact.text);
}

function buildFactSheet({ trigger, focus = null, background = [] }) {
  const lines = [`TRIGGER: ${trigger}`];
  if (focus) lines.push(`FOCUS (your reply must be about this): ${focus}`);
  if (background.length > 0) {
    lines.push("Other facts (optional background):");
    for (const fact of background) lines.push(`- ${fact}`);
  }
  return lines.join("\n");
}

const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

// Values of spelled-out numbers in a text ("twenty-nine" -> 29, "forty" -> 40, "a hundred" -> 100).
function spelledNumbers(text) {
  const out = [];
  const lower = String(text).toLowerCase();
  for (const m of lower.matchAll(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s](one|two|three|four|five|six|seven|eight|nine))?\b/g)) {
    out.push(TENS[m[1]] + (m[2] ? UNITS[m[2]] : 0));
  }
  for (const m of lower.matchAll(/\b(eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/g)) out.push(TEENS[m[1]]);
  if (/\b(a|one) hundred\b/.test(lower)) out.push(100);
  return out;
}

const STOPWORDS = new Set("that this with from have your just like when then they them were been what into about while still some more than only even much very".split(" "));

// Content words that keep turning up in recent replies; the prompt asks the model to rest them.
function overusedWords(recent, limit = 6) {
  const counts = new Map();
  for (const part of recent) {
    for (const word of new Set(String(part).toLowerCase().match(/[a-z']{4,}/g) || [])) {
      if (!STOPWORDS.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
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
  // Digits are fine when the fact sheet itself contains that number; invented
  // numbers ("three hours of silence") are not. Spelled-out numbers are not checked.
  const known = new Set(String(options.factSheet || "").match(/\d+(?:\.\d+)?/g) || []);
  const digits = text.match(/\d+(?:\.\d+)?/g);
  if (digits && !digits.every((d) => known.has(d))) return { text, reason: "number" };
  // Spelled-out numbers above ten ("forty minutes") must also be in the facts;
  // small ones ("two tasks", "a minute or two") are left alone.
  if (options.factSheet !== undefined) {
    for (const value of spelledNumbers(text)) if (value > 10 && !known.has(String(value))) return { text, reason: "number" };
  }
  if (/\b(ai|language model)\b/i.test(text)) return { text, reason: "ai-mention" };
  if (/^claude[,!:]/i.test(text) || /,\s*claude[.!?]*$/i.test(text)) return { text, reason: "addresses-claude" };
  const history = [...(options.recent || []), ...(options.examples || [])];
  if (!options.lenient && tooSimilar(text, history, threshold)) return { text, reason: "repeat" };
  return { text, reason: null };
}

// A line over the limit is split at clause boundaries (commas, dashes, semicolons)
// instead of being thrown away; a fragment that is still too long is cut at a word.
function splitLong(piece, maxWords) {
  const count = (t) => t.split(/\s+/).filter(Boolean).length;
  if (count(piece) <= maxWords) return [piece];
  const clauses = piece.split(/(?<=[,;:\u2014\u2013])\s+|\s+[\u2014\u2013-]\s+/).map((c) => c.trim()).filter(Boolean);
  const out = [];
  let current = "";
  for (const clause of clauses) {
    const joined = current ? `${current} ${clause}` : clause;
    if (count(joined) <= maxWords) {
      current = joined;
    } else {
      if (current) out.push(current);
      current = clause;
    }
  }
  if (current) out.push(current);
  return out.map((fragment) => {
    const tokens = fragment.split(/\s+/);
    if (tokens.length <= maxWords) return fragment.replace(/[,;:\u2014\u2013-]+$/, "");
    return `${tokens.slice(0, maxWords).join(" ").replace(/[,;:\u2014\u2013-]+$/, "")}...`;
  });
}

// Turn raw model output into up to maxParts bubbles. A bad first line rejects the
// reply (the caller retries); a bad later line is simply dropped.
function cleanReply(raw, options = {}) {
  const maxParts = options.maxParts || DEFAULT_CONFIG.maxParts;
  const maxPerPart = options.maxWordsPerPart || DEFAULT_CONFIG.maxWordsPerPart;
  const maxTotal = options.maxTotalWords || DEFAULT_CONFIG.maxTotalWords;
  const text = String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  let pieces = text.split(/\r?\n+/)
    .map((piece) => piece.replace(/^\s*(?:[-*\u2022]+|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  // One run-on paragraph: split it into sentences instead.
  if (pieces.length === 1) {
    pieces = pieces[0].split(/(?<=[.!?])\s+(?=[A-Z"'])/).map((piece) => piece.trim()).filter(Boolean);
  }
  pieces = pieces.flatMap((piece) => splitLong(piece, maxPerPart));
  if (pieces.length === 0) return { parts: [], text: "", reason: "empty" };
  const parts = [];
  const seen = [...(options.recent || [])];
  let words = 0;
  for (const piece of pieces) {
    if (parts.length >= maxParts) break;
    const { text: line, reason } = cleanLine(piece, { ...options, maxWords: maxPerPart, recent: seen });
    if (reason) {
      if (parts.length === 0) return { parts: [], text: line, reason };
      continue;
    }
    const count = line.split(/\s+/).length;
    if (words + count > maxTotal) break;
    parts.push(line);
    seen.push(line);
    words += count;
  }
  return parts.length > 0
    ? { parts, text: parts.join(" "), reason: null }
    : { parts: [], text: "", reason: "empty" };
}

function resolvePersonality(settings = {}) {
  // Custom text applies only when "custom" is the chosen personality, so text
  // left in the box never overrides a built-in choice.
  const custom = settings.personality === "custom" && typeof settings.customPersonality === "string"
    ? settings.customPersonality.replace(/\s+/g, " ").trim().slice(0, MAX_CUSTOM_PERSONALITY_CHARS)
    : "";
  if (custom) {
    // Custom text only replaces the voice line; cast, rules and filters stay fixed.
    return { id: "custom", custom, persona: `Personality: ${custom}`, examples: [] };
  }
  const id = PERSONALITIES[settings.personality] ? settings.personality : DEFAULT_PERSONALITY;
  return { id, ...PERSONALITIES[id] };
}

// Four examples per prompt. Up to two are ones written for the current FOCUS
// (so the voice shows how to react to that kind of fact); the rest are random.
function pickExamples(personality, focusKey, random) {
  const tags = personality.exampleFocus;
  const pool = shuffled(personality.examples, random);
  const matching = tags && focusKey ? pool.filter((text) => (tags.get(text) || []).includes(focusKey)) : [];
  const picked = matching.slice(0, 2);
  for (const text of pool) {
    if (picked.length >= 4) break;
    if (!picked.includes(text)) picked.push(text);
  }
  return shuffled(picked, random);
}

function buildSystemPrompt(personality, random = Math.random, avoid = [], focusKey = null) {
  const shots = pickExamples(personality, focusKey, random);
  // A custom personality leads the prompt and decides the tone outright; the
  // built-in ones are a short voice line after the pet's intro.
  const voice = personality.custom
    ? `Your personality (this decides HOW you talk; stay in this character all the way, whatever it is): ${personality.custom}\n`
      + "You are a desktop pet that sits on the user's screen watching them work with an AI coding assistant. "
      + "Everything you say is about their work, their computer or what is going on around the desk."
    : personality.persona;
  let prompt = `${voice}\n${personality.custom ? CAST_CUSTOM : CAST}\n${RULES}`;
  if (personality.rules) prompt += `\nYour voice: ${personality.rules}`;
  if (shots.length > 0) {
    prompt += `\nExamples of your voice (other situations, never copy them):\n${shots.map((s) => `- ${s}`).join("\n")}`;
  }
  if (avoid.length >= 2) prompt += `\nWords you have overused lately, so do not use them this time: ${avoid.join(", ")}.`;
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
      return "The user just asked what you make of whatever is going on right now.";
    default:
      if (ctx.working && ctx.activity) return `Claude has been busy for a while, ${ctx.activity}.`;
      if (ctx.working) return "Claude has been busy for a while.";
      return "A quiet moment. Say something about whatever you notice.";
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

  const recentByPersonality = options.recentStore || new Map();
  const lastTriggerAt = new Map();
  let lastSpokeAt = null;
  let lastActivityAt = null;
  let status = "idle";
  let activity = null;
  let activityRun = 0;
  let testFails = 0;
  // Counters since the session began (reset when the user comes back after a long gap).
  const freshSession = (t) => ({
    startedAt: t, toolCalls: 0, edits: 0, commands: 0, reads: 0, helpers: 0, lookups: 0, other: 0,
    failures: 0, testsPassed: 0, testsFailed: 0, turns: 0, prompts: 0,
  });
  let session = freshSession(now());
  let contextPercent = null;
  // Rotation of the required FOCUS fact across replies.
  let focusCursor = 0;
  const recentFocus = [];
  const seedCache = new Map();
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

  // The required FOCUS: what the situation is about if it has an obvious subject,
  // otherwise the next fact in rotation, skipping the last few used so that
  // consecutive replies talk about different things.
  function pickFocus(name, facts) {
    if (facts.length === 0) return null;
    let chosen = (FOCUS_FOR_TRIGGER[name] || []).map((key) => facts.find((f) => f.key === key)).find(Boolean);
    if (!chosen) {
      let ordered = FOCUS_ORDER.map((key) => facts.find((f) => f.key === key)).filter(Boolean);
      // The time of day is background colour, not a subject, unless it is all there is.
      if (ordered.length > 1) ordered = ordered.filter((f) => f.key !== "time");
      const fresh = ordered.filter((f) => !recentFocus.includes(f.key));
      const pool = fresh.length > 0 ? fresh : ordered;
      chosen = pool[focusCursor % pool.length];
      focusCursor += 1;
    }
    recentFocus.push(chosen.key);
    while (recentFocus.length > 3) recentFocus.shift();
    return chosen;
  }

  function buildPrompt(name, details, settings, personality) {
    const t = now();
    const snapshot = getSnapshot() || {};
    const claude = claudeStatus(t);
    const working = claude === "working";
    const date = new Date(t);
    const trigger = triggerText(name, details, { working, activity: activity && activity.category });
    const fields = {
      mood: moodWords(snapshot.mood),
      claude,
      activity: activity && activity.category,
      time: timeBucket(date),
      music: snapshot.musicPlaying === true,
      song: settings.shareSong === false ? "" : snapshot.song,
      streak: testFails >= config.testStreak
        ? `tests have failed ${countWord(testFails)} times in a row`
        : (activity && activityRun >= config.activityStreak ? `many steps of ${activity.category} in a row` : null),
      session,
      sessionMs: t - session.startedAt,
      contextPercent,
      idleMs: working || lastActivityAt == null ? 0 : t - lastActivityAt,
      awayMs: details && details.awayMs,
    };
    const facts = factList(fields);
    const focus = pickFocus(name, facts);
    const others = facts.filter((f) => f !== focus).map((f) => f.text);
    const background = shuffled(others, random).slice(0, config.backgroundCount);
    return {
      focusKey: focus ? focus.key : null,
      factSheet: buildFactSheet({ trigger, focus: focus && focus.text, background }),
      system: buildSystemPrompt(personality, random, overusedWords(recentFor(personality.id)), focus ? focus.key : null),
    };
  }

  // A custom personality has no hand-written examples, so the model writes a few
  // lines in that voice once; they become its example pool (cached per text and model).
  async function withSeeds(personality, model) {
    const key = `${model}|${personality.persona}`;
    if (!seedCache.has(key)) {
      seedCache.set(key, []); // also marks the attempt, so a failure is not retried every reply
      try {
        const data = await post("/api/chat", {
          model,
          stream: false,
          think: false,
          keep_alive: config.keepAlive,
          options: { temperature: 1, num_predict: 200, num_ctx: config.numCtx },
          messages: [
            { role: "system", content: `Your personality (this decides HOW you talk; stay in this character all the way, whatever it is): ${personality.custom}\n${CAST_CUSTOM}` },
            { role: "user", content: `Write ${config.seedExamples} different things this character would say while watching a developer work with an AI coding assistant. Cover different situations: tests failing, tests passing, a long session, late at night, music playing, an error, a quiet moment, a big pile of edits. One per line, at most 14 words each, always in character. No numbering, no quotation marks, no emoji.` },
          ],
        }, warmedModels.has(model) ? config.requestTimeoutMs : config.warmTimeoutMs);
        warmedModels.add(model);
        const lines = [];
        for (const piece of String(data && data.message && data.message.content || "").split(/\r?\n+/)) {
          const { text, reason } = cleanLine(piece.replace(/^\s*(?:[-*\u2022]+|\d+[.)])\s*/, ""), { maxWords: 14, recent: lines });
          if (!reason) lines.push(text);
        }
        if (lines.length >= 3) seedCache.set(key, lines.slice(0, config.seedExamples));
        log(`chatter seeded examples=${lines.length >= 3 ? Math.min(lines.length, config.seedExamples) : 0} model=${model}`);
      } catch (err) {
        log(`chatter seeding failed error=${err && err.name === "AbortError" ? "timeout" : (err && err.message)}`);
      }
    }
    return { ...personality, examples: seedCache.get(key) };
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

  // One reply (one to three bubbles) for a trigger name, or null. No timers or
  // cooldowns: used by the speak path below and directly by the node probe.
  async function generate(name, details = {}, settings = getSettings() || {}) {
    const model = settings.model || config.model;
    let personality = resolvePersonality(settings);
    if (personality.id === "custom") personality = await withSeeds(personality, model);
    const { factSheet, system, focusKey } = buildPrompt(name, details, settings, personality);
    const recent = recentFor(personality.id);
    for (let attempt = 1; attempt <= config.maxTries; attempt++) {
      const data = await post("/api/chat", {
        model,
        stream: false,
        think: false,
        keep_alive: config.keepAlive,
        options: { temperature: config.temperature, num_predict: config.numPredict, num_ctx: config.numCtx },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${factSheet}\n\nWrite your reply: two short lines, one per line.` },
        ],
      }, warmedModels.has(model) ? config.requestTimeoutMs : config.warmTimeoutMs);
      warmedModels.add(model);
      const { parts, text, reason } = cleanReply(data && data.message && data.message.content, {
        maxParts: config.maxParts,
        maxWordsPerPart: config.maxWordsPerPart,
        maxTotalWords: config.maxTotalWords,
        similarity: config.similarity,
        recent,
        examples: personality.examples,
        factSheet,
        // The last try drops only the repeat check: a slightly familiar reply beats silence.
        lenient: attempt === config.maxTries,
      });
      if (!reason) return { text, parts, attempt, personality: personality.id, factSheet, focus: focusKey };
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
      recent.push(...result.parts);
      while (recent.length > config.recentLines * config.maxParts) recent.shift();
      log(`chatter trigger=${name} persona=${result.personality} try=${result.attempt} focus=${result.focus || "none"} line=${result.parts.join(" / ")} facts=${result.factSheet.replace(/\n/g, " | ")}`);
      onLine({ text: result.text, parts: result.parts, trigger: name, personality: result.personality });
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
    const { event, testResult, failureKind, toolName, contextPercent: ctxPercent } = input || {};
    const gap = lastActivityAt == null ? 0 : t - lastActivityAt;
    lastActivityAt = t;
    if (gap >= config.awayMs) {
      session = freshSession(t);
      notify("user-returned", { awayMs: gap });
    }
    if (Number.isFinite(ctxPercent)) contextPercent = Math.max(0, Math.min(100, ctxPercent));
    // Counts only: which kind of tool call happened, never which tool input.
    if (event === "PostToolUse" || event === "PostToolUseFailure") {
      session.toolCalls += 1;
      const key = categoryKey(toolName);
      if (key) session[key] += 1;
      if (event === "PostToolUseFailure") session.failures += 1;
    } else if (event === "UserPromptSubmit") {
      session.prompts += 1;
    }

    const category = activityFromTool(toolName);
    if (category) {
      // Each tool call reports twice (Pre and Post); count the run on Post only.
      if (!activity || activity.category !== category) activityRun = 0;
      activity = { category };
      if (event === "PostToolUse" || event === "PostToolUseFailure") activityRun += 1;
    }
    if (event === "Stop" && failureKind !== "api_error") {
      status = "finished";
      session.turns += 1;
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
      session.testsFailed += 1;
    } else if (testResult === "pass") {
      session.testsPassed += 1;
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
  cleanReply,
  spelledNumbers,
  overusedWords,
  factList,
  FOCUS_ORDER,
  resolvePersonality,
  buildSystemPrompt,
  TRIGGER_SWITCH,
  createChatter,
};
