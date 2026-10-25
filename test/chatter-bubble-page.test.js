"use strict";

// The bubble page (src/chatter-bubble.html) run against a small fake DOM: what it
// does is tested, not how its source is formatted. A few security invariants
// (strict CSP, text only, the preload's fixed channels) are checked on the source
// because they are properties of the file, not of one run.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");
const HTML = fs.readFileSync(path.join(SRC, "chatter-bubble.html"), "utf8");
const SCRIPT = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

function loadPage({ reducedMotion = false } = {}) {
  const log = [];
  const elements = new Map();
  function element(id) {
    const classes = new Set();
    const el = {
      id,
      offsetWidth: 200,
      listeners: new Map(),
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      },
      addEventListener: (type, fn) => el.listeners.set(type, fn),
    };
    // Record the order of the writes that matter: the font, then the text.
    let text = "";
    Object.defineProperty(el, "textContent", {
      get: () => text,
      set: (v) => { text = v; log.push([id, "text", v]); },
    });
    el.style = new Proxy({}, { set: (target, prop, value) => { target[prop] = value; log.push([id, "style." + prop, value]); return true; } });
    elements.set(id, el);
    return el;
  }
  for (const id of ["wrap", "bubble", "ghost", "typed", "puff1", "puff2"]) element(id);
  const handlers = {};
  const sent = [];
  const intervals = [];
  const context = {
    document: { getElementById: (id) => elements.get(id) },
    window: {
      innerWidth: 340,
      matchMedia: () => ({ matches: reducedMotion }),
      chatterBubbleAPI: {
        onShow: (cb) => { handlers.show = cb; },
        onHide: (cb) => { handlers.hide = cb; },
        setInteractive: (v) => sent.push(["interactive", v]),
        dismiss: () => sent.push(["dismiss"]),
      },
    },
    setInterval: (fn, ms) => { const handle = { fn, ms, cleared: false }; intervals.push(handle); return handle; },
    clearInterval: (handle) => { if (handle) handle.cleared = true; },
  };
  vm.runInNewContext(SCRIPT, context);
  const el = (id) => elements.get(id);
  const tick = () => { const live = intervals.filter((h) => !h.cleared).at(-1); if (live) live.fn(); };
  return { handlers, el, log, sent, intervals, tick };
}

const PAYLOAD = { text: "Hello there", below: false, tailX: 170, charMs: 32, font: { family: "Consolas, monospace", size: 15, lineHeight: 1.4 } };

describe("chatter bubble page", () => {
  it("applies the chosen font before it puts the text in, so the bubble is measured in its final face", () => {
    const page = loadPage();
    page.handlers.show(PAYLOAD);
    const order = page.log.map(([id, what]) => `${id}:${what}`);
    assert.ok(order.indexOf("bubble:style.fontFamily") < order.indexOf("ghost:text"));
    assert.strictEqual(page.el("bubble").style.fontFamily, "Consolas, monospace");
    assert.strictEqual(page.el("bubble").style.fontSize, "15px");
    assert.strictEqual(page.el("bubble").style.lineHeight, "1.4");
  });

  it("lays the full text out invisibly at once and types it a character at a time", () => {
    const page = loadPage();
    page.handlers.show(PAYLOAD);
    assert.strictEqual(page.el("ghost").textContent, "Hello there", "the bubble has its final size from the first character");
    assert.strictEqual(page.el("typed").textContent, "");
    assert.ok(page.el("typed").classList.contains("typing"), "the cursor shows while typing");
    assert.strictEqual(page.intervals.at(-1).ms, 32);
    page.tick();
    assert.strictEqual(page.el("typed").textContent, "H");
    page.tick();
    assert.strictEqual(page.el("typed").textContent, "He");
    for (let i = 0; i < 20; i++) page.tick();
    assert.strictEqual(page.el("typed").textContent, "Hello there");
    assert.ok(page.intervals.at(-1).cleared, "typing stops at the end");
    assert.ok(!page.el("typed").classList.contains("typing"), "the cursor goes");
  });

  it("shows the text at once under reduced motion", () => {
    const page = loadPage({ reducedMotion: true });
    page.handlers.show(PAYLOAD);
    assert.strictEqual(page.el("typed").textContent, "Hello there");
    assert.strictEqual(page.intervals.length, 0);
  });

  it("a quiet move repositions without touching the text or restarting the typing", () => {
    const page = loadPage();
    page.handlers.show(PAYLOAD);
    page.tick();
    const intervalsBefore = page.intervals.length;
    page.log.length = 0;
    page.handlers.show({ ...PAYLOAD, quiet: true, tailX: 100, below: true });
    assert.strictEqual(page.el("typed").textContent, "H", "typing carries on where it was");
    assert.strictEqual(page.intervals.length, intervalsBefore);
    assert.ok(!page.log.some(([, what]) => what === "text"), "no text was rewritten");
    assert.ok(page.el("wrap").classList.contains("below"));
  });

  it("fades in on the first line and out on hide", () => {
    const page = loadPage();
    assert.ok(!page.el("wrap").classList.contains("show"));
    page.handlers.show(PAYLOAD);
    assert.ok(page.el("wrap").classList.contains("show"));
    page.handlers.hide();
    assert.ok(!page.el("wrap").classList.contains("show"));
    assert.ok(page.intervals.every((h) => h.cleared), "typing stopped");
  });

  it("makes only the bubble clickable: the pointer over it takes clicks, a click dismisses", () => {
    const page = loadPage();
    const bubble = page.el("bubble");
    bubble.listeners.get("mouseenter")();
    bubble.listeners.get("mouseleave")();
    bubble.listeners.get("click")();
    assert.deepStrictEqual(page.sent, [["interactive", true], ["interactive", false], ["dismiss"]]);
  });

  it("ignores payloads that are not a line of text, and a font that is not a preset-shaped object", () => {
    const page = loadPage();
    page.handlers.show(null);
    page.handlers.show({});
    page.handlers.show({ text: 5 });
    assert.strictEqual(page.el("ghost").textContent, "");
    page.handlers.show({ ...PAYLOAD, font: { family: 7, size: -1 } });
    assert.strictEqual(page.el("bubble").style.fontFamily, undefined, "a malformed font changes nothing");
    assert.strictEqual(page.el("ghost").textContent, "Hello there", "the line itself still shows");
  });

  it("treats model text as text: markup is never interpreted", () => {
    const page = loadPage();
    page.handlers.show({ ...PAYLOAD, text: "<img src=x onerror=alert(1)>" });
    assert.strictEqual(page.el("ghost").textContent, "<img src=x onerror=alert(1)>");
  });
});

describe("chatter bubble page: security invariants of the files", () => {
  it("has a strict CSP and never builds markup from text", () => {
    assert.match(HTML, /Content-Security-Policy" content="default-src 'none'/);
    assert.doesNotMatch(HTML, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("the preload exposes two listeners and two fixed-channel senders, nothing else", () => {
    const preload = fs.readFileSync(path.join(SRC, "preload-chatter-bubble.js"), "utf8");
    assert.deepStrictEqual(
      [...preload.matchAll(/ipcRenderer\.send\("([a-z-]+)"/g)].map((m) => m[1]),
      ["chatter-bubble-interactive", "chatter-bubble-dismiss"]
    );
    assert.deepStrictEqual(
      [...preload.matchAll(/ipcRenderer\.on\("([a-z-]+)"/g)].map((m) => m[1]),
      ["chatter-bubble-show", "chatter-bubble-hide"]
    );
    assert.strictEqual((preload.match(/ipcRenderer\.invoke/g) || []).length, 0);
  });
});
