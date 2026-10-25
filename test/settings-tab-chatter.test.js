"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { PERSONALITY_IDS } = require("../src/chatter-personalities");
const { CHATTER_FONT_IDS } = require("../src/chatter-fonts");
const { MAX_CUSTOM_PERSONALITY_CHARS } = require("../src/chatter-limits");

const TAB_SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "settings-tab-chatter.js"), "utf8");

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.className = "";
    this.textContent = "";
    this.value = "";
  }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attrs = { ...(this.attrs || {}), [name]: value }; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  fire(type) { const fn = this.listeners.get(type); if (fn) fn({ type }); }
}

function load({ snapshot = {}, models = { ok: true, models: ["alpha:1b", "beta:7b"], defaultModel: "alpha:1b" }, update, awarenessStatus } = {}) {
  const built = { switches: [], numbers: [], selects: [], inputs: [], buttons: [] };
  const updates = [];
  const renders = [];
  const toasts = [];
  let modelCalls = 0;
  const api = {
    update: (key, value) => { updates.push({ key, value }); return update ? update(key, value) : Promise.resolve({ status: "ok" }); },
    getChatterModels: () => { modelCalls += 1; return Promise.resolve(models); },
    getAwarenessStatus: () => Promise.resolve(awarenessStatus || { ok: true, model: "m:1b", vision: true, lastSeen: "" }),
  };
  const context = { globalThis: null, window: { settingsAPI: api }, document: { createElement: (tag) => new FakeNode(tag) } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(TAB_SOURCE, context);

  const core = {
    state: { snapshot },
    helpers: {
      t: (key) => key,
      buildSection: (title, rows) => { const node = new FakeNode("section"); node.title = title; node.children = rows; return node; },
      buildSettingRow: (config) => {
        const element = new FakeNode("row");
        const textElement = new FakeNode("text");
        const controlElement = new FakeNode("control");
        element.config = config;
        element.children = [textElement, controlElement];
        return { element, textElement, controlElement, labelElement: { id: "label" }, descriptionElement: { id: "desc" } };
      },
      buildSwitchRow: (config) => { built.switches.push(config); const node = new FakeNode("switchRow"); node.config = config; return node; },
      buildNumberInputRow: (config) => { built.numbers.push(config); const row = new FakeNode("numberRow"); row.config = config; return { row }; },
      buildSettingsSelect: (config) => {
        built.selects.push(config);
        const control = { element: Object.assign(new FakeNode("select"), { config }), disabled: false };
        control.setDisabled = (value) => { control.disabled = value; config.disabled = value; };
        return control;
      },
      buildTextInput: (config) => { const input = new FakeNode("input"); input.config = config; input.value = config.value || ""; input.blur = () => input.fire("blur"); built.inputs.push(input); return input; },
      buildButton: (config) => { const button = new FakeNode("button"); button.config = config; built.buttons.push(button); return button; },
    },
    ops: { requestRender: (payload) => renders.push(payload), showToast: (...args) => toasts.push(args) },
    tabs: {
      shortcuts: { buildRow: (actionId) => { const row = new FakeNode("shortcutRow"); row.actionId = actionId; return row; } },
    },
  };
  context.ClawdSettingsTabChatter.init(core);
  const render = () => { const parent = new FakeNode("main"); core.tabs.chatter.render(parent); return parent; };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { core, render, built, updates, renders, toasts, flush, modelCalls: () => modelCalls };
}

// Objects built inside the vm context have another prototype; compare plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const sectionKeys = (parent) => parent.children.filter((c) => c.tag === "section");

describe("chatter settings tab", () => {
  it("registers itself as the chatter tab", () => {
    const { core } = load();
    assert.equal(typeof core.tabs.chatter.render, "function");
  });

  it("builds the master switch, the bubble switch and one switch per situation, bound to the prefs", () => {
    const harness = load();
    harness.render();
    assert.deepEqual(harness.built.switches.map((s) => s.key), [
      "chatterEnabled", "chatterShowBubbles", "chatterTriggerCheckin", "chatterTriggerTests",
      "chatterTriggerError", "chatterTriggerReturn", "chatterTriggerMusic", "chatterShareSong",
      "desktopAwareness", "desktopAwarenessArmed", "desktopAwarenessLogLines",
    ]);
    for (const config of harness.built.switches) {
      assert.ok(config.labelKey && config.descKey, `${config.key} has a label and description`);
    }
  });

  it("puts the master Chatter switch first and the less important Speech bubbles switch under Timing", () => {
    const harness = load();
    const parent = harness.render();
    const sections = sectionKeys(parent);
    assert.deepEqual(plain(sections.map((s) => s.title)), [
      "sectionChatterGeneral", "sectionChatterVoice", "sectionChatterTiming", "sectionChatterTriggers", "sectionChatterContext", "sectionChatterAwareness", "sectionChatterHotkey",
    ]);
    const first = sections[0].children;
    assert.equal(first.length, 1);
    assert.equal(first[0].config.key, "chatterEnabled");
    assert.equal(first[0].config.labelKey, "rowChatterEnabled");
    const timing = sections[2].children.map((row) => row.config.key);
    assert.deepEqual(plain(timing), ["chatterCheckinMinutes", "chatterBubbleSeconds", "chatterShowBubbles", null]);
    assert.equal(sections[2].children.at(-2).config.labelKey, "rowChatterShowBubbles");
    assert.equal(sections[2].children.at(-1).config.labelKey, "rowChatterFont", "the font row closes Timing");
  });

  it("greys out everything that depends on the master switch while chatter is off", () => {
    const off = load({ snapshot: { chatterEnabled: false, chatterPersonality: "deadpan" } });
    off.render();
    for (const config of off.built.switches) {
      assert.equal(config.disabled, config.key === "chatterEnabled" ? false : true, config.key);
    }
    assert.equal(off.built.selects[0].disabled, true, "personality");
    const on = load({ snapshot: { chatterEnabled: true } });
    on.render();
    const awarenessKeys = ["desktopAwarenessArmed", "desktopAwarenessLogLines"];
    for (const config of on.built.switches) {
      assert.equal(config.disabled, awarenessKeys.includes(config.key), `${config.key}: only the awareness options wait for the first awareness switch`);
    }
    assert.equal(on.built.selects[0].disabled, false);
  });

  it("shows the Shortcuts tab's own row for the say-something hotkey", () => {
    const harness = load();
    const parent = harness.render();
    const hotkey = sectionKeys(parent).find((s) => s.title === "sectionChatterHotkey");
    assert.equal(hotkey.children.length, 1);
    assert.equal(hotkey.children[0].actionId, "chatterNow");
  });

  it("builds the timing rows with the same ranges the prefs accept", () => {
    const harness = load();
    harness.render();
    const byKey = Object.fromEntries(harness.built.numbers.map((n) => [n.key, n]));
    assert.deepEqual([byKey.chatterCheckinMinutes.min, byKey.chatterCheckinMinutes.max], [2, 180]);
    assert.deepEqual([byKey.chatterBubbleSeconds.min, byKey.chatterBubbleSeconds.max], [3, 60]);
    assert.equal(byKey.chatterCheckinMinutes.unitKey, "unitMinutes");
    assert.equal(byKey.chatterBubbleSeconds.unitKey, "unitSeconds");
    // Display equals stored here (minutes and seconds are stored as such), clamped to the range.
    assert.equal(byKey.chatterBubbleSeconds.fromDisplay(500), 60);
    assert.equal(byKey.chatterCheckinMinutes.fromDisplay(1), 2);
    assert.equal(byKey.chatterCheckinMinutes.toDisplay(12), 12);
  });

  it("offers every personality and saves the choice", async () => {
    const harness = load({ snapshot: { chatterPersonality: "anxious" } });
    harness.render();
    const personality = harness.built.selects[0];
    assert.deepEqual(plain(personality.options.map((o) => o.value)), [...PERSONALITY_IDS, "custom"]);
    assert.equal(personality.value, "anxious");
    assert.equal(await personality.onChange("wholesome"), true);
    assert.deepEqual(plain(harness.updates), [{ key: "chatterPersonality", value: "wholesome" }]);
    assert.equal(personality.onChange("anxious"), true, "choosing the current value saves nothing");
    assert.equal(harness.updates.length, 1);
  });

  it("shows the custom-text row only when custom is selected", () => {
    const hidden = load({ snapshot: { chatterPersonality: "wholesome", chatterCustomPersonality: "leftover" } });
    hidden.render();
    assert.equal(hidden.built.inputs.length, 0);
    const shown = load({ snapshot: { chatterPersonality: "custom", chatterCustomPersonality: "a grumpy pirate" } });
    shown.render();
    assert.equal(shown.built.inputs.length, 1);
    assert.equal(shown.built.inputs[0].value, "a grumpy pirate");
    assert.equal(shown.built.inputs[0].config.maxLength, "300");
  });

  it("commits custom text on Enter or blur only, keeps a draft across re-renders, and trims", async () => {
    const harness = load({ snapshot: { chatterPersonality: "custom", chatterCustomPersonality: "old" } });
    harness.render();
    let input = harness.built.inputs[0];
    input.value = "  a grumpy pirate  ";
    input.fire("input");
    assert.equal(harness.updates.length, 0, "typing alone saves nothing");

    harness.render(); // another setting changed and the tab re-rendered mid-typing
    input = harness.built.inputs[1];
    assert.equal(input.value, "  a grumpy pirate  ", "the draft survives the re-render");

    input.config.onEnter();
    await harness.flush();
    assert.deepEqual(plain(harness.updates), [{ key: "chatterCustomPersonality", value: "a grumpy pirate" }]);
  });

  it("does not save custom text that did not change", () => {
    const harness = load({ snapshot: { chatterPersonality: "custom", chatterCustomPersonality: "same" } });
    harness.render();
    const input = harness.built.inputs[0];
    input.value = "same";
    input.fire("input");
    input.fire("blur");
    assert.equal(harness.updates.length, 0);
  });

  it("lists installed models next to the default and keeps a saved model selectable", async () => {
    const harness = load({ snapshot: { chatterModel: "gone:3b" } });
    harness.render();
    assert.equal(harness.modelCalls(), 1);
    await harness.flush();
    assert.deepEqual(plain(harness.renders.at(-1)), { content: true });
    harness.render();
    const model = harness.built.selects[6];
    assert.deepEqual(plain(model.options.map((o) => o.value)), ["", "beta:7b", "gone:3b"]);
    assert.equal(model.options[0].label, "chatterModelDefault (alpha:1b)");
    assert.equal(model.value, "gone:3b");
    assert.equal(await model.onChange("beta:7b"), true);
    assert.deepEqual(plain(harness.updates), [{ key: "chatterModel", value: "beta:7b" }]);
    assert.equal(harness.modelCalls(), 1, "the list is fetched once, not on every render");
  });

  it("says so when Ollama cannot be reached, and Refresh asks again", async () => {
    const harness = load({ models: { ok: false, models: [], defaultModel: "alpha:1b", error: "timeout" } });
    harness.render();
    await harness.flush();
    const parent = harness.render();
    const voice = sectionKeys(parent).find((s) => s.title === "sectionChatterVoice");
    const modelRow = voice.children.at(-1);
    const status = modelRow.children[0].children.at(-1);
    assert.equal(status.textContent, "chatterModelUnreachable (timeout)");

    const refresh = harness.built.buttons.at(-1);
    assert.equal(refresh.config.labelKey, "chatterModelRefresh");
    refresh.fire("click");
    assert.deepEqual(plain(harness.renders.at(-1)), { content: true });
    harness.render();
    assert.equal(harness.modelCalls(), 2);
  });

  it("toasts when a save fails", async () => {
    const harness = load({ update: () => Promise.resolve({ status: "error", message: "nope" }) });
    harness.render();
    assert.equal(await harness.built.selects[0].onChange("custom"), false);
    assert.match(harness.toasts[0][0], /toastSaveFailednope/);
    assert.deepEqual(plain(harness.toasts[0][1]), { error: true });
  });
});

describe("chatter settings tab registration", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");

  it("is loaded by the page, listed in the sidebar and the deep-link whitelist, and has an icon", () => {
    const html = read("settings.html");
    assert.ok(html.indexOf("settings-tab-chatter.js") > 0);
    assert.ok(html.indexOf("settings-tab-chatter.js") < html.indexOf("settings-renderer.js"));
    assert.match(read("settings-renderer.js"), /\{ id: "chatter", labelKey: "sidebarChatter", available: true \}/);
    assert.match(read("settings-renderer.js"), /ClawdSettingsTabChatter\.init\(core\)/);
    assert.match(read("settings-window.js"), /"chatter",/);
    assert.match(read("settings-icons.js"), /\n  chatter:\n/);
  });

  it("every key the tab uses exists in English and in every locale", () => {
    const source = TAB_SOURCE;
    // Keys the tab passes to t() or to the row builders; pref names are not i18n keys.
    const keys = new Set([
      ...[...source.matchAll(/\bt\("([A-Za-z_]+)"\)/g)].map((m) => m[1]),
      ...[...source.matchAll(/"((?:row|section)[A-Za-z]+)"/g)].map((m) => m[1]),
    ]);
    keys.add("sidebarChatter");
    for (const id of [...PERSONALITY_IDS, "custom"]) keys.add(`chatterPersonality_${id}`);
    const i18n = read("settings-i18n.js");
    const blocks = (i18n.match(/^      sidebarChatter:/gm) || []).length;
    assert.equal(blocks, 7);
    for (const key of keys) {
      if (/^unit/.test(key)) continue; // shared units already exist everywhere
      const count = (i18n.match(new RegExp(`^      ${key}:`, "gm")) || []).length;
      assert.equal(count, 7, `${key} should be defined once per locale`);
    }
  });
});

describe("chatter settings tab: bubble font", () => {
  it("offers the fixed font list, saves a pick, and greys out with the master switch", async () => {
    const harness = load({ snapshot: { chatterEnabled: true, chatterBubbleFont: "lucida" } });
    harness.render();
    const font = harness.built.selects[2];
    assert.deepEqual(plain(font.options.map((o) => o.value)), [...CHATTER_FONT_IDS]);
    assert.equal(font.value, "lucida");
    await font.onChange("consolas");
    assert.deepEqual(plain(harness.updates.at(-1)), { key: "chatterBubbleFont", value: "consolas" });
    const off = load({ snapshot: { chatterEnabled: false } });
    off.render();
    assert.equal(off.built.selects[2].disabled, true);
    assert.equal(off.built.selects[2].value, "cascadia", "an unset font shows the default");
  });
});

describe("chatter settings tab: desktop awareness", () => {
  const switchOf = (harness, key) => harness.built.switches.find((c) => c.key === key);
  const warningOf = (parent) => {
    const section = parent.children.find((c) => c.title === "sectionChatterAwareness");
    return section.children.find((c) => /awareness-warning/.test(c.className || ""));
  };

  it("keeps automatic captures locked, and the warning dim, until the first switch is on", () => {
    const harness = load({ snapshot: { chatterEnabled: true, desktopAwareness: false } });
    const parent = harness.render();
    assert.equal(switchOf(harness, "desktopAwareness").disabled, false);
    assert.equal(switchOf(harness, "desktopAwarenessArmed").disabled, true);
    const warning = warningOf(parent);
    assert.equal(warning.className, "awareness-warning");
    assert.equal(warning.textContent, "awarenessWarningOff");
  });

  it("lights up the warning, right between the two switches, when the first one is on", () => {
    const harness = load({ snapshot: { chatterEnabled: true, desktopAwareness: true } });
    const parent = harness.render();
    assert.equal(switchOf(harness, "desktopAwarenessArmed").disabled, false);
    const warning = warningOf(parent);
    assert.match(warning.className, /awareness-warning-hot/);
    assert.equal(warning.textContent, "awarenessWarningOn");
    const section = parent.children.find((c) => c.title === "sectionChatterAwareness");
    const order = section.children.map((c) => (c.config && c.config.key) || c.className);
    assert.deepEqual(plain(order.slice(0, 3)), ["desktopAwareness", "awareness-warning awareness-warning-hot", "desktopAwarenessArmed"]);
  });

  it("everything about awareness waits for the chatter master switch", () => {
    const harness = load({ snapshot: { chatterEnabled: false, desktopAwareness: true } });
    harness.render();
    assert.equal(switchOf(harness, "desktopAwareness").disabled, true);
    assert.equal(switchOf(harness, "desktopAwarenessArmed").disabled, true);
  });

  it("offers the scope and monitor choices; the monitor choice waits for whole-monitor capture", async () => {
    const harness = load({ snapshot: { chatterEnabled: true, desktopAwareness: true, desktopAwarenessScope: "window" } });
    harness.render();
    const [, , , scope, monitor] = harness.built.selects;
    assert.deepEqual(plain(scope.options.map((o) => o.value)), ["window", "screen"]);
    assert.deepEqual(plain(monitor.options.map((o) => o.value)), ["pet", "primary", "all"]);
    assert.equal(monitor.disabled, true, "a window capture always uses the window's own monitor");
    await scope.onChange("screen");
    assert.deepEqual(plain(harness.updates.at(-1)), { key: "desktopAwarenessScope", value: "screen" });
    const screen = load({ snapshot: { chatterEnabled: true, desktopAwareness: true, desktopAwarenessScope: "screen" } });
    screen.render();
    assert.equal(screen.built.selects[4].disabled, false);
  });

  it("shows whether the model can see images and what it last saw, and offers the hotkey", async () => {
    const harness = load({
      snapshot: { chatterEnabled: true, desktopAwareness: true },
      awarenessStatus: { ok: true, model: "m:9b", vision: false, lastSeen: "A spreadsheet." },
    });
    harness.render();
    await harness.flush();
    const parent = harness.render();
    const section = parent.children.find((c) => c.title === "sectionChatterAwareness");
    const statusRow = section.children.find((c) => c.config && c.config.labelKey === "rowAwarenessStatus");
    const texts = [];
    const collect = (node) => { if (node.textContent) texts.push(node.textContent); (node.children || []).forEach(collect); };
    collect(statusRow);
    assert.ok(texts.some((t) => t === "m:9b: awarenessCannotSee"), texts.join(" | "));
    assert.ok(texts.some((t) => t === "awarenessLastSeen A spreadsheet."), texts.join(" | "));
    assert.equal(section.children.at(-1).actionId, "shareScreen");
  });
});

describe("chatter settings tab: the page's copies match the real lists", () => {
  it("offers exactly the personalities and fonts the app knows, and the same custom-text limit", () => {
    // The Settings page is a browser script and cannot require these modules, so it keeps
    // its own copies. Rendering it and comparing here is what stops them drifting.
    const harness = load({ snapshot: { chatterEnabled: true } });
    harness.render();
    const [personality, , font] = harness.built.selects;
    assert.deepEqual(plain(personality.options.map((o) => o.value)), [...PERSONALITY_IDS, "custom"]);
    assert.deepEqual(plain(font.options.map((o) => o.value)), [...CHATTER_FONT_IDS]);
    assert.equal(Number(TAB_SOURCE.match(/const CUSTOM_MAX = (\d+);/)[1]), MAX_CUSTOM_PERSONALITY_CHARS);
  });
});
