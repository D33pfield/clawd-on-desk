"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");

function loadI18n() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-i18n.js"), "utf8"), context);
  return context.ClawdSettingsI18n;
}

test("recap tab is loaded before the Settings renderer and sits directly above About", () => {
  const html = fs.readFileSync(path.join(SRC, "settings.html"), "utf8");
  const renderer = fs.readFileSync(path.join(SRC, "settings-renderer.js"), "utf8");
  assert.ok(html.indexOf('settings-tab-recap.js') < html.indexOf('settings-renderer.js'));
  assert.match(renderer, /\{ id: "recap"[\s\S]*\{ id: "about"/);
});

test("every supported Settings locale has the complete recap key set", () => {
  const i18n = loadI18n();
  const englishKeys = Object.keys(i18n.STRINGS.en).filter((key) => key === "sidebarRecap" || key.startsWith("recap"));
  assert.ok(englishKeys.length > 30);
  for (const lang of ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"]) {
    for (const key of englishKeys) {
      assert.equal(typeof i18n.STRINGS[lang][key], "string", `${lang}.${key}`);
      assert.notEqual(i18n.STRINGS[lang][key], "", `${lang}.${key}`);
    }
  }
});

test("recap tab stays browser-only and aggregates scope rows without turning null into zero", () => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-tab-recap.js"), "utf8"), context);
  const core = {
    state: { snapshot: { lang: "en" }, activeTab: "recap" },
    runtime: { agentMetadata: [{ id: "codex", name: "Codex" }] },
    helpers: { t: (key) => key },
    ops: { requestRender() {}, showToast() {} },
    tabs: {},
  };
  context.ClawdSettingsTabRecap.init(core);
  assert.equal(typeof core.tabs.recap.render, "function");
  const summary = context.ClawdSettingsTabRecap.__test.summarize({
    days: [{
      rows: [
        {
          agentId: "codex",
          scope: "local",
          scopeInstance: "local-1",
          metrics: { sessionsStarted: null, turnsCompleted: 2, toolCalls: 3, activityEvents: 4 },
          sessionsStartedPartial: true,
        },
        {
          agentId: "codex",
          scope: "remote",
          scopeInstance: "remote-1",
          metrics: { sessionsStarted: 1, turnsCompleted: 1, toolCalls: 1, activityEvents: 2 },
          sessionsStartedPartial: false,
        },
      ],
    }],
  });
  assert.equal(summary.agentCount, 1);
  assert.equal(summary.activeDays, 1);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows.find((row) => row.scope === "local").sessionsStarted, null);
  assert.equal(summary.rows.find((row) => row.scope === "remote").sessionsStarted, 1);
});

test("recap skeleton uses square cells and exposes no arbitrary date or export surface", () => {
  const css = fs.readFileSync(path.join(SRC, "settings.css"), "utf8");
  const preload = fs.readFileSync(path.join(SRC, "preload-settings.js"), "utf8");
  assert.match(css, /\.recap-plain-day[\s\S]*aspect-ratio:\s*1/);
  assert.match(preload, /queryRecap:\s*\(period\)/);
  assert.ok(!preload.includes("exportRecap"));
  assert.ok(!preload.includes("shareRecap"));
});
