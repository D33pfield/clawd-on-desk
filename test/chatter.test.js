"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_CONFIG,
  PERSONALITIES,
  activityFromTool,
  timeBucket,
  moodWords,
  backgroundFacts,
  buildFactSheet,
  cleanLine,
  resolvePersonality,
  buildSystemPrompt,
  createChatter,
} = require("../src/chatter");

describe("activityFromTool", () => {
  it("maps tool names to coarse categories and keeps nothing else", () => {
    assert.strictEqual(activityFromTool("Read"), "reading and searching the code");
    assert.strictEqual(activityFromTool("Edit"), "editing files");
    assert.strictEqual(activityFromTool("Bash"), "running commands in the terminal");
    assert.strictEqual(activityFromTool("Task"), "waiting on a helper agent");
    assert.strictEqual(activityFromTool("SomethingNew"), "using a tool");
    assert.strictEqual(activityFromTool(""), null);
    assert.strictEqual(activityFromTool(undefined), null);
  });
});

describe("timeBucket", () => {
  it("buckets the hour, not the clock time", () => {
    const at = (h) => timeBucket(new Date(2026, 9, 24, h, 30));
    assert.strictEqual(at(8), "morning");
    assert.strictEqual(at(14), "afternoon");
    assert.strictEqual(at(18), "evening");
    assert.strictEqual(at(22), "late evening");
    assert.strictEqual(at(2), "the middle of the night");
  });
});

describe("moodWords", () => {
  it("leaves calm channels out and never emits numbers", () => {
    assert.strictEqual(moodWords({ stress: 0.1, satisfaction: 0, fatigue: 0, boredom: 0 }), null);
    assert.strictEqual(moodWords({ stress: 0.5, satisfaction: 0.9, fatigue: 0, boredom: 0 }), "a little stressed, very pleased");
    assert.strictEqual(moodWords(null), null);
    assert.ok(!/\d/.test(moodWords({ stress: 0.8, satisfaction: 0.4, fatigue: 0.9, boredom: 0.5 })));
  });
});

describe("fact sheet", () => {
  it("only formats whitelisted fields", () => {
    const lines = backgroundFacts({
      mood: "bored", claude: "working", activity: "editing files", time: "morning", music: true,
      command: "SENTINEL_COMMAND", filePath: "SENTINEL_PATH", prompt: "SENTINEL_PROMPT",
    });
    assert.deepStrictEqual(lines, [
      "Mood: bored", "Claude: working, currently editing files", "Time: morning", "Music: playing",
    ]);
    assert.ok(!lines.join("\n").match(/SENTINEL/));
  });

  it("leaves music out when it is off, and renders the trigger first", () => {
    assert.deepStrictEqual(backgroundFacts({ claude: "idle", music: false }), ["Claude: idle"]);
    const sheet = buildFactSheet({ trigger: "Music just started playing.", background: ["Time: morning"] });
    assert.strictEqual(sheet, "TRIGGER: Music just started playing.\nOther facts (optional background):\n- Time: morning");
    assert.strictEqual(buildFactSheet({ trigger: "x" }), "TRIGGER: x");
  });
});

describe("cleanLine", () => {
  it("keeps the first line and strips quotes, markdown and emoji", () => {
    assert.strictEqual(cleanLine('"Still here. Still orange."\nextra').text, "Still here. Still orange.");
    assert.strictEqual(cleanLine("**Nice work!** \u{1F389}").text, "Nice work!");
    assert.strictEqual(cleanLine("<think>hmm</think>Fine.").text, "Fine.");
  });

  it("rejects empty, long, numeric, AI, Claude-address and repeated lines", () => {
    assert.strictEqual(cleanLine("").reason, "empty");
    assert.strictEqual(cleanLine("one two three four five six seven eight nine ten eleven twelve thirteen").reason, "too-long");
    assert.strictEqual(cleanLine("Three hours in, 3 tests left.").reason, "number");
    assert.strictEqual(cleanLine("As an AI I cannot say.").reason, "ai-mention");
    assert.strictEqual(cleanLine("Claude, please hurry.").reason, "addresses-claude");
    assert.strictEqual(cleanLine("Hope the helper finishes quickly, Claude.").reason, "addresses-claude");
    assert.strictEqual(cleanLine("Claude is busy and I am fine.").reason, null);
    assert.strictEqual(cleanLine("Fine, I suppose.", { recent: ["Fine, I suppose."] }).reason, "repeat");
    assert.strictEqual(
      cleanLine("Another file edited. The suspense is huge.", { examples: PERSONALITIES.deadpan.examples }).reason,
      "repeat"
    );
  });
});

describe("personality", () => {
  it("defaults to deadpan and accepts a known id", () => {
    assert.strictEqual(resolvePersonality({}).id, "deadpan");
    assert.strictEqual(resolvePersonality({ personality: "anxious" }).id, "anxious");
    assert.strictEqual(resolvePersonality({ personality: "nope" }).id, "deadpan");
  });

  it("custom text replaces only the voice line; cast and rules stay", () => {
    const personality = resolvePersonality({ personality: "custom", customPersonality: "  A grumpy\npirate.  " });
    assert.strictEqual(personality.id, "custom");
    assert.match(personality.persona, /Personality: A grumpy pirate\./);
    const prompt = buildSystemPrompt(personality);
    assert.match(prompt, /Cast: you are Clawd/);
    assert.match(prompt, /at most 12 words/);
    assert.ok(!prompt.includes("Examples of your voice"));
  });

  it("ignores leftover custom text unless custom is the chosen personality", () => {
    const text = "A grumpy pirate.";
    assert.strictEqual(resolvePersonality({ personality: "anxious", customPersonality: text }).id, "anxious");
    assert.strictEqual(resolvePersonality({ customPersonality: text }).id, "deadpan");
    assert.strictEqual(resolvePersonality({ personality: "custom", customPersonality: "   " }).id, "deadpan");
  });

  it("clips very long custom text", () => {
    const personality = resolvePersonality({ personality: "custom", customPersonality: "x".repeat(2000) });
    assert.ok(personality.persona.length < 450);
  });

  it("samples four examples per prompt", () => {
    const prompt = buildSystemPrompt(resolvePersonality({}));
    assert.strictEqual(prompt.split("\n- ").length - 1, 4);
  });
});

describe("createChatter", () => {
  function fakeTimers() {
    const pending = [];
    return {
      pending,
      setTimeout: (fn, ms) => { const handle = { fn, ms, cleared: false }; pending.push(handle); return handle; },
      clearTimeout: (handle) => { if (handle) handle.cleared = true; },
      fireNext() {
        const handle = pending.find((h) => !h.cleared && !h.fired);
        if (handle) { handle.fired = true; handle.fn(); }
      },
    };
  }

  // Replies come from a queue; a function reply can inspect the request.
  function setup(replies, extra = {}) {
    const timers = fakeTimers();
    const lines = [];
    const requests = [];
    const logs = [];
    const queue = [...replies];
    let t = 1_000_000;
    const clock = { advance: (ms) => { t += ms; }, now: () => t };
    const chatter = createChatter({
      timers,
      now: clock.now,
      random: () => 0,
      log: (msg) => logs.push(msg),
      onLine: (line) => lines.push(line),
      getSnapshot: () => ({ mood: { stress: 0, satisfaction: 0.8, fatigue: 0, boredom: 0 }, musicPlaying: true }),
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url, body });
        const next = queue.shift();
        if (next instanceof Error) throw next;
        if (next && next.status) return { ok: false, status: next.status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ message: { content: next === undefined ? "Fine." : next } }) };
      },
      ...extra,
    });
    return { chatter, timers, lines, requests, logs, clock };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("sends a stateless, thinking-off chat with the configured model and a small context", async () => {
    const { chatter, requests } = setup(["Hello there, friend."]);
    const result = await chatter.generate("idle-check");
    assert.strictEqual(result.text, "Hello there, friend.");
    const { url, body } = requests[0];
    assert.strictEqual(url, `${DEFAULT_CONFIG.baseUrl}/api/chat`);
    assert.strictEqual(body.model, DEFAULT_CONFIG.model);
    assert.strictEqual(body.think, false);
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.options.num_ctx, 2048);
    assert.strictEqual(body.keep_alive, DEFAULT_CONFIG.keepAlive);
    assert.deepStrictEqual(body.messages.map((m) => m.role), ["system", "user"]);
  });

  it("uses the model from settings", async () => {
    const { chatter, requests } = setup(["Hello there, friend."], { getSettings: () => ({ enabled: true, model: "qwen3.5:4b" }) });
    await chatter.generate("idle-check");
    assert.strictEqual(requests[0].body.model, "qwen3.5:4b");
  });

  it("retries a rejected line and gives up after maxTries", async () => {
    const retried = setup(["Claude, hurry up.", "Fine, I suppose."]);
    assert.strictEqual((await retried.chatter.generate("idle-check")).attempt, 2);
    const gaveUp = setup(["one 1", "two 2", "three 3"]);
    assert.strictEqual(await gaveUp.chatter.generate("idle-check"), null);
    assert.strictEqual(gaveUp.requests.length, DEFAULT_CONFIG.maxTries);
  });

  it("keeps command text and tool names out of the prompt", async () => {
    const { chatter, requests } = setup(["Hello there, friend."]);
    chatter.observe({ event: "PreToolUse", toolName: "Bash", command: "SENTINEL_COMMAND", filePath: "SENTINEL_PATH" });
    await chatter.generate("idle-check");
    const text = JSON.stringify(requests[0].body.messages);
    assert.match(text, /running commands in the terminal/);
    assert.ok(!text.match(/SENTINEL|Bash/));
  });

  it("speaks when tests pass after failures, then respects the cooldown", async () => {
    const { chatter, lines, clock, requests } = setup(["Finally, a green one.", "Green again, nice."]);
    chatter.observe({ event: "PostToolUse", testResult: "fail" });
    chatter.observe({ event: "PostToolUse", testResult: "fail" });
    chatter.observe({ event: "PostToolUse", testResult: "pass" });
    await flush();
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].trigger, "tests-pass-after-fails");
    assert.match(requests[0].body.messages[1].content, /after two failures in a row/);

    clock.advance(2 * 60 * 1000); // past the global gap, inside the trigger cooldown
    chatter.observe({ event: "PostToolUse", testResult: "fail" });
    chatter.observe({ event: "PostToolUse", testResult: "fail" });
    chatter.observe({ event: "PostToolUse", testResult: "pass" });
    await flush();
    assert.strictEqual(lines.length, 1);
  });

  it("counts a same-activity run once per tool call, not once per hook event", async () => {
    const { chatter, requests } = setup(["Hello there, friend.", "Hello again, friend."], { config: { backgroundCount: 10 } });
    const call = () => {
      chatter.observe({ event: "PreToolUse", toolName: "Edit" });
      chatter.observe({ event: "PostToolUse", toolName: "Edit" });
    };
    for (let i = 0; i < 4; i++) call();
    await chatter.generate("idle-check");
    assert.ok(!requests[0].body.messages[1].content.includes("Streak"), "four calls is not yet a streak");
    call();
    await chatter.generate("idle-check");
    assert.match(requests[1].body.messages[1].content, /Streak: many steps of editing files in a row/);
  });

  it("a single failure then a pass is not a trigger", async () => {
    const { chatter, lines } = setup(["Nice."]);
    chatter.observe({ event: "PostToolUse", testResult: "fail" });
    chatter.observe({ event: "PostToolUse", testResult: "pass" });
    await flush();
    assert.strictEqual(lines.length, 0);
  });

  it("speaks on a stop failure and when the user returns after a long gap", async () => {
    const { chatter, lines, clock } = setup(["That did not go well.", "Oh, hello again."]);
    chatter.observe({ event: "StopFailure" });
    await flush();
    assert.strictEqual(lines[0].trigger, "stop-failure");
    clock.advance(2 * 60 * 60 * 1000);
    chatter.observe({ event: "SessionStart" });
    await flush();
    assert.strictEqual(lines[1].trigger, "user-returned");
  });

  it("never runs two requests at once, and enforces the global gap", async () => {
    const { chatter, lines, clock } = setup(["First line here.", "Second line here."]);
    chatter.notify("music-started");
    chatter.notify("stop-failure");
    assert.strictEqual(chatter.isBusy(), true);
    await flush();
    assert.strictEqual(lines.length, 1);
    clock.advance(10 * 1000);
    chatter.notify("user-returned");
    await flush();
    assert.strictEqual(lines.length, 1, "inside the minimum gap");
  });

  it("drops a forced line that arrives too late, but keeps a late timer line", async () => {
    function slowSetup() {
      const timers = fakeTimers();
      const lines = [];
      let t = 5_000_000;
      const chatter = createChatter({
        timers,
        now: () => t,
        random: () => 0,
        onLine: (line) => lines.push(line),
        fetch: async () => {
          t += 60 * 1000; // the reply takes longer than staleMs
          return { ok: true, json: async () => ({ message: { content: "Late line here." } }) };
        },
      });
      return { chatter, lines, timers };
    }

    const forced = slowSetup();
    forced.chatter.notify("music-started");
    await flush();
    assert.strictEqual(forced.lines.length, 0, "a stale forced line is dropped");

    const timed = slowSetup();
    timed.chatter.observe({ event: "PostToolUse", toolName: "Edit" });
    timed.chatter.start();
    timed.timers.fireNext();
    await flush();
    assert.strictEqual(timed.lines.length, 1, "a slow check-in line is still shown");
    assert.strictEqual(timed.lines[0].trigger, "idle-check");
    timed.chatter.stop();
  });

  it("stays silent when disabled, when canSpeak is false, and when Ollama fails", async () => {
    const off = setup(["Hello there."], { getSettings: () => ({ enabled: false }) });
    off.chatter.notify("music-started");
    await flush();
    assert.strictEqual(off.lines.length, 0);
    assert.strictEqual(off.requests.length, 0);

    const busy = setup(["Hello there."], { canSpeak: () => false });
    busy.chatter.notify("music-started");
    await flush();
    assert.strictEqual(busy.requests.length, 0);

    const down = setup([new Error("connect ECONNREFUSED"), { status: 500 }]);
    down.chatter.notify("music-started");
    await flush();
    assert.strictEqual(down.lines.length, 0);
    assert.strictEqual(down.chatter.isBusy(), false);
    assert.ok(down.logs.some((m) => m.startsWith("chatter failed")));
  });

  it("only rolls the check-in timer while the user is around", async () => {
    const { chatter, timers, lines, requests, clock } = setup(["Just checking in."]);
    chatter.start();
    assert.strictEqual(timers.pending.length, 1);
    const [min, max] = DEFAULT_CONFIG.intervalMs;
    assert.ok(timers.pending[0].ms >= min && timers.pending[0].ms <= max);

    timers.fireNext(); // nobody around: nothing sent, next roll scheduled
    await flush();
    assert.strictEqual(requests.length, 0);
    assert.ok(timers.pending.some((h) => !h.cleared && !h.fired));

    chatter.observe({ event: "PostToolUse", toolName: "Edit" });
    clock.advance(10 * 60 * 1000);
    timers.fireNext();
    await flush();
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].trigger, "idle-check");
    chatter.stop();
    assert.ok(timers.pending.every((h) => h.cleared || h.fired));
  });

  it("each trigger has its own switch, checked before chance and cooldown are used", async () => {
    let triggers = { music: false };
    const { chatter, lines, requests } = setup(["Hello there, friend."], {
      getSettings: () => ({ enabled: true, triggers }),
    });
    assert.strictEqual(chatter.notify("music-started"), false);
    await flush();
    assert.strictEqual(requests.length, 0);
    triggers = { music: true };
    assert.strictEqual(chatter.notify("music-started"), true, "the earlier refusal did not use the cooldown");
    await flush();
    assert.strictEqual(lines.length, 1);

    triggers = { tests: false, error: false, return: false };
    const off = setup(["Hello there, friend."], { getSettings: () => ({ enabled: true, triggers }) });
    off.chatter.observe({ event: "StopFailure" });
    await flush();
    assert.strictEqual(off.requests.length, 0);
  });

  it("a switched-off check-in skips the timer roll and keeps the timer running", async () => {
    const { chatter, timers, requests } = setup(["Just checking in."], {
      getSettings: () => ({ enabled: true, triggers: { checkin: false } }),
    });
    chatter.observe({ event: "PostToolUse", toolName: "Edit" });
    chatter.start();
    timers.fireNext();
    await flush();
    assert.strictEqual(requests.length, 0);
    assert.ok(timers.pending.some((h) => !h.cleared && !h.fired), "the next roll is still scheduled");
  });

  it("takes the check-in interval from settings and reschedules when it changes", () => {
    let minutes = 10;
    const { chatter, timers } = setup([], { getSettings: () => ({ enabled: true, checkinMinutes: minutes }) });
    chatter.start();
    const first = timers.pending[0];
    assert.strictEqual(first.ms, 10 * 60 * 1000 * 0.7, "random() is 0, so the low end of +-30%");
    minutes = 60;
    chatter.reschedule();
    assert.ok(first.cleared, "the old timer is cancelled");
    assert.strictEqual(timers.pending.at(-1).ms, 60 * 60 * 1000 * 0.7);
    chatter.stop();
    chatter.reschedule(); // stopped: must not start a timer
    assert.strictEqual(timers.pending.filter((h) => !h.cleared).length, 0);
  });

  it("a new model gets the long first-load timeout, not the warm one", async () => {
    let model = "model-a";
    const delays = [];
    const timers = { setTimeout: (fn, ms) => { delays.push(ms); return { fn }; }, clearTimeout: () => {} };
    const chatter = createChatter({
      timers,
      random: () => 0,
      getSettings: () => ({ enabled: true, model }),
      fetch: async () => ({ ok: true, json: async () => ({ message: { content: "Fine, I suppose." } }) }),
    });
    await chatter.generate("idle-check");
    await chatter.generate("idle-check");
    model = "model-b";
    await chatter.generate("idle-check");
    assert.deepStrictEqual(delays, [
      DEFAULT_CONFIG.warmTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, DEFAULT_CONFIG.warmTimeoutMs,
    ]);
  });

  it("lists installed models sorted, with the default, and reports failures instead of throwing", async () => {
    const calls = [];
    const make = (fetch) => createChatter({ fetch, timers: fakeTimers() });
    const listed = make(async (url, init) => {
      calls.push({ url, method: init.method });
      return { ok: true, json: async () => ({ models: [{ name: "zeta:1b" }, { name: "alpha:7b" }, { nope: 1 }, null] }) };
    });
    const result = await listed.listModels();
    assert.deepStrictEqual(result, { ok: true, models: ["alpha:7b", "zeta:1b"], defaultModel: DEFAULT_CONFIG.model });
    assert.strictEqual(calls[0].url, `${DEFAULT_CONFIG.baseUrl}/api/tags`);
    assert.ok(!calls[0].method, "a plain GET");

    const down = await make(async () => { throw new Error("connect ECONNREFUSED"); }).listModels();
    assert.strictEqual(down.ok, false);
    assert.deepStrictEqual(down.models, []);
    assert.match(down.error, /ECONNREFUSED/);
    assert.strictEqual(down.defaultModel, DEFAULT_CONFIG.model);

    const bad = await make(async () => ({ ok: false, status: 500, json: async () => ({}) })).listModels();
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /500/);
  });

  it("sayNow() answers a hotkey at once: no minimum gap, no trigger switch, no staleness drop", async () => {
    const { chatter, lines, clock, requests } = setup(["First line here.", "Second line here."], {
      getSettings: () => ({ enabled: true, triggers: { checkin: false, music: false } }),
    });
    chatter.notify("music-started");
    await flush();
    assert.strictEqual(lines.length, 0, "the switched-off music line stays quiet");
    const first = await chatter.sayNow();
    assert.strictEqual(first.text, "First line here.");
    assert.match(requests[0].body.messages[1].content, /TRIGGER: The user just asked you to say something\./);
    clock.advance(1000); // far inside the 90 s minimum gap
    const second = await chatter.sayNow();
    assert.strictEqual(second.text, "Second line here.");
    assert.deepStrictEqual(lines.map((l) => l.trigger), ["hotkey", "hotkey"]);
  });

  it("sayNow() still respects the master switch, canSpeak and a request already running", async () => {
    const off = setup(["Hello there."], { getSettings: () => ({ enabled: false }) });
    assert.strictEqual(await off.chatter.sayNow(), null);
    assert.strictEqual(off.requests.length, 0);

    const blocked = setup(["Hello there."], { canSpeak: () => false });
    assert.strictEqual(await blocked.chatter.sayNow(), null);
    assert.strictEqual(blocked.requests.length, 0);

    const busy = setup(["Hello there, friend.", "Another line here."]);
    const running = busy.chatter.sayNow();
    assert.strictEqual(await busy.chatter.sayNow(), null, "a second press while one is running is ignored");
    assert.ok(await running);
  });

  it("unload() asks Ollama to drop the model, and the next request gets the long timeout again", async () => {
    const delays = [];
    const timers = { setTimeout: (fn, ms) => { delays.push(ms); return { fn }; }, clearTimeout: () => {} };
    const bodies = [];
    const chatter = createChatter({
      timers,
      random: () => 0,
      fetch: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ message: { content: "Fine, I suppose." } }) };
      },
    });
    await chatter.generate("idle-check");
    assert.strictEqual(await chatter.unload(), true);
    assert.deepStrictEqual(bodies.at(-1), { model: DEFAULT_CONFIG.model, keep_alive: 0 });
    await chatter.generate("idle-check");
    assert.strictEqual(delays.at(-1), DEFAULT_CONFIG.warmTimeoutMs, "the model must be loaded again");
    const failing = createChatter({ fetch: async () => { throw new Error("down"); }, timers });
    assert.strictEqual(await failing.unload(), false);
  });

  it("warm() loads the model with a long timeout and swallows errors", async () => {
    const ok = setup([""]);
    assert.strictEqual(await ok.chatter.warm(), true);
    assert.strictEqual(ok.requests[0].body.model, DEFAULT_CONFIG.model);
    assert.ok(!("messages" in ok.requests[0].body));
    assert.strictEqual(ok.requests[0].body.options.num_ctx, DEFAULT_CONFIG.numCtx, "must match real requests or Ollama reloads");
    const bad = setup([new Error("down")]);
    assert.strictEqual(await bad.chatter.warm(), false);
  });
});

describe("chatter wiring", () => {
  it("keeps raw hook fields out of observe()", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "chatter.js"), "utf8");
    // observe() destructures only these fields from the hook input.
    assert.match(source, /const \{ event, testResult, failureKind, toolName \} = input \|\| \{\};/);
  });
});
