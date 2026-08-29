"use strict";

(function initSettingsTabRecap(root) {
  let coreState = null;
  let runtime = null;
  let helpers = null;
  let ops = null;

  const PERIODS = ["today", "week", "month", "year"];
  const view = {
    period: "today",
    status: "idle",
    data: null,
    requestSeq: 0,
    togglePending: false,
    clearPending: false,
  };

  function t(key) {
    return helpers.t(key);
  }

  function locale() {
    const lang = coreState.snapshot && coreState.snapshot.lang;
    return ({ zh: "zh-CN", "zh-TW": "zh-TW", ko: "ko-KR", ja: "ja-JP", "pt-BR": "pt-BR", es: "es" })[lang] || "en";
  }

  function formatNumber(value) {
    return new Intl.NumberFormat(locale()).format(value);
  }

  function replace(template, values) {
    return Object.entries(values).reduce(
      (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
      String(template || "")
    );
  }

  function requestData() {
    if (view.status !== "idle") return;
    view.status = "loading";
    const requestSeq = ++view.requestSeq;
    Promise.resolve().then(() => {
      if (!window.settingsAPI || typeof window.settingsAPI.queryRecap !== "function") {
        throw new Error("recap API unavailable");
      }
      return window.settingsAPI.queryRecap(view.period);
    }).then((result) => {
      if (requestSeq !== view.requestSeq) return;
      if (!result || result.status !== "ready") {
        view.status = result && result.status === "unavailable" ? "unavailable" : "error";
        view.data = result || null;
      } else {
        view.status = "ready";
        view.data = result;
      }
      if (coreState.activeTab === "recap") ops.requestRender({ content: true });
    }).catch(() => {
      if (requestSeq !== view.requestSeq) return;
      view.status = "error";
      view.data = null;
      if (coreState.activeTab === "recap") ops.requestRender({ content: true });
    });
  }

  function reload() {
    view.requestSeq += 1;
    view.status = "idle";
    view.data = null;
    if (coreState.activeTab === "recap") ops.requestRender({ content: true });
  }

  function agentName(agentId) {
    const metadata = Array.isArray(runtime.agentMetadata)
      ? runtime.agentMetadata.find((agent) => agent && agent.id === agentId)
      : null;
    return metadata && metadata.name ? metadata.name : agentId;
  }

  function scopeLabel(row) {
    if (row.scope === "local") return "";
    const ordinal = Number(String(row.scopeInstance || "").split("-").at(-1)) || 1;
    const key = row.scope === "wsl" ? "recapScopeWsl" : "recapScopeRemote";
    return replace(t(key), { n: ordinal });
  }

  function combineMetric(current, next) {
    if (current === null || next === null) return null;
    return current + next;
  }

  function summarize(data) {
    const rows = new Map();
    const agentIds = new Set();
    let activeDays = 0;
    for (const day of data.days || []) {
      let dayHasActivity = false;
      for (const source of day.rows || []) {
        agentIds.add(source.agentId);
        if (source.metrics && source.metrics.activityEvents > 0) dayHasActivity = true;
        const key = `${source.agentId}\0${source.scopeInstance}`;
        let row = rows.get(key);
        if (!row) {
          row = {
            agentId: source.agentId,
            scope: source.scope,
            scopeInstance: source.scopeInstance,
            sessionsStarted: 0,
            turnsCompleted: 0,
            toolCalls: 0,
            activityEvents: 0,
            sessionsStartedPartial: false,
          };
          rows.set(key, row);
        }
        const metrics = source.metrics || {};
        row.sessionsStarted = combineMetric(row.sessionsStarted, metrics.sessionsStarted);
        row.turnsCompleted = combineMetric(row.turnsCompleted, metrics.turnsCompleted);
        row.toolCalls = combineMetric(row.toolCalls, metrics.toolCalls);
        row.activityEvents += Number.isSafeInteger(metrics.activityEvents) ? metrics.activityEvents : 0;
        row.sessionsStartedPartial ||= source.sessionsStartedPartial === true;
      }
      if (dayHasActivity) activeDays += 1;
    }
    return {
      agentCount: agentIds.size,
      activeDays,
      rows: [...rows.values()].sort((left, right) =>
        agentName(left.agentId).localeCompare(agentName(right.agentId), locale())
        || String(left.scopeInstance).localeCompare(String(right.scopeInstance))),
    };
  }

  function buildPeriodTabs() {
    const group = document.createElement("div");
    group.className = "recap-period-tabs";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", t("recapPeriodLabel"));
    for (const period of PERIODS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "recap-period-button";
      button.textContent = t(`recapPeriod_${period}`);
      button.classList.toggle("active", view.period === period);
      button.setAttribute("aria-pressed", view.period === period ? "true" : "false");
      button.addEventListener("click", () => {
        if (view.period === period) return;
        view.period = period;
        reload();
      });
      group.appendChild(button);
    }
    return group;
  }

  function metricText(value, partial = false) {
    if (value === null) return t("recapMetricUnavailable");
    const formatted = formatNumber(value);
    return partial ? `${formatted} · ${t("recapMetricPartial")}` : formatted;
  }

  function buildAgentRows(summary) {
    const list = document.createElement("div");
    list.className = "recap-agent-list";
    if (summary.rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "recap-empty";
      empty.textContent = t("recapEmptyBody");
      list.appendChild(empty);
      return list;
    }
    for (const row of summary.rows) {
      const item = document.createElement("div");
      item.className = "recap-agent-row";
      const identity = document.createElement("div");
      identity.className = "recap-agent-identity";
      const name = document.createElement("strong");
      name.textContent = agentName(row.agentId);
      identity.appendChild(name);
      const scope = scopeLabel(row);
      if (scope) {
        const scopeNode = document.createElement("span");
        scopeNode.textContent = scope;
        identity.appendChild(scopeNode);
      }
      item.appendChild(identity);
      const metrics = document.createElement("dl");
      metrics.className = "recap-agent-metrics";
      for (const [labelKey, value, partial] of [
        ["recapMetricSessions", row.sessionsStarted, row.sessionsStartedPartial],
        ["recapMetricTurns", row.turnsCompleted, false],
        ["recapMetricTools", row.toolCalls, false],
        ["recapMetricSignals", row.activityEvents, false],
      ]) {
        const pair = document.createElement("div");
        const label = document.createElement("dt");
        label.textContent = t(labelKey);
        const count = document.createElement("dd");
        count.textContent = metricText(value, partial);
        if (value === null) count.title = t("recapMetricUnavailableReason");
        pair.appendChild(label);
        pair.appendChild(count);
        metrics.appendChild(pair);
      }
      item.appendChild(metrics);
      list.appendChild(item);
    }
    return list;
  }

  function buildPlainTimeline(data) {
    const timeline = document.createElement("div");
    timeline.className = "recap-plain-timeline";
    timeline.setAttribute("aria-label", t("recapTimelineLabel"));
    for (const day of data.days || []) {
      const activity = (day.rows || []).reduce(
        (total, row) => total + (row.metrics && Number.isSafeInteger(row.metrics.activityEvents)
          ? row.metrics.activityEvents
          : 0),
        0
      );
      const coverage = day.coverage && Array.isArray(day.coverage.coverageMinutes)
        ? day.coverage.coverageMinutes.reduce((sum, value) => sum + Number(value || 0), 0)
        : 0;
      const cell = document.createElement("div");
      cell.className = "recap-plain-day";
      cell.classList.add(activity > 0 ? "active" : (coverage > 0 ? "covered" : "uncovered"));
      cell.title = activity > 0
        ? replace(t("recapDayActivity"), { date: day.localDate, count: formatNumber(activity) })
        : replace(t(coverage > 0 ? "recapDayCovered" : "recapDayUncovered"), { date: day.localDate });
      cell.setAttribute("aria-label", cell.title);
      timeline.appendChild(cell);
    }
    return timeline;
  }

  function buildDataCard(data) {
    const summary = summarize(data);
    const card = document.createElement("section");
    card.className = "recap-card recap-skeleton-card";
    const headline = document.createElement("h2");
    headline.textContent = replace(t("recapHeadline"), { count: formatNumber(summary.agentCount) });
    card.appendChild(headline);
    const note = document.createElement("p");
    note.className = "recap-card-note";
    note.textContent = replace(t("recapActiveDays"), { count: formatNumber(summary.activeDays) });
    card.appendChild(note);
    card.appendChild(buildAgentRows(summary));
    card.appendChild(buildPlainTimeline(data));
    const footnote = document.createElement("p");
    footnote.className = "recap-footnote";
    footnote.textContent = t(data.recordingEnabled ? "recapCoverageFootnote" : "recapPausedFootnote");
    card.appendChild(footnote);
    return card;
  }

  function buildRecordingControls() {
    const rows = [];
    const enabled = !!(coreState.snapshot && coreState.snapshot.recapEnabled !== false);
    const switchRow = document.createElement("div");
    switchRow.className = "row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("recapRecordingLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("recapRecordingDesc");
    text.appendChild(label);
    text.appendChild(desc);
    switchRow.appendChild(text);
    const control = document.createElement("div");
    control.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", view.togglePending ? "-1" : "0");
    helpers.setSwitchVisual(sw, enabled, { pending: view.togglePending });
    const toggle = () => {
      if (view.togglePending || !window.settingsAPI || typeof window.settingsAPI.update !== "function") return;
      view.togglePending = true;
      ops.requestRender({ content: true });
      Promise.resolve(window.settingsAPI.update("recapEnabled", !enabled)).then((result) => {
        if (!result || result.status !== "ok") throw new Error("save failed");
        reload();
      }).catch(() => ops.showToast(t("recapToggleFailed"), { error: true })).finally(() => {
        view.togglePending = false;
        if (coreState.activeTab === "recap") ops.requestRender({ content: true });
      });
    };
    sw.addEventListener("click", toggle);
    sw.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        toggle();
      }
    });
    control.appendChild(sw);
    switchRow.appendChild(control);
    rows.push(switchRow);

    const clearRow = document.createElement("div");
    clearRow.className = "row";
    const clearText = document.createElement("div");
    clearText.className = "row-text";
    const clearLabel = document.createElement("span");
    clearLabel.className = "row-label";
    clearLabel.textContent = t("recapClearLabel");
    const clearDesc = document.createElement("span");
    clearDesc.className = "row-desc";
    clearDesc.textContent = t("recapClearDesc");
    clearText.appendChild(clearLabel);
    clearText.appendChild(clearDesc);
    clearRow.appendChild(clearText);
    const clearControl = document.createElement("div");
    clearControl.className = "row-control";
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "soft-btn danger";
    clearButton.textContent = view.clearPending ? t("recapClearing") : t("recapClearAction");
    clearButton.disabled = view.clearPending;
    clearButton.addEventListener("click", async () => {
      if (view.clearPending || !window.settingsAPI || typeof window.settingsAPI.clearRecap !== "function") return;
      const action = await helpers.showSettingsConfirmModal({
        title: t("recapClearConfirmTitle"),
        detail: t("recapClearConfirmDetail"),
        actions: [
          { id: "cancel", label: t("recapCancel"), tone: "neutral", defaultFocus: true },
          { id: "confirm", label: t("recapClearConfirmAction"), tone: "danger" },
        ],
      });
      if (action !== "confirm") return;
      view.clearPending = true;
      ops.requestRender({ content: true });
      try {
        const result = await window.settingsAPI.clearRecap();
        if (!result || result.status !== "ok") throw new Error("clear failed");
        ops.showToast(t("recapClearDone"));
        reload();
      } catch {
        ops.showToast(t("recapClearFailed"), { error: true });
      } finally {
        view.clearPending = false;
        if (coreState.activeTab === "recap") ops.requestRender({ content: true });
      }
    });
    clearControl.appendChild(clearButton);
    clearRow.appendChild(clearControl);
    rows.push(clearRow);
    return helpers.buildSection(t("recapPrivacyTitle"), rows);
  }

  function render(parent) {
    const header = document.createElement("div");
    header.className = "recap-page-header";
    const title = document.createElement("h1");
    title.textContent = t("recapTitle");
    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("recapSubtitle");
    header.appendChild(title);
    header.appendChild(subtitle);
    header.appendChild(buildPeriodTabs());
    parent.appendChild(header);

    if (view.status === "idle") requestData();
    if (view.status === "loading" || view.status === "idle") {
      const loading = document.createElement("div");
      loading.className = "recap-state-card";
      loading.setAttribute("role", "status");
      loading.textContent = t("recapLoading");
      parent.appendChild(loading);
    } else if (view.status === "ready") {
      parent.appendChild(buildDataCard(view.data));
    } else {
      const error = document.createElement("div");
      error.className = "recap-state-card recap-error";
      error.setAttribute("role", "alert");
      error.textContent = t(view.status === "unavailable" ? "recapUnavailable" : "recapLoadFailed");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "soft-btn";
      retry.textContent = t("recapRetry");
      retry.addEventListener("click", reload);
      error.appendChild(retry);
      parent.appendChild(error);
    }
    parent.appendChild(buildRecordingControls());
  }

  function init(core) {
    coreState = core.state;
    runtime = core.runtime;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.recap = {
      render,
      patchInPlace(changes) {
        if (!changes || !Object.hasOwn(changes, "recapEnabled")) return false;
        reload();
        return false;
      },
    };
  }

  root.ClawdSettingsTabRecap = {
    init,
    __test: { summarize },
  };
})(globalThis);
