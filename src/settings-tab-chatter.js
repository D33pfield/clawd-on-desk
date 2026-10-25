"use strict";

// Chatter tab: the local-LLM speech bubbles (src/chatter.js). Every control is
// a plain pref; the main process reads them on each use, so changes apply to
// the next line. The model list comes from Ollama through the main process
// (the page's CSP blocks talking to it directly).
(function initSettingsTabChatter(root) {
  let state = null;
  let helpers = null;
  let ops = null;
  let tabs = null;

  const PERSONALITIES = ["deadpan", "wholesome", "anxious", "noir", "sportscaster", "wizard", "engineer", "custom"];
  const AWARENESS_SCOPES = ["window", "screen"];
  const AWARENESS_MONITORS = ["pet", "primary", "all"];
  const BUBBLE_FONTS = ["cascadia", "consolas", "lucida", "courier"];
  const CUSTOM_MAX = 300;

  const view = {
    models: null, // { ok, models, defaultModel, error } once loaded
    loading: false,
    awareness: null, // { ok, model, vision, lastSeen } once loaded
    awarenessLoading: false,
    customDraft: null,
    customDirty: false,
  };

  function t(key) {
    return helpers.t(key);
  }

  function pref(key) {
    return state.snapshot ? state.snapshot[key] : undefined;
  }

  // Resolves true when the pref was saved; shows a toast and resolves false otherwise.
  function save(key, value) {
    let pending;
    try {
      pending = window.settingsAPI.update(key, value);
    } catch (err) {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      return Promise.resolve(false);
    }
    return Promise.resolve(pending).then((result) => {
      if (!result || result.status !== "ok") {
        ops.showToast(t("toastSaveFailed") + ((result && result.message) || "unknown error"), { error: true });
        return false;
      }
      return true;
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      return false;
    });
  }

  function loadModels() {
    if (view.loading) return;
    view.loading = true;
    let request;
    try {
      request = window.settingsAPI.getChatterModels();
    } catch (err) {
      request = Promise.reject(err);
    }
    Promise.resolve(request).then((result) => {
      view.models = result && typeof result === "object" ? result : { ok: false, models: [], error: "unavailable" };
    }).catch((err) => {
      view.models = { ok: false, models: [], error: (err && err.message) || "unavailable" };
    }).then(() => {
      view.loading = false;
      ops.requestRender({ content: true });
    });
  }

  function loadAwarenessStatus() {
    if (view.awarenessLoading) return;
    view.awarenessLoading = true;
    let request;
    try {
      request = window.settingsAPI.getAwarenessStatus();
    } catch (err) {
      request = Promise.reject(err);
    }
    Promise.resolve(request).then((result) => {
      view.awareness = result && typeof result === "object" ? result : { ok: false };
    }).catch(() => {
      view.awareness = { ok: false };
    }).then(() => {
      view.awarenessLoading = false;
      ops.requestRender({ content: true });
    });
  }

  function chatterOn() {
    return pref("chatterEnabled") !== false;
  }

  function buildPersonalityRow() {
    const parts = helpers.buildSettingRow({
      labelKey: "rowChatterPersonality",
      descriptionKey: "rowChatterPersonalityDesc",
    });
    const current = PERSONALITIES.includes(pref("chatterPersonality")) ? pref("chatterPersonality") : "deadpan";
    const control = helpers.buildSettingsSelect({
      value: current,
      options: PERSONALITIES.map((id) => ({ value: id, label: t(`chatterPersonality_${id}`) })),
      ariaLabel: t("rowChatterPersonality"),
      onChange: (next) => (next === pref("chatterPersonality") ? true : save("chatterPersonality", next)),
    });
    control.setDisabled(!chatterOn());
    parts.controlElement.appendChild(control.element);
    return parts.element;
  }

  function buildFontRow() {
    const parts = helpers.buildSettingRow({
      labelKey: "rowChatterFont",
      descriptionKey: "rowChatterFontDesc",
    });
    const current = BUBBLE_FONTS.includes(pref("chatterBubbleFont")) ? pref("chatterBubbleFont") : "cascadia";
    const control = helpers.buildSettingsSelect({
      value: current,
      options: BUBBLE_FONTS.map((id) => ({ value: id, label: t(`chatterFont_${id}`) })),
      ariaLabel: t("rowChatterFont"),
      onChange: (next) => (next === pref("chatterBubbleFont") ? true : save("chatterBubbleFont", next)),
    });
    control.setDisabled(!chatterOn());
    parts.controlElement.appendChild(control.element);
    return parts.element;
  }

  function buildCustomRow() {
    const parts = helpers.buildSettingRow({
      labelKey: "rowChatterCustom",
      descriptionKey: "rowChatterCustomDesc",
      className: "tg-approval-token-edit-row",
      controlClassName: "tg-approval-input-row",
    });
    const stored = typeof pref("chatterCustomPersonality") === "string" ? pref("chatterCustomPersonality") : "";
    // A re-render (any other setting changing) must not eat what is being typed.
    if (!view.customDirty) view.customDraft = stored;
    function commit() {
      const next = String(view.customDraft == null ? "" : view.customDraft).trim().slice(0, CUSTOM_MAX);
      view.customDirty = false;
      if (next === stored) return;
      void save("chatterCustomPersonality", next);
    }
    const input = helpers.buildTextInput({
      type: "text",
      spellcheck: false,
      maxLength: String(CUSTOM_MAX),
      placeholder: t("chatterCustomPlaceholder"),
      className: "tg-approval-input",
      value: view.customDraft || "",
      labelledBy: parts.labelElement.id,
      describedBy: parts.descriptionElement ? parts.descriptionElement.id : null,
      onEnter: () => { commit(); input.blur(); },
    });
    input.addEventListener("input", () => {
      view.customDraft = input.value;
      view.customDirty = true;
    });
    input.addEventListener("blur", () => { if (view.customDirty) commit(); });
    parts.controlElement.appendChild(input);
    return parts.element;
  }

  function buildModelRow() {
    const parts = helpers.buildSettingRow({
      labelKey: "rowChatterModel",
      descriptionKey: "rowChatterModelDesc",
    });
    const loaded = view.models;
    const installed = loaded && Array.isArray(loaded.models) ? loaded.models : [];
    const defaultModel = loaded && loaded.defaultModel ? loaded.defaultModel : "";
    const saved = typeof pref("chatterModel") === "string" ? pref("chatterModel") : "";
    const options = [{
      value: "",
      label: defaultModel ? `${t("chatterModelDefault")} (${defaultModel})` : t("chatterModelDefault"),
    }];
    for (const name of installed) {
      if (name !== defaultModel) options.push({ value: name, label: name });
    }
    // Keep a saved model selectable even when Ollama is down or it was removed.
    if (saved && !options.some((option) => option.value === saved)) options.push({ value: saved, label: saved });
    const control = helpers.buildSettingsSelect({
      value: saved,
      options,
      ariaLabel: t("rowChatterModel"),
      onChange: (next) => (next === pref("chatterModel") ? true : save("chatterModel", next)),
    });
    control.setDisabled(!chatterOn());
    parts.controlElement.appendChild(control.element);

    const refresh = helpers.buildButton({ labelKey: "chatterModelRefresh", tone: "quiet", size: "compact" });
    refresh.addEventListener("click", () => {
      view.models = null;
      ops.requestRender({ content: true });
    });
    parts.controlElement.appendChild(refresh);

    const status = document.createElement("span");
    status.className = "row-desc";
    if (!loaded) status.textContent = t("chatterModelLoading");
    else if (loaded.ok) status.textContent = `${installed.length} ${t("chatterModelsInstalled")}`;
    else status.textContent = `${t("chatterModelUnreachable")} (${loaded.error || "?"})`;
    parts.textElement.appendChild(status);
    return parts.element;
  }

  // The warning between the two toggles. It is dim until the first toggle is on, then
  // it lights up (and pulses once) so the person reads it before arming.
  function buildAwarenessWarning(unlocked) {
    const box = document.createElement("div");
    box.className = unlocked ? "awareness-warning awareness-warning-hot" : "awareness-warning";
    box.setAttribute("role", "note");
    box.textContent = t(unlocked ? "awarenessWarningOn" : "awarenessWarningOff");
    return box;
  }

  function buildAwarenessSelect(key, labelKey, descKey, ids, optionPrefix, disabled) {
    const parts = helpers.buildSettingRow({ labelKey, descriptionKey: descKey });
    const saved = pref(key);
    const control = helpers.buildSettingsSelect({
      value: ids.includes(saved) ? saved : ids[0],
      options: ids.map((id) => ({ value: id, label: t(`${optionPrefix}_${id}`) })),
      ariaLabel: t(labelKey),
      onChange: (next) => (next === pref(key) ? true : save(key, next)),
    });
    control.setDisabled(disabled);
    parts.controlElement.appendChild(control.element);
    return parts.element;
  }

  // Can the chatter model read images, and what did it last see? (Only in memory.)
  function buildAwarenessStatusRow() {
    const parts = helpers.buildSettingRow({ labelKey: "rowAwarenessStatus", descriptionKey: "rowAwarenessStatusDesc" });
    const status = document.createElement("span");
    status.className = "row-desc";
    const info = view.awareness;
    if (!info) status.textContent = t("awarenessStatusLoading");
    else if (!info.ok || !info.model) status.textContent = t("awarenessNoModel");
    else status.textContent = `${info.model}: ${t(info.vision ? "awarenessCanSee" : "awarenessCannotSee")}`;
    parts.controlElement.appendChild(status);
    const refresh = helpers.buildButton({ labelKey: "chatterModelRefresh", tone: "quiet", size: "compact" });
    refresh.addEventListener("click", () => {
      view.awareness = null;
      ops.requestRender({ content: true });
    });
    parts.controlElement.appendChild(refresh);
    const seen = document.createElement("span");
    seen.className = "row-desc";
    seen.textContent = `${t("awarenessLastSeen")} ${info && info.lastSeen ? info.lastSeen : t("awarenessNothingYet")}`;
    parts.textElement.appendChild(seen);
    return parts.element;
  }

  function numberRow(key, labelKey, descKey, unitKey, min, max) {
    return helpers.buildNumberInputRow({
      key,
      labelKey,
      descKey,
      unitKey,
      toDisplay: (value) => value,
      fromDisplay: (display) => Math.max(min, Math.min(max, Math.round(display))),
      min,
      max,
    }).row;
  }

  function switchRow(key, labelKey, descKey, disabled) {
    return helpers.buildSwitchRow({ key, labelKey, descKey, disabled });
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("chatterTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("chatterSubtitle");
    parent.appendChild(subtitle);

    if (view.models === null) loadModels();

    // The master switch: off means no lines, no model calls, and the model unloaded.
    const off = !chatterOn();
    parent.appendChild(helpers.buildSection(t("sectionChatterGeneral"), [
      switchRow("chatterEnabled", "rowChatterEnabled", "rowChatterEnabledDesc", false),
    ]));

    const voiceRows = [buildPersonalityRow()];
    if (pref("chatterPersonality") === "custom") voiceRows.push(buildCustomRow());
    voiceRows.push(buildModelRow());
    parent.appendChild(helpers.buildSection(t("sectionChatterVoice"), voiceRows));

    parent.appendChild(helpers.buildSection(t("sectionChatterTiming"), [
      numberRow("chatterCheckinMinutes", "rowChatterCheckin", "rowChatterCheckinDesc", "unitMinutes", 2, 180),
      numberRow("chatterBubbleSeconds", "rowChatterBubbleTime", "rowChatterBubbleTimeDesc", "unitSeconds", 3, 60),
      switchRow("chatterShowBubbles", "rowChatterShowBubbles", "rowChatterShowBubblesDesc", off),
      buildFontRow(),
    ]));

    parent.appendChild(helpers.buildSection(t("sectionChatterTriggers"), [
      switchRow("chatterTriggerCheckin", "rowChatterTriggerCheckin", "rowChatterTriggerCheckinDesc", off),
      switchRow("chatterTriggerTests", "rowChatterTriggerTests", "rowChatterTriggerTestsDesc", off),
      switchRow("chatterTriggerError", "rowChatterTriggerError", "rowChatterTriggerErrorDesc", off),
      switchRow("chatterTriggerReturn", "rowChatterTriggerReturn", "rowChatterTriggerReturnDesc", off),
      switchRow("chatterTriggerMusic", "rowChatterTriggerMusic", "rowChatterTriggerMusicDesc", off),
    ]));

    parent.appendChild(helpers.buildSection(t("sectionChatterContext"), [
      switchRow("chatterShareSong", "rowChatterShareSong", "rowChatterShareSongDesc", off),
    ]));

    // Desktop awareness: two switches side by side. The first unlocks the second and
    // lights up the warning that sits between them.
    const awarenessOn = pref("desktopAwareness") === true;
    if (awarenessOn && view.awareness === null) loadAwarenessStatus();
    const awarenessRows = [
      switchRow("desktopAwareness", "rowAwarenessEnabled", "rowAwarenessEnabledDesc", off),
      buildAwarenessWarning(awarenessOn),
      switchRow("desktopAwarenessArmed", "rowAwarenessArmed", "rowAwarenessArmedDesc", off || !awarenessOn),
      buildAwarenessSelect("desktopAwarenessScope", "rowAwarenessScope", "rowAwarenessScopeDesc", AWARENESS_SCOPES, "awarenessScope", off || !awarenessOn),
      buildAwarenessSelect("desktopAwarenessMonitor", "rowAwarenessMonitor", "rowAwarenessMonitorDesc", AWARENESS_MONITORS, "awarenessMonitor", off || !awarenessOn || pref("desktopAwarenessScope") === "window"),
      switchRow("desktopAwarenessLogLines", "rowAwarenessLogLines", "rowAwarenessLogLinesDesc", off || !awarenessOn),
    ];
    if (awarenessOn) awarenessRows.push(buildAwarenessStatusRow());
    if (tabs && tabs.shortcuts && typeof tabs.shortcuts.buildRow === "function") awarenessRows.push(tabs.shortcuts.buildRow("shareScreen"));
    parent.appendChild(helpers.buildSection(t("sectionChatterAwareness"), awarenessRows));

    // One key to ask for a line right now. The row and its key recording are the
    // Shortcuts tab's own, so the two tabs always agree.
    const shortcuts = tabs && tabs.shortcuts;
    if (shortcuts && typeof shortcuts.buildRow === "function") {
      parent.appendChild(helpers.buildSection(t("sectionChatterHotkey"), [shortcuts.buildRow("chatterNow")]));
    }
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    tabs = core.tabs;
    core.tabs.chatter = { render };
  }

  root.ClawdSettingsTabChatter = { init };
})(globalThis);
