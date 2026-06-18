"use strict";

// Renderer for the first-run onboarding tutorial window (tutorial.html). Receives
// a state payload from main (i18n, platform, detected agents, shortcuts), draws a
// 5-step wizard, and routes step-2 install/cleanup actions back through
// window.tutorialAPI. No inline scripts (CSP: script-src 'self').

(function () {
  const api = window.tutorialAPI || {};

  const STEPS = ["welcome", "agents", "shortcuts", "features", "done"];
  let STATE = { i18n: {}, lang: "en", platform: "", agents: { install: [], cleanup: [], active: [] }, shortcuts: [] };
  let step = 0;
  let installSel = new Set();
  let cleanupSel = new Set();
  let applying = false;

  const PET_SVG =
    '<svg class="pet" viewBox="0 0 64 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M14 24 L18 7 L31 19 Z" fill="#EF9F27"/><path d="M50 24 L46 7 L33 19 Z" fill="#EF9F27"/>' +
    '<ellipse cx="32" cy="36" rx="22" ry="20" fill="#FAC775"/>' +
    '<circle cx="24" cy="34" r="2.6" fill="#412402"/><circle cx="40" cy="34" r="2.6" fill="#412402"/>' +
    '<path d="M27 41 Q32 45 37 41" stroke="#854F0B" stroke-width="2" fill="none" stroke-linecap="round"/>' +
    '<circle cx="19" cy="40" r="2.4" fill="#F0997B" opacity="0.7"/><circle cx="45" cy="40" r="2.4" fill="#F0997B" opacity="0.7"/></svg>';

  function i18n(key, fallback) {
    const v = STATE.i18n && STATE.i18n[key];
    return (typeof v === "string" && v.length) ? v : fallback;
  }

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    const p = props || {};
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return n;
  }

  function agentLabel(a) { return (a && (a.label || a.agentId)) || ""; }

  function syncSelectionDefaults() {
    const ag = STATE.agents || {};
    installSel = new Set((ag.install || []).map((a) => a.agentId));
    cleanupSel = new Set((ag.cleanup || []).map((a) => a.agentId));
  }

  function normalizeState(s) {
    const out = s && typeof s === "object" ? s : {};
    out.i18n = out.i18n || {};
    out.agents = out.agents || { install: [], cleanup: [], active: [] };
    out.agents.install = out.agents.install || [];
    out.agents.cleanup = out.agents.cleanup || [];
    out.agents.active = out.agents.active || [];
    out.shortcuts = out.shortcuts || [];
    return out;
  }

  function setStep(n) {
    step = Math.max(0, Math.min(STEPS.length - 1, n));
    render();
    const body = document.getElementById("body");
    if (body) body.scrollTop = 0;
  }

  function finish() { try { if (api.finish) api.finish(); } catch (_) {} }

  async function applyAgentsAndAdvance() {
    if (applying) { return; }
    const installs = [...installSel];
    const cleanups = [...cleanupSel];
    if (installs.length === 0 && cleanups.length === 0) { setStep(step + 1); return; }
    applying = true;
    render();
    for (const id of installs) {
      try { if (api.installAgent) await api.installAgent(id); } catch (_) {}
    }
    for (const id of cleanups) {
      try { if (api.uninstallAgent) await api.uninstallAgent(id); } catch (_) {}
    }
    applying = false;
    // main re-pushes tutorial:state after each action; advance regardless.
    setStep(step + 1);
  }

  // ── Step renderers → return a DOM node for the body ──

  function renderWelcome() {
    return el("div", { class: "welcome" },
      el("div", { html: PET_SVG }),
      el("h2", { class: "step-title" }, i18n("tutorialWelcomeTitle", "Welcome to Clawd")),
      el("p", { class: "step-sub" }, i18n("tutorialWelcomeBody",
        "Your desktop companion reacts to your coding agent — it moves, sleeps, and celebrates along with your AI. Take a minute to get set up.")),
      el("div", { class: "lang-note" }, i18n("tutorialWelcomeLangNote", "Shown in your system language")),
    );
  }

  function agentRow(a, kind) {
    // kind: "active" (fixed check), "install" (info), "cleanup" (danger)
    const id = a.agentId;
    const selected = kind === "install" ? installSel.has(id) : kind === "cleanup" ? cleanupSel.has(id) : false;
    const fixed = kind === "active";
    const cls = ["ag-row", fixed ? "fixed" : "selectable", (!fixed && selected) ? "checked" : ""].join(" ").trim();
    const tag = kind === "active"
      ? el("span", { class: "ag-tag ok" }, i18n("tutorialAgentsActiveTag", "Connected"))
      : kind === "install"
        ? el("span", { class: "ag-tag info" }, i18n("tutorialAgentsInstallTag", "Detected"))
        : el("span", { class: "ag-tag danger" }, i18n("tutorialAgentsCleanupTag", "Remove"));
    const box = fixed
      ? el("span", { class: "ag-box", html: "&#10003;" })
      : el("span", { class: "ag-box", html: selected ? "&#10003;" : "" });
    const row = el("div", { class: cls }, box, el("span", { class: "ag-name" }, agentLabel(a)), tag);
    if (!fixed) {
      row.addEventListener("click", () => {
        const set = kind === "install" ? installSel : cleanupSel;
        if (set.has(id)) set.delete(id); else set.add(id);
        render();
      });
    }
    return row;
  }

  function renderAgents() {
    const ag = STATE.agents;
    const wrap = el("div", {});
    wrap.appendChild(el("h2", { class: "step-title" }, i18n("tutorialAgentsTitle", "Connect your agents")));
    wrap.appendChild(el("p", { class: "step-sub" }, i18n("tutorialAgentsSub",
      "Clawd checked your machine. Confirm what to connect — and clean up any leftover hooks.")));

    const hasAny = ag.active.length || ag.install.length || ag.cleanup.length;
    if (!hasAny) {
      wrap.appendChild(el("div", { class: "empty-note" },
        i18n("tutorialAgentsEmpty", "No agents detected yet. You can connect them anytime in Settings → Agents."),
      ));
      wrap.appendChild(el("div", { style: "margin-top:12px" },
        el("span", { class: "inline-link", onclick: () => api.openSettingsTab && api.openSettingsTab("agents") },
          i18n("tutorialAgentsOpenSettings", "Open Settings → Agents")),
      ));
      return wrap;
    }

    if (ag.active.length) {
      wrap.appendChild(el("div", { class: "group-label" }, i18n("tutorialAgentsActiveLabel", "Connected and working")));
      for (const a of ag.active) wrap.appendChild(agentRow(a, "active"));
    }
    if (ag.install.length) {
      wrap.appendChild(el("div", { class: "group-label" }, i18n("tutorialAgentsInstallLabel", "Detected — connect (installs the hook)")));
      for (const a of ag.install) wrap.appendChild(agentRow(a, "install"));
    }
    if (ag.cleanup.length) {
      wrap.appendChild(el("div", { class: "group-label" }, i18n("tutorialAgentsCleanupLabel", "Hook installed, but this agent isn't on your machine — recommend removing")));
      for (const a of ag.cleanup) wrap.appendChild(agentRow(a, "cleanup"));
      wrap.appendChild(el("div", { class: "ag-note" }, i18n("tutorialAgentsCleanupNote",
        "These were set up by default but the agent wasn't found — the leftover hook does nothing, so it's safe to remove.")));
    }
    return wrap;
  }

  function formatAccel(accel) {
    if (typeof accel !== "string" || !accel) return [];
    return accel.split("+").map((tokenRaw) => {
      const token = tokenRaw.trim();
      if (token === "CommandOrControl" || token === "CmdOrCtrl") return "Ctrl/⌘";
      if (token === "Command" || token === "Cmd" || token === "Meta") return "⌘";
      if (token === "Control" || token === "Ctrl") return "Ctrl";
      if (token === "Alt" || token === "Option") return "Alt";
      return token;
    });
  }

  function renderShortcuts() {
    const wrap = el("div", {});
    wrap.appendChild(el("h2", { class: "step-title" }, i18n("tutorialShortcutsTitle", "Keyboard shortcuts")));
    wrap.appendChild(el("p", { class: "step-sub" }, i18n("tutorialShortcutsSub",
      "Respond to permission requests without reaching for the mouse:")));

    const list = (STATE.shortcuts && STATE.shortcuts.length) ? STATE.shortcuts : [
      { label: i18n("tutorialShortcutsAllow", "Approve current request"), accelerator: "CommandOrControl+Shift+Y" },
      { label: i18n("tutorialShortcutsDeny", "Deny current request"), accelerator: "CommandOrControl+Shift+N" },
    ];
    for (const s of list) {
      const keys = el("span", { class: "keys" });
      for (const k of formatAccel(s.accelerator)) keys.appendChild(el("span", { class: "kbd" }, k));
      wrap.appendChild(el("div", { class: "sc-row" },
        el("span", { class: "sc-name" }, s.label || s.id || ""), keys));
    }

    wrap.appendChild(el("div", { style: "margin-top:14px" },
      el("span", { class: "inline-link", onclick: () => api.openShortcuts && api.openShortcuts() },
        i18n("tutorialShortcutsChange", "Change these in Settings → Shortcuts"))));
    wrap.appendChild(el("div", { class: "hint" }, i18n("tutorialShortcutsHint",
      "Tip: “Auto-approve all requests” is a right-click menu switch — handy, but it approves everything, so use it deliberately.")));
    return wrap;
  }

  function featureCard(titleKey, titleFb, descKey, descFb, plat) {
    const card = el("div", { class: "fcard" },
      el("h3", {}, i18n(titleKey, titleFb)),
      el("p", {}, i18n(descKey, descFb)));
    if (plat) card.appendChild(el("span", { class: "plat" }, plat));
    return card;
  }

  function renderFeatures() {
    const wrap = el("div", {});
    wrap.appendChild(el("h2", { class: "step-title" }, i18n("tutorialFeaturesTitle", "More to explore")));
    wrap.appendChild(el("p", { class: "step-sub" }, i18n("tutorialFeaturesSub",
      "A few things people love once they find them:")));
    const grid = el("div", { class: "features" },
      featureCard("tutorialFeatureDrag", "Drag a folder onto the pet",
        "tutorialFeatureDragDesc", "Drop a folder on Clawd to open a terminal there.", "Windows / Linux"),
      featureCard("tutorialFeatureAuto", "Auto-approve all requests",
        "tutorialFeatureAutoDesc", "A right-click switch to stop confirming every permission."),
      featureCard("tutorialFeatureThemes", "Themes & mini mode",
        "tutorialFeatureThemesDesc", "Swap characters, or pin a tiny pet to a screen edge."),
      featureCard("tutorialFeatureMobile", "Phone / Telegram approval",
        "tutorialFeatureMobileDesc", "Approve permission requests from your phone."),
    );
    wrap.appendChild(grid);
    wrap.appendChild(el("div", { style: "margin-top:14px" },
      el("span", { class: "inline-link", onclick: () => api.openSettingsTab && api.openSettingsTab("general") },
        i18n("tutorialFeaturesOpenSettings", "Open Settings to explore everything"))));
    return wrap;
  }

  function renderDone() {
    return el("div", { class: "done" },
      el("div", { html: PET_SVG }),
      el("h2", { class: "step-title" }, i18n("tutorialDoneTitle", "You're all set")),
      el("p", { class: "step-sub" }, i18n("tutorialDoneBody",
        "Right-click the pet anytime to see this tutorial again. Have fun!")));
  }

  const BODY_RENDERERS = {
    welcome: renderWelcome,
    agents: renderAgents,
    shortcuts: renderShortcuts,
    features: renderFeatures,
    done: renderDone,
  };

  // ── Chrome ──

  function renderSteps() {
    const host = document.getElementById("steps");
    host.textContent = "";
    for (let i = 0; i < STEPS.length; i += 1) {
      if (i > 0) host.appendChild(el("span", { class: "seg" }));
      const cls = "dot" + (i === step ? " active" : i < step ? " done" : "");
      host.appendChild(el("span", { class: cls }));
    }
  }

  function primaryLabel() {
    const name = STEPS[step];
    if (name === "welcome") return i18n("tutorialGetStarted", "Get started");
    if (name === "done") return i18n("tutorialFinish", "Finish");
    if (name === "agents") {
      const n = installSel.size, m = cleanupSel.size;
      if (applying) return i18n("tutorialWorking", "Working…");
      if (n === 0 && m === 0) return i18n("tutorialContinue", "Continue");
      return i18n("tutorialApplyContinue", "Apply & continue");
    }
    return i18n("tutorialContinue", "Continue");
  }

  function onPrimary() {
    const name = STEPS[step];
    if (name === "done") { finish(); return; }
    if (name === "agents") { applyAgentsAndAdvance(); return; }
    setStep(step + 1);
  }

  function renderFooter() {
    const host = document.getElementById("footer");
    host.textContent = "";
    if (step > 0) {
      host.appendChild(el("button", { class: "btn", onclick: () => setStep(step - 1) },
        i18n("tutorialBack", "Back")));
    }
    host.appendChild(el("span", { class: "spacer" }));
    if (STEPS[step] !== "done") {
      host.appendChild(el("button", { class: "btn btn-ghost", onclick: finish },
        i18n("tutorialSkip", "Skip tutorial")));
    }
    const primary = el("button", { class: "btn btn-primary", onclick: onPrimary }, primaryLabel());
    if (applying) primary.disabled = true;
    host.appendChild(primary);
  }

  function render() {
    renderSteps();
    const body = document.getElementById("body");
    body.textContent = "";
    body.appendChild((BODY_RENDERERS[STEPS[step]] || renderWelcome)());
    renderFooter();
  }

  function adopt(s) {
    STATE = normalizeState(s);
    syncSelectionDefaults();
    render();
  }

  if (api.onState) api.onState((s) => adopt(s));
  if (api.getState) {
    api.getState().then((s) => adopt(s)).catch(() => render());
  } else {
    render();
  }
})();
