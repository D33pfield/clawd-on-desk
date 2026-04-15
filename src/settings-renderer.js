"use strict";

// ── Settings panel renderer ──
//
// Strict unidirectional flow (plan §4.2):
//
//   1. UI clicks → settingsAPI.update(key, value) → main → controller
//   2. Controller commits → broadcasts settings-changed
//   3. settingsAPI.onChanged fires → renderUI() rebuilds the affected row(s)
//
// We never optimistically toggle a switch in the click handler. The visual
// state always reflects what the store says — period. Failures show a toast
// and the switch stays in its previous position because the store was never
// committed.

// ── i18n (mirror src/i18n.js — bubbles can't require electron modules) ──
const STRINGS = {
  en: {
    settingsTitle: "Settings",
    settingsSubtitle: "Configure how Clawd behaves on your desktop.",
    sidebarGeneral: "General",
    sidebarAgents: "Agents",
    sidebarTheme: "Theme",
    sidebarAnimMap: "Animation Map",
    sidebarAnimOverrides: "Animation Overrides",
    sidebarShortcuts: "Shortcuts",
    sidebarAbout: "About",
    sidebarSoon: "Soon",
    sectionAppearance: "Appearance",
    sectionStartup: "Startup",
    sectionBubbles: "Bubbles",
    agentsTitle: "Agents",
    agentsSubtitle: "Turn tracking on or off per agent. Disabled agents stop log monitors and drop hook events at the HTTP boundary — they won't drive the pet, show permission bubbles, or keep sessions.",
    agentsEmpty: "No agents registered.",
    eventSourceHook: "Hook",
    eventSourceLogPoll: "Log poll",
    eventSourcePlugin: "Plugin",
    badgePermissionBubble: "Permission bubble",
    rowAgentPermissions: "Show pop-up bubbles",
    rowAgentPermissionsDesc: "Turn off to let this agent handle prompts in its own terminal instead of showing a Clawd bubble.",
    rowLanguage: "Language",
    rowLanguageDesc: "Interface language for menus and bubbles.",
    rowSound: "Sound effects",
    rowSoundDesc: "Play a chime when Clawd finishes a task or asks for input.",
    rowOpenAtLogin: "Open at login",
    rowOpenAtLoginDesc: "Start Clawd automatically when you log in.",
    rowStartWithClaude: "Start with Claude Code",
    rowStartWithClaudeDesc: "Auto-launch Clawd whenever a Claude Code session starts.",
    rowBubbleFollow: "Bubbles follow Clawd",
    rowBubbleFollowDesc: "Place permission and update bubbles next to the pet instead of the screen corner.",
    rowHideBubbles: "Hide all bubbles",
    rowHideBubblesDesc: "Suppress permission, notification, and update bubbles entirely.",
    rowShowSessionId: "Show session ID",
    rowShowSessionIdDesc: "Append the short session ID to bubble headers and the Sessions menu.",
    placeholderTitle: "Coming soon",
    placeholderDesc: "This panel will land in a future Clawd release. The plan lives in docs/plan-settings-panel.md.",
    toastSaveFailed: "Couldn't save: ",
    langEnglish: "English",
    langChinese: "中文",
    themeTitle: "Theme",
    themeSubtitle: "Pick a theme for Clawd. Community themes land in your user themes folder and can be removed from here.",
    themeEmpty: "No themes available.",
    themeBadgeBuiltin: "Built-in",
    themeBadgeActive: "Active",
    themeActiveIndicator: "\u2713 Active",
    themeThumbMissing: "\u{1F3AD}",
    themeDeleteLabel: "Delete theme",
    themeVariantStripLabel: "Variants",
    toastThemeDeleted: "Theme deleted.",
    toastThemeDeleteFailed: "Couldn't delete theme: ",
    animMapTitle: "Animation Map",
    animMapSubtitle: "Silence individual interrupt animations. Events still fire — Clawd just skips the visual and sound for the selected states.",
    animMapSemanticsNote: "Disable = no visual + no sound. Permission bubbles, sessions, and terminal focus still work.",
    animMapResetAll: "Reset all",
    animMapAttentionLabel: "Task complete (happy)",
    animMapAttentionDesc: "The happy bounce when the agent finishes a turn (Stop / PostCompact).",
    animMapErrorLabel: "Error flash",
    animMapErrorDesc: "The shake animation when a tool call fails.",
    animMapSweepingLabel: "Context sweep",
    animMapSweepingDesc: "The broom animation during PreCompact / context clearing.",
    animMapNotificationLabel: "Notification",
    animMapNotificationDesc: "The bell animation for permission requests and elicitations.",
    animMapCarryingLabel: "Worktree carry",
    animMapCarryingDesc: "The carrying animation when a worktree is created.",
    toastAnimMapResetOk: "Animation overrides cleared.",
    animOverridesTitle: "Animation Overrides",
    animOverridesSubtitle: "Swap per-card files and adjust fade / return timing for the current theme.",
    animOverridesCurrentTheme: "Current theme",
    animOverridesOpenThemeTab: "Open Theme tab",
    animOverridesOpenAssets: "Open assets folder",
    animOverridesResetAll: "Reset all to default",
    animOverridesChangeFile: "Change file",
    animOverridesPreview: "Preview once",
    animOverridesReset: "Reset slot",
    animOverridesFade: "Fade",
    animOverridesFadeIn: "In",
    animOverridesFadeOut: "Out",
    animOverridesSaveFade: "Save fade",
    animOverridesDuration: "Auto-return",
    animOverridesSaveDuration: "Save timing",
    animOverridesContinuousHint: "Continuous state: no auto-return editor here.",
    animOverridesAssetCycle: "Asset cycle",
    animOverridesSuggestedTiming: "Suggested timing",
    animOverridesTimingEstimated: "estimated",
    animOverridesTimingFallback: "theme default",
    animOverridesTimingUnavailable: "unavailable",
    animOverridesDisplayHintWarning: "displayHintMap can override this slot at runtime.",
    animOverridesModalTitle: "Choose an asset file",
    animOverridesModalSubtitle: "Add files to the current theme assets folder, then refresh the list here.",
    animOverridesModalEmpty: "No supported assets found in this theme yet.",
    animOverridesModalSelected: "Selected file",
    animOverridesModalUse: "Use this file",
    animOverridesModalCancel: "Cancel",
    animOverridesRefresh: "Refresh list",
  },
  zh: {
    settingsTitle: "设置",
    settingsSubtitle: "配置 Clawd 在桌面上的行为。",
    sidebarGeneral: "通用",
    sidebarAgents: "Agent 管理",
    sidebarTheme: "主题",
    sidebarAnimMap: "动画映射",
    sidebarAnimOverrides: "动画替换",
    sidebarShortcuts: "快捷键",
    sidebarAbout: "关于",
    sidebarSoon: "待推出",
    sectionAppearance: "外观",
    sectionStartup: "启动",
    sectionBubbles: "气泡",
    agentsTitle: "Agent 管理",
    agentsSubtitle: "按 agent 类型开关追踪。关闭后会停掉日志监视器、在 HTTP 入口丢弃 hook 事件——不会再驱动桌宠、不弹权限气泡、不记会话。",
    agentsEmpty: "没有已注册的 agent。",
    eventSourceHook: "Hook",
    eventSourceLogPoll: "日志轮询",
    eventSourcePlugin: "插件",
    badgePermissionBubble: "权限气泡",
    rowAgentPermissions: "显示弹窗",
    rowAgentPermissionsDesc: "关闭后让该 agent 在自己的终端里处理提示，不再弹 Clawd 气泡。",
    rowLanguage: "语言",
    rowLanguageDesc: "菜单和气泡的界面语言。",
    rowSound: "音效",
    rowSoundDesc: "Clawd 完成任务或需要输入时播放提示音。",
    rowOpenAtLogin: "开机自启",
    rowOpenAtLoginDesc: "登录系统时自动启动 Clawd。",
    rowStartWithClaude: "随 Claude Code 启动",
    rowStartWithClaudeDesc: "Claude Code 会话开始时自动拉起 Clawd。",
    rowBubbleFollow: "气泡跟随 Clawd",
    rowBubbleFollowDesc: "把权限气泡和更新气泡放在桌宠旁边，而不是屏幕角落。",
    rowHideBubbles: "隐藏所有气泡",
    rowHideBubblesDesc: "完全屏蔽权限、通知和更新气泡。",
    rowShowSessionId: "显示会话 ID",
    rowShowSessionIdDesc: "在气泡标题和会话菜单后追加短会话 ID。",
    placeholderTitle: "即将推出",
    placeholderDesc: "此面板将在 Clawd 后续版本中加入，规划见 docs/plan-settings-panel.md。",
    toastSaveFailed: "保存失败：",
    langEnglish: "English",
    langChinese: "中文",
    themeTitle: "主题",
    themeSubtitle: "为 Clawd 选择一个主题。社区主题会放在你的用户主题目录里，可以在此删除。",
    themeEmpty: "没有可用的主题。",
    themeBadgeBuiltin: "内建",
    themeBadgeActive: "当前",
    themeActiveIndicator: "\u2713 当前",
    themeThumbMissing: "\u{1F3AD}",
    themeDeleteLabel: "删除主题",
    themeVariantStripLabel: "变体",
    toastThemeDeleted: "主题已删除。",
    toastThemeDeleteFailed: "删除主题失败：",
    animMapTitle: "动画映射",
    animMapSubtitle: "关掉不想看的打扰动画。事件照样会触发——Clawd 只是不再播放对应的动画和音效。",
    animMapSemanticsNote: "关闭 = 不播动画 + 不响音效。权限气泡、会话记录、终端聚焦照常工作。",
    animMapResetAll: "全部恢复",
    animMapAttentionLabel: "完成提示（happy）",
    animMapAttentionDesc: "Agent 结束一轮时的开心跳动（Stop / PostCompact）。",
    animMapErrorLabel: "错误提示",
    animMapErrorDesc: "工具调用失败时的抖动动画。",
    animMapSweepingLabel: "上下文清理",
    animMapSweepingDesc: "PreCompact / 清空上下文时的扫把动画。",
    animMapNotificationLabel: "通知提示",
    animMapNotificationDesc: "权限请求、消息询问时的铃铛动画。",
    animMapCarryingLabel: "Worktree 搬运",
    animMapCarryingDesc: "创建 worktree 时的搬运动画。",
    toastAnimMapResetOk: "动画覆盖已清空。",
    animOverridesTitle: "动画替换",
    animOverridesSubtitle: "按卡片换文件，并调整当前主题的淡入淡出与返回时机。",
    animOverridesCurrentTheme: "当前主题",
    animOverridesOpenThemeTab: "打开主题页",
    animOverridesOpenAssets: "打开素材目录",
    animOverridesResetAll: "全部恢复默认",
    animOverridesChangeFile: "换文件",
    animOverridesPreview: "预览一次",
    animOverridesReset: "恢复槽位",
    animOverridesFade: "Fade",
    animOverridesFadeIn: "入",
    animOverridesFadeOut: "出",
    animOverridesSaveFade: "保存 Fade",
    animOverridesDuration: "返回时长",
    animOverridesSaveDuration: "保存时长",
    animOverridesContinuousHint: "持续态不提供 auto-return 编辑。",
    animOverridesAssetCycle: "素材周期",
    animOverridesSuggestedTiming: "建议时长",
    animOverridesTimingEstimated: "估算",
    animOverridesTimingFallback: "主题默认值",
    animOverridesTimingUnavailable: "不可用",
    animOverridesDisplayHintWarning: "运行时可能被 displayHintMap 盖掉。",
    animOverridesModalTitle: "选择素材文件",
    animOverridesModalSubtitle: "把文件放进当前主题 assets 目录后，可在这里刷新列表重新选择。",
    animOverridesModalEmpty: "当前主题里还没有可用素材。",
    animOverridesModalSelected: "当前选中",
    animOverridesModalUse: "使用这个文件",
    animOverridesModalCancel: "取消",
    animOverridesRefresh: "刷新列表",
  },
};

let snapshot = null;
let activeTab = "general";
// Static per-agent metadata from agents/registry.js via settings:list-agents.
// Fetched once at boot (since it can't change while the app is running).
// Null until hydrated — renderAgentsTab() renders an empty placeholder.
let agentMetadata = null;

// Theme list cache. Unlike agents, this CAN change at runtime (user deletes
// a theme, drops a new one into the folder). Null until first fetch; refreshed
// on tab open, after removeTheme succeeds, and on `theme` broadcasts.
let themeList = null;
let animationOverridesData = null;
let assetPickerState = null;
let assetPickerPollTimer = null;

function t(key) {
  const lang = (snapshot && snapshot.lang) || "en";
  const dict = STRINGS[lang] || STRINGS.en;
  return dict[key] || key;
}

// ── Toast ──
const toastStack = document.getElementById("toastStack");
function showToast(message, { error = false, ttl = 3500 } = {}) {
  const node = document.createElement("div");
  node.className = "toast" + (error ? " error" : "");
  node.textContent = message;
  toastStack.appendChild(node);
  // Force reflow then add visible class so the transition runs.
  // eslint-disable-next-line no-unused-expressions
  node.offsetHeight;
  node.classList.add("visible");
  setTimeout(() => {
    node.classList.remove("visible");
    setTimeout(() => node.remove(), 240);
  }, ttl);
}

// ── Sidebar ──
const SIDEBAR_TABS = [
  { id: "general", icon: "\u2699", labelKey: "sidebarGeneral", available: true },
  { id: "agents", icon: "\u26A1", labelKey: "sidebarAgents", available: true },
  { id: "theme", icon: "\u{1F3A8}", labelKey: "sidebarTheme", available: true },
  { id: "animMap", icon: "\u{1F3AC}", labelKey: "sidebarAnimMap", available: true },
  { id: "animOverrides", icon: "\u{1F39E}", labelKey: "sidebarAnimOverrides", available: true },
  { id: "shortcuts", icon: "\u2328", labelKey: "sidebarShortcuts", available: false },
  { id: "about", icon: "\u2139", labelKey: "sidebarAbout", available: false },
];

function renderSidebar() {
  const sidebar = document.getElementById("sidebar");
  sidebar.innerHTML = "";
  for (const tab of SIDEBAR_TABS) {
    const item = document.createElement("div");
    item.className = "sidebar-item";
    if (!tab.available) item.classList.add("disabled");
    if (tab.id === activeTab) item.classList.add("active");
    item.innerHTML =
      `<span class="sidebar-item-icon">${tab.icon}</span>` +
      `<span class="sidebar-item-label">${escapeHtml(t(tab.labelKey))}</span>` +
      (tab.available ? "" : `<span class="sidebar-item-soon">${escapeHtml(t("sidebarSoon"))}</span>`);
    if (tab.available) {
      item.addEventListener("click", () => {
        activeTab = tab.id;
        renderSidebar();
        renderContent();
      });
    }
    sidebar.appendChild(item);
  }
}

// ── Content ──
function renderContent() {
  const content = document.getElementById("content");
  if (activeTab !== "animOverrides" && assetPickerState) closeAssetPicker();
  content.innerHTML = "";
  if (activeTab === "general") {
    renderGeneralTab(content);
  } else if (activeTab === "agents") {
    renderAgentsTab(content);
  } else if (activeTab === "theme") {
    renderThemeTab(content);
  } else if (activeTab === "animMap") {
    renderAnimMapTab(content);
  } else if (activeTab === "animOverrides") {
    renderAnimOverridesTab(content);
  } else {
    renderPlaceholder(content);
  }
}

// ── Animation Map tab (Phase 3b — Disable-only) ──

// 每行一个 oneshot state。顺序影响 UI 排列——按优先级从高到低。
const ANIM_MAP_ROWS = [
  { stateKey: "error",        labelKey: "animMapErrorLabel",        descKey: "animMapErrorDesc" },
  { stateKey: "notification", labelKey: "animMapNotificationLabel", descKey: "animMapNotificationDesc" },
  { stateKey: "sweeping",     labelKey: "animMapSweepingLabel",     descKey: "animMapSweepingDesc" },
  { stateKey: "attention",    labelKey: "animMapAttentionLabel",    descKey: "animMapAttentionDesc" },
  { stateKey: "carrying",     labelKey: "animMapCarryingLabel",     descKey: "animMapCarryingDesc" },
];

function renderAnimMapTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("animMapTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("animMapSubtitle");
  parent.appendChild(subtitle);

  const note = document.createElement("p");
  note.className = "subtitle";
  note.textContent = t("animMapSemanticsNote");
  parent.appendChild(note);

  const themeId = (snapshot && snapshot.theme) || "clawd";
  const rows = ANIM_MAP_ROWS.map((spec) => buildAnimMapRow(spec, themeId));
  parent.appendChild(buildSection("", rows));

  const hasAny = readThemeOverrideMap(themeId) !== null;
  const resetWrap = document.createElement("div");
  resetWrap.className = "anim-map-reset";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "theme-delete-btn anim-map-reset-btn";
  resetBtn.textContent = t("animMapResetAll");
  if (!hasAny) resetBtn.disabled = true;
  attachActivation(resetBtn, () =>
    window.settingsAPI.command("resetThemeOverrides", { themeId })
      .then((result) => {
        if (result && result.status === "ok" && !result.noop) {
          showToast(t("toastAnimMapResetOk"));
        }
        return result;
      })
  );
  resetWrap.appendChild(resetBtn);
  parent.appendChild(resetWrap);
}

function readThemeOverrideMap(themeId) {
  const all = snapshot && snapshot.themeOverrides;
  const map = all && all[themeId];
  if (!map || typeof map !== "object") return null;
  const keys = [
    ...(map.states ? Object.keys(map.states) : []),
    ...(map.tiers && map.tiers.workingTiers ? Object.keys(map.tiers.workingTiers) : []),
    ...(map.tiers && map.tiers.jugglingTiers ? Object.keys(map.tiers.jugglingTiers) : []),
    ...(map.timings && map.timings.autoReturn ? Object.keys(map.timings.autoReturn) : []),
  ];
  return keys.length > 0 ? map : null;
}

function isStateDisabled(themeId, stateKey) {
  const map = readThemeOverrideMap(themeId);
  const states = map && map.states;
  const entry = (states && states[stateKey]) || (map && map[stateKey]);
  return !!(entry && entry.disabled === true);
}

function buildAnimMapRow(spec, themeId) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
    `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
  row.querySelector(".row-label").textContent = t(spec.labelKey);
  row.querySelector(".row-desc").textContent = t(spec.descKey);
  const sw = row.querySelector(".switch");

  const disabled = isStateDisabled(themeId, spec.stateKey);
  const visualOn = !disabled; // ON = 动画启用
  if (visualOn) sw.classList.add("on");
  sw.setAttribute("aria-checked", visualOn ? "true" : "false");

  attachActivation(sw, () => {
    const nextDisabled = !isStateDisabled(themeId, spec.stateKey);
    return window.settingsAPI.command("setThemeOverrideDisabled", {
      themeId,
      stateKey: spec.stateKey,
      disabled: nextDisabled,
    });
  });
  return row;
}

// ── Theme tab ──

function fetchThemes() {
  if (!window.settingsAPI || typeof window.settingsAPI.listThemes !== "function") {
    themeList = [];
    return Promise.resolve([]);
  }
  return window.settingsAPI.listThemes().then((list) => {
    themeList = Array.isArray(list) ? list : [];
    return themeList;
  }).catch((err) => {
    console.warn("settings: listThemes failed", err);
    themeList = [];
    return [];
  });
}

function renderThemeTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("themeTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("themeSubtitle");
  parent.appendChild(subtitle);

  if (themeList === null) {
    const loading = document.createElement("div");
    loading.className = "placeholder-desc";
    parent.appendChild(loading);
    fetchThemes().then(() => {
      if (activeTab === "theme") renderContent();
    });
    return;
  }

  if (themeList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "placeholder";
    empty.innerHTML = `<div class="placeholder-desc">${escapeHtml(t("themeEmpty"))}</div>`;
    parent.appendChild(empty);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "theme-grid";
  for (const theme of themeList) {
    grid.appendChild(buildThemeCard(theme));
  }
  parent.appendChild(grid);
}

// Resolve an `{en, zh}` object or a plain string to a localized string.
// Falls back across languages before giving up.
function localizeField(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const lang = (snapshot && snapshot.lang) || "en";
    if (value[lang]) return value[lang];
    if (value.en) return value.en;
    if (value.zh) return value.zh;
    const firstKey = Object.keys(value)[0];
    if (firstKey) return value[firstKey];
  }
  return "";
}

function buildThemeCard(theme) {
  const card = document.createElement("div");
  card.className = "theme-card";
  card.setAttribute("role", "radio");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-checked", theme.active ? "true" : "false");
  if (theme.active) card.classList.add("active");

  const thumb = document.createElement("div");
  thumb.className = "theme-thumb";
  if (theme.previewFileUrl) {
    const img = document.createElement("img");
    img.src = theme.previewFileUrl;
    img.alt = "";
    img.draggable = false;
    thumb.appendChild(img);
  } else {
    const glyph = document.createElement("span");
    glyph.className = "theme-thumb-empty";
    glyph.textContent = t("themeThumbMissing");
    thumb.appendChild(glyph);
  }
  card.appendChild(thumb);

  const name = document.createElement("div");
  name.className = "theme-card-name";
  const nameText = document.createElement("span");
  nameText.className = "theme-card-name-text";
  nameText.textContent = theme.name || theme.id;
  name.appendChild(nameText);
  if (theme.builtin) {
    const badge = document.createElement("span");
    badge.className = "theme-card-badge";
    badge.textContent = t("themeBadgeBuiltin");
    name.appendChild(badge);
  }
  card.appendChild(name);

  const canDelete = !theme.builtin && !theme.active;
  if (theme.active || canDelete) {
    const footer = document.createElement("div");
    footer.className = "theme-card-footer";
    const indicator = document.createElement("span");
    indicator.className = "theme-card-check";
    indicator.textContent = theme.active ? t("themeActiveIndicator") : "";
    footer.appendChild(indicator);
    if (canDelete) {
      const btn = document.createElement("button");
      btn.className = "theme-delete-btn";
      btn.type = "button";
      btn.textContent = "\u{1F5D1}";
      btn.title = t("themeDeleteLabel");
      btn.setAttribute("aria-label", t("themeDeleteLabel"));
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        handleDeleteTheme(theme);
      });
      footer.appendChild(btn);
    }
    card.appendChild(footer);
  }

  if (!theme.active) {
    // Phase 3b-swap: theme switches go through setThemeSelection so the
    // stored themeVariant[themeId] is honoured (or self-healed on dead ids).
    // applyUpdate("theme", id) would bypass the variant-resolution path.
    attachActivation(card, () => window.settingsAPI.command("setThemeSelection", { themeId: theme.id }));
  }
  return card;
}

function handleDeleteTheme(theme) {
  if (!window.settingsAPI) return;
  window.settingsAPI
    .confirmRemoveTheme(theme.id)
    .then((res) => {
      if (!res || !res.confirmed) return null;
      return window.settingsAPI.command("removeTheme", theme.id);
    })
    .then((result) => {
      if (result == null) return;
      if (result.status !== "ok") {
        const msg = (result && result.message) || "unknown error";
        showToast(t("toastThemeDeleteFailed") + msg, { error: true });
        return;
      }
      showToast(t("toastThemeDeleted"));
      fetchThemes().then(() => {
        if (activeTab === "theme") renderContent();
      });
    })
    .catch((err) => {
      showToast(t("toastThemeDeleteFailed") + (err && err.message), { error: true });
    });
}

function fetchAnimationOverridesData() {
  if (!window.settingsAPI || typeof window.settingsAPI.getAnimationOverridesData !== "function") {
    animationOverridesData = { theme: null, assets: [], cards: [] };
    return Promise.resolve(animationOverridesData);
  }
  return window.settingsAPI.getAnimationOverridesData().then((data) => {
    animationOverridesData = data || { theme: null, assets: [], cards: [] };
    return animationOverridesData;
  }).catch((err) => {
    console.warn("settings: getAnimationOverridesData failed", err);
    animationOverridesData = { theme: null, assets: [], cards: [] };
    return animationOverridesData;
  });
}

function getAnimOverrideCardById(cardId) {
  const cards = animationOverridesData && animationOverridesData.cards;
  return Array.isArray(cards) ? cards.find((card) => card.id === cardId) || null : null;
}

function getAnimationAssetsSignature(data = animationOverridesData) {
  const assets = data && Array.isArray(data.assets) ? data.assets : [];
  return assets.map((asset) => [
    asset.name,
    asset.cycleMs == null ? "" : asset.cycleMs,
    asset.cycleStatus || "",
  ].join(":")).join("\n");
}

function stopAssetPickerPolling() {
  if (assetPickerPollTimer) {
    clearInterval(assetPickerPollTimer);
    assetPickerPollTimer = null;
  }
}

function closeAssetPicker() {
  assetPickerState = null;
  stopAssetPickerPolling();
  renderAssetPickerModal();
}

function normalizeAssetPickerSelection() {
  if (!assetPickerState || !animationOverridesData) return;
  const assets = Array.isArray(animationOverridesData.assets) ? animationOverridesData.assets : [];
  if (!assets.length) {
    assetPickerState.selectedFile = null;
    return;
  }
  const stillExists = assets.some((asset) => asset.name === assetPickerState.selectedFile);
  if (!stillExists) assetPickerState.selectedFile = assets[0].name;
}

function captureAssetPickerScrollState() {
  if (!assetPickerState) return;
  const list = document.querySelector(".asset-picker-list");
  if (!list) return;
  assetPickerState.listScrollTop = list.scrollTop;
}

function restoreAssetPickerScrollState(list) {
  if (!list || !assetPickerState || typeof assetPickerState.listScrollTop !== "number") return;
  const target = assetPickerState.listScrollTop;
  list.scrollTop = target;
  requestAnimationFrame(() => {
    if (document.body.contains(list)) list.scrollTop = target;
  });
}

function shouldRefreshAssetPickerModal({ previousSignature, previousSelectedFile }) {
  if (!assetPickerState) return false;
  if (assetPickerState.selectedFile !== previousSelectedFile) return true;
  return getAnimationAssetsSignature() !== previousSignature;
}

function startAssetPickerPolling() {
  stopAssetPickerPolling();
  assetPickerPollTimer = setInterval(() => {
    if (!assetPickerState) return;
    const previousSignature = getAnimationAssetsSignature();
    const previousSelectedFile = assetPickerState.selectedFile;
    fetchAnimationOverridesData().then(() => {
      normalizeAssetPickerSelection();
      if (shouldRefreshAssetPickerModal({ previousSignature, previousSelectedFile })) {
        renderAssetPickerModal();
      }
    });
  }, 1500);
}

function previewStateForCard(card) {
  if (!card) return null;
  if (card.slotType === "tier") {
    return card.tierGroup === "jugglingTiers" ? "juggling" : "working";
  }
  return card.stateKey;
}

function buildAnimOverrideRequest(card, patch) {
  const themeId = animationOverridesData && animationOverridesData.theme && animationOverridesData.theme.id;
  const base = {
    themeId,
    slotType: card.slotType,
  };
  if (card.slotType === "tier") {
    base.tierGroup = card.tierGroup;
    base.originalFile = card.originalFile;
  } else {
    base.stateKey = card.stateKey;
  }
  return { ...base, ...patch };
}

function runAnimationOverrideCommand(card, patch) {
  const payload = buildAnimOverrideRequest(card, patch);
  return window.settingsAPI.command("setAnimationOverride", payload).then((result) => {
    if (!result || result.status !== "ok" || result.noop) return result;
    return fetchAnimationOverridesData().then(() => {
      normalizeAssetPickerSelection();
      if (activeTab === "animOverrides") renderContent();
      renderAssetPickerModal();
      return result;
    });
  });
}

function openAssetPicker(card) {
  assetPickerState = {
    cardId: card.id,
    selectedFile: card.currentFile,
  };
  renderAssetPickerModal();
  startAssetPickerPolling();
}

function formatSessionRange(minSessions, maxSessions) {
  const isZh = ((snapshot && snapshot.lang) || "en") === "zh";
  if (maxSessions == null) return isZh ? `${minSessions}+ 会话` : `${minSessions}+ sessions`;
  if (minSessions === maxSessions) return isZh ? `${minSessions} 会话` : `${minSessions} session${minSessions === 1 ? "" : "s"}`;
  return isZh ? `${minSessions}-${maxSessions} 会话` : `${minSessions}-${maxSessions} sessions`;
}

function getAnimOverrideTriggerLabel(card) {
  switch (card.triggerKind) {
    case "thinking": return "UserPromptSubmit";
    case "working": return `PreToolUse (${formatSessionRange(card.minSessions, card.maxSessions)})`;
    case "juggling": return `SubagentStart (${formatSessionRange(card.minSessions, card.maxSessions)})`;
    case "error": return "PostToolUseFailure";
    case "attention": return "Stop / PostCompact";
    case "notification": return "PermissionRequest";
    case "sweeping": return "PreCompact";
    case "carrying": return "WorktreeCreate";
    case "sleeping": return "60s no events";
    case "waking": return "Wake";
    default: return card.triggerKind || card.stateKey || card.id;
  }
}

function buildAnimPreviewNode(fileUrl) {
  const frame = document.createElement("div");
  frame.className = "anim-override-preview-frame";
  if (fileUrl) {
    const img = document.createElement("img");
    img.src = fileUrl;
    img.alt = "";
    img.draggable = false;
    frame.appendChild(img);
  } else {
    const glyph = document.createElement("span");
    glyph.className = "theme-thumb-empty";
    glyph.textContent = t("themeThumbMissing");
    frame.appendChild(glyph);
  }
  return frame;
}

function renderAnimOverridesTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("animOverridesTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("animOverridesSubtitle");
  parent.appendChild(subtitle);

  if (animationOverridesData === null) {
    const loading = document.createElement("div");
    loading.className = "placeholder-desc";
    parent.appendChild(loading);
    fetchAnimationOverridesData().then(() => {
      if (activeTab === "animOverrides") renderContent();
    });
    return;
  }

  const data = animationOverridesData;
  const themeMeta = document.createElement("div");
  themeMeta.className = "anim-override-meta";
  const themeLabel = document.createElement("div");
  themeLabel.className = "anim-override-meta-label";
  themeLabel.textContent = `${t("animOverridesCurrentTheme")}: ${(data.theme && data.theme.name) || "clawd"}`;
  themeMeta.appendChild(themeLabel);

  const themeBtn = document.createElement("button");
  themeBtn.type = "button";
  themeBtn.className = "soft-btn";
  themeBtn.textContent = t("animOverridesOpenThemeTab");
  themeBtn.addEventListener("click", () => {
    activeTab = "theme";
    renderSidebar();
    renderContent();
  });
  themeMeta.appendChild(themeBtn);

  const assetsBtn = document.createElement("button");
  assetsBtn.type = "button";
  assetsBtn.className = "soft-btn";
  assetsBtn.textContent = t("animOverridesOpenAssets");
  attachActivation(assetsBtn, () => window.settingsAPI.openThemeAssetsDir());
  themeMeta.appendChild(assetsBtn);

  const themeId = data.theme && data.theme.id;
  const resetAllBtn = document.createElement("button");
  resetAllBtn.type = "button";
  resetAllBtn.className = "soft-btn";
  resetAllBtn.textContent = t("animOverridesResetAll");
  resetAllBtn.disabled = !themeId || readThemeOverrideMap(themeId) === null;
  attachActivation(resetAllBtn, () =>
    window.settingsAPI.command("resetThemeOverrides", { themeId }).then((result) => {
      if (result && result.status === "ok" && !result.noop) {
        showToast(t("toastAnimMapResetOk"));
      }
      return result;
    })
  );
  themeMeta.appendChild(resetAllBtn);
  parent.appendChild(themeMeta);

  const cards = Array.isArray(data.cards) ? data.cards : [];
  const grid = document.createElement("div");
  grid.className = "anim-override-grid";
  for (const card of cards) {
    grid.appendChild(buildAnimOverrideCard(card));
  }
  parent.appendChild(grid);
  renderAssetPickerModal();
}

function buildAnimOverrideCard(card) {
  const wrap = document.createElement("section");
  wrap.className = "anim-override-card";

  const preview = document.createElement("div");
  preview.className = "anim-override-preview";
  preview.appendChild(buildAnimPreviewNode(card.currentFileUrl));
  wrap.appendChild(preview);

  const body = document.createElement("div");
  body.className = "anim-override-body";

  const trigger = document.createElement("div");
  trigger.className = "anim-override-trigger";
  trigger.textContent = getAnimOverrideTriggerLabel(card);
  body.appendChild(trigger);

  const file = document.createElement("div");
  file.className = "anim-override-file";
  file.textContent = card.currentFile;
  body.appendChild(file);

  const binding = document.createElement("div");
  binding.className = "anim-override-binding";
  binding.textContent = card.bindingLabel;
  body.appendChild(binding);

  if (card.displayHintWarning) {
    const warning = document.createElement("div");
    warning.className = "anim-override-warning";
    warning.textContent = t("animOverridesDisplayHintWarning");
    body.appendChild(warning);
  }

  const actions = document.createElement("div");
  actions.className = "anim-override-actions";

  const changeBtn = document.createElement("button");
  changeBtn.type = "button";
  changeBtn.className = "soft-btn accent";
  changeBtn.textContent = t("animOverridesChangeFile");
  changeBtn.addEventListener("click", () => openAssetPicker(card));
  actions.appendChild(changeBtn);

  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.className = "soft-btn";
  previewBtn.textContent = t("animOverridesPreview");
  attachActivation(previewBtn, () =>
    window.settingsAPI.previewAnimationOverride({
      stateKey: previewStateForCard(card),
      file: card.currentFile,
      durationMs: getAnimationPreviewDuration(null, card),
    })
  );
  actions.appendChild(previewBtn);

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "soft-btn";
  resetBtn.textContent = t("animOverridesReset");
  attachActivation(resetBtn, () =>
    runAnimationOverrideCommand(card, {
      file: null,
      transition: null,
      ...(card.supportsAutoReturn ? { autoReturnMs: null } : {}),
    })
  );
  actions.appendChild(resetBtn);
  body.appendChild(actions);

  const editors = document.createElement("div");
  editors.className = "anim-override-editors";

  const fadeBlock = document.createElement("div");
  fadeBlock.className = "anim-override-editor";
  const fadeTitle = document.createElement("div");
  fadeTitle.className = "anim-override-editor-title";
  fadeTitle.textContent = t("animOverridesFade");
  fadeBlock.appendChild(fadeTitle);
  const fadeFields = document.createElement("div");
  fadeFields.className = "anim-override-inline-fields";
  const inInput = document.createElement("input");
  inInput.type = "number";
  inInput.min = "0";
  inInput.step = "10";
  inInput.value = String(card.transition.in);
  const outInput = document.createElement("input");
  outInput.type = "number";
  outInput.min = "0";
  outInput.step = "10";
  outInput.value = String(card.transition.out);
  fadeFields.appendChild(buildInlineField(t("animOverridesFadeIn"), inInput));
  fadeFields.appendChild(buildInlineField(t("animOverridesFadeOut"), outInput));
  fadeBlock.appendChild(fadeFields);
  const fadeSave = document.createElement("button");
  fadeSave.type = "button";
  fadeSave.className = "soft-btn";
  fadeSave.textContent = t("animOverridesSaveFade");
  attachActivation(fadeSave, () => {
    const fadeIn = Number(inInput.value);
    const fadeOut = Number(outInput.value);
    if (!Number.isFinite(fadeIn) || fadeIn < 0 || !Number.isFinite(fadeOut) || fadeOut < 0) {
      return { status: "error", message: "fade values must be non-negative numbers" };
    }
    return runAnimationOverrideCommand(card, { transition: { in: fadeIn, out: fadeOut } });
  });
  fadeBlock.appendChild(fadeSave);
  editors.appendChild(fadeBlock);

  const timingBlock = document.createElement("div");
  timingBlock.className = "anim-override-editor";
  const timingTitle = document.createElement("div");
  timingTitle.className = "anim-override-editor-title";
  timingTitle.textContent = t("animOverridesDuration");
  timingBlock.appendChild(timingTitle);
  timingBlock.appendChild(buildAnimTimingHint(
    t("animOverridesAssetCycle"),
    card.assetCycleMs,
    card.assetCycleStatus
  ));
  if (card.supportsAutoReturn && card.assetCycleMs == null && card.suggestedDurationMs != null) {
    timingBlock.appendChild(buildAnimTimingHint(
      t("animOverridesSuggestedTiming"),
      card.suggestedDurationMs,
      card.suggestedDurationStatus
    ));
  }
  if (card.supportsAutoReturn) {
    const timingInput = document.createElement("input");
    timingInput.type = "number";
    timingInput.min = "500";
    timingInput.max = "60000";
    timingInput.step = "100";
    timingInput.value = card.autoReturnMs == null ? "" : String(card.autoReturnMs);
    if (card.suggestedDurationMs != null && card.suggestedDurationMs !== card.autoReturnMs) {
      timingInput.placeholder = String(card.suggestedDurationMs);
    }
    timingBlock.appendChild(buildInlineField("ms", timingInput));
    const timingSave = document.createElement("button");
    timingSave.type = "button";
    timingSave.className = "soft-btn";
    timingSave.textContent = t("animOverridesSaveDuration");
    attachActivation(timingSave, () => {
      const value = Number(timingInput.value);
      if (!Number.isFinite(value) || value < 500 || value > 60000) {
        return { status: "error", message: "auto-return must be between 500 and 60000 ms" };
      }
      return runAnimationOverrideCommand(card, { autoReturnMs: value });
    });
    timingBlock.appendChild(timingSave);
  } else {
    const hint = document.createElement("div");
    hint.className = "anim-override-binding";
    hint.textContent = t("animOverridesContinuousHint");
    timingBlock.appendChild(hint);
  }
  editors.appendChild(timingBlock);
  body.appendChild(editors);

  wrap.appendChild(body);
  return wrap;
}

function buildInlineField(labelText, input) {
  const wrap = document.createElement("label");
  wrap.className = "anim-override-inline-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(input);
  return wrap;
}

function formatAnimTimingValue(ms, status) {
  let text = Number.isFinite(ms) && ms > 0
    ? `${ms} ms`
    : t("animOverridesTimingUnavailable");
  if (status === "estimated") text += ` (${t("animOverridesTimingEstimated")})`;
  else if (status === "fallback") text += ` (${t("animOverridesTimingFallback")})`;
  return text;
}

function buildAnimTimingHint(label, ms, status) {
  const line = document.createElement("div");
  line.className = "anim-override-binding";
  line.textContent = `${label}: ${formatAnimTimingValue(ms, status)}`;
  return line;
}

function getAnimationPreviewDuration(asset, card) {
  if (asset && Number.isFinite(asset.cycleMs) && asset.cycleMs > 0) return asset.cycleMs;
  if (card && Number.isFinite(card.previewDurationMs) && card.previewDurationMs > 0) return card.previewDurationMs;
  if (card && card.supportsAutoReturn && Number.isFinite(card.autoReturnMs) && card.autoReturnMs > 0) {
    return card.autoReturnMs;
  }
  return null;
}

function getSelectedAnimationAsset() {
  if (!assetPickerState || !animationOverridesData) return null;
  const assets = Array.isArray(animationOverridesData.assets) ? animationOverridesData.assets : [];
  return assets.find((asset) => asset.name === assetPickerState.selectedFile) || null;
}

function populateAssetPickerDetail(detail, selected) {
  detail.innerHTML = "";
  detail.appendChild(buildAnimPreviewNode(selected && selected.fileUrl));
  const selectedLabel = document.createElement("div");
  selectedLabel.className = "anim-override-file";
  selectedLabel.textContent = `${t("animOverridesModalSelected")}: ${selected ? selected.name : "-"}`;
  detail.appendChild(selectedLabel);
  detail.appendChild(buildAnimTimingHint(
    t("animOverridesAssetCycle"),
    selected && selected.cycleMs,
    selected && selected.cycleStatus
  ));
}

function syncAssetPickerSelectionUi() {
  const root = document.getElementById("modalRoot");
  if (!root || !assetPickerState) return;
  const selected = getSelectedAnimationAsset();
  for (const item of root.querySelectorAll(".asset-picker-item")) {
    item.classList.toggle("active", item.dataset.assetName === (selected && selected.name));
  }
  const detail = root.querySelector(".asset-picker-detail");
  if (detail) populateAssetPickerDetail(detail, selected);
  const previewBtn = root.querySelector(".asset-picker-preview-btn");
  if (previewBtn) previewBtn.disabled = !selected;
  const useBtn = root.querySelector(".asset-picker-use-btn");
  if (useBtn) useBtn.disabled = !selected;
}

function renderAssetPickerModal() {
  const root = document.getElementById("modalRoot");
  if (!root) return;
  captureAssetPickerScrollState();
  root.innerHTML = "";
  if (!assetPickerState || !animationOverridesData) return;
  const card = getAnimOverrideCardById(assetPickerState.cardId);
  if (!card) {
    closeAssetPicker();
    return;
  }
  normalizeAssetPickerSelection();
  const assets = Array.isArray(animationOverridesData.assets) ? animationOverridesData.assets : [];
  const selected = getSelectedAnimationAsset();

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeAssetPicker();
  });

  const modal = document.createElement("div");
  modal.className = "asset-picker-modal";

  const title = document.createElement("h2");
  title.textContent = t("animOverridesModalTitle");
  modal.appendChild(title);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("animOverridesModalSubtitle");
  modal.appendChild(subtitle);

  const refreshRow = document.createElement("div");
  refreshRow.className = "asset-picker-toolbar";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "soft-btn";
  refreshBtn.textContent = t("animOverridesRefresh");
  attachActivation(refreshBtn, () => fetchAnimationOverridesData().then(() => {
    normalizeAssetPickerSelection();
    renderAssetPickerModal();
    return { status: "ok" };
  }));
  refreshRow.appendChild(refreshBtn);

  const openAssetsBtn = document.createElement("button");
  openAssetsBtn.type = "button";
  openAssetsBtn.className = "soft-btn";
  openAssetsBtn.textContent = t("animOverridesOpenAssets");
  attachActivation(openAssetsBtn, () => window.settingsAPI.openThemeAssetsDir());
  refreshRow.appendChild(openAssetsBtn);
  modal.appendChild(refreshRow);

  const body = document.createElement("div");
  body.className = "asset-picker-body";

  const list = document.createElement("div");
  list.className = "asset-picker-list";
  if (!assets.length) {
    const empty = document.createElement("div");
    empty.className = "placeholder-desc";
    empty.textContent = t("animOverridesModalEmpty");
    list.appendChild(empty);
  } else {
    for (const asset of assets) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "asset-picker-item" + (selected && selected.name === asset.name ? " active" : "");
      item.dataset.assetName = asset.name;
      item.textContent = asset.name;
      item.addEventListener("click", () => {
        assetPickerState.selectedFile = asset.name;
        syncAssetPickerSelectionUi();
      });
      list.appendChild(item);
    }
  }
  body.appendChild(list);
  restoreAssetPickerScrollState(list);

  const detail = document.createElement("div");
  detail.className = "asset-picker-detail";
  populateAssetPickerDetail(detail, selected);
  body.appendChild(detail);
  modal.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "asset-picker-footer";

  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.className = "soft-btn asset-picker-preview-btn";
  previewBtn.textContent = t("animOverridesPreview");
  previewBtn.disabled = !selected;
  attachActivation(previewBtn, () => {
    const currentSelected = getSelectedAnimationAsset();
    if (!currentSelected) return { status: "error", message: "no asset selected" };
    return window.settingsAPI.previewAnimationOverride({
      stateKey: previewStateForCard(card),
      file: currentSelected.name,
      durationMs: getAnimationPreviewDuration(currentSelected, card),
    });
  });
  footer.appendChild(previewBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "soft-btn";
  cancelBtn.textContent = t("animOverridesModalCancel");
  cancelBtn.addEventListener("click", () => closeAssetPicker());
  footer.appendChild(cancelBtn);

  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.className = "soft-btn accent asset-picker-use-btn";
  useBtn.textContent = t("animOverridesModalUse");
  useBtn.disabled = !selected;
  attachActivation(useBtn, () => {
    const currentSelected = getSelectedAnimationAsset();
    if (!currentSelected) return { status: "error", message: "no asset selected" };
    return runAnimationOverrideCommand(card, { file: currentSelected.name }).then((result) => {
      if (result && result.status === "ok") {
        closeAssetPicker();
        if (window.settingsAPI && typeof window.settingsAPI.previewAnimationOverride === "function") {
          window.settingsAPI.previewAnimationOverride({
            stateKey: previewStateForCard(card),
            file: currentSelected.name,
            durationMs: getAnimationPreviewDuration(currentSelected, card),
          }).then((previewResult) => {
            if (!previewResult || previewResult.status === "ok") return;
            showToast(t("toastSaveFailed") + previewResult.message, { error: true });
          }).catch((err) => {
            showToast(t("toastSaveFailed") + (err && err.message), { error: true });
          });
        }
      }
      return result;
    });
  });
  footer.appendChild(useBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  root.appendChild(overlay);
}

function renderAgentsTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("agentsTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("agentsSubtitle");
  parent.appendChild(subtitle);

  if (!agentMetadata || agentMetadata.length === 0) {
    const empty = document.createElement("div");
    empty.className = "placeholder";
    empty.innerHTML = `<div class="placeholder-desc">${escapeHtml(t("agentsEmpty"))}</div>`;
    parent.appendChild(empty);
    return;
  }

  const rows = agentMetadata.flatMap((agent) => buildAgentRows(agent));
  parent.appendChild(buildSection("", rows));
}

function buildAgentRows(agent) {
  const rows = [
    buildAgentSwitchRow({
      agent,
      flag: "enabled",
      extraClass: null,
      buildText: (text) => {
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = agent.name || agent.id;
        text.appendChild(label);
        const badges = document.createElement("span");
        badges.className = "row-desc agent-badges";
        const esKey = agent.eventSource === "log-poll" ? "eventSourceLogPoll"
          : agent.eventSource === "plugin-event" ? "eventSourcePlugin"
          : "eventSourceHook";
        const esBadge = document.createElement("span");
        esBadge.className = "agent-badge";
        esBadge.textContent = t(esKey);
        badges.appendChild(esBadge);
        if (agent.capabilities && agent.capabilities.permissionApproval) {
          const permBadge = document.createElement("span");
          permBadge.className = "agent-badge accent";
          permBadge.textContent = t("badgePermissionBubble");
          badges.appendChild(permBadge);
        }
        text.appendChild(badges);
      },
    }),
  ];
  const caps = agent.capabilities || {};
  if (caps.permissionApproval || caps.interactiveBubble) {
    rows.push(buildAgentSwitchRow({
      agent,
      flag: "permissionsEnabled",
      extraClass: "row-sub",
      buildText: (text) => {
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = t("rowAgentPermissions");
        text.appendChild(label);
        const desc = document.createElement("span");
        desc.className = "row-desc";
        desc.textContent = t("rowAgentPermissionsDesc");
        text.appendChild(desc);
      },
    }));
  }
  return rows;
}

function buildAgentSwitchRow({ agent, flag, extraClass, buildText }) {
  const row = document.createElement("div");
  row.className = extraClass ? `row ${extraClass}` : "row";

  const text = document.createElement("div");
  text.className = "row-text";
  buildText(text);
  row.appendChild(text);

  const ctrl = document.createElement("div");
  ctrl.className = "row-control";
  const sw = document.createElement("div");
  sw.className = "switch";
  sw.setAttribute("role", "switch");
  sw.setAttribute("tabindex", "0");
  const readFlag = () => {
    const entry = snapshot && snapshot.agents && snapshot.agents[agent.id];
    return entry ? entry[flag] !== false : true;
  };
  const on = readFlag();
  if (on) sw.classList.add("on");
  sw.setAttribute("aria-checked", on ? "true" : "false");
  attachActivation(sw, () =>
    window.settingsAPI.command("setAgentFlag", {
      agentId: agent.id,
      flag,
      value: !readFlag(),
    })
  );
  ctrl.appendChild(sw);
  row.appendChild(ctrl);
  return row;
}

function renderPlaceholder(parent) {
  const div = document.createElement("div");
  div.className = "placeholder";
  div.innerHTML =
    `<div class="placeholder-icon">\u{1F6E0}</div>` +
    `<div class="placeholder-title">${escapeHtml(t("placeholderTitle"))}</div>` +
    `<div class="placeholder-desc">${escapeHtml(t("placeholderDesc"))}</div>`;
  parent.appendChild(div);
}

function renderGeneralTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("settingsTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("settingsSubtitle");
  parent.appendChild(subtitle);

  // Section: Appearance
  parent.appendChild(buildSection(t("sectionAppearance"), [
    buildLanguageRow(),
    buildSwitchRow({
      key: "soundMuted",
      labelKey: "rowSound",
      descKey: "rowSoundDesc",
      // soundMuted is inverse: ON-switch means sound enabled.
      invert: true,
    }),
  ]));

  // Section: Startup
  parent.appendChild(buildSection(t("sectionStartup"), [
    buildSwitchRow({
      key: "openAtLogin",
      labelKey: "rowOpenAtLogin",
      descKey: "rowOpenAtLoginDesc",
    }),
    buildSwitchRow({
      key: "autoStartWithClaude",
      labelKey: "rowStartWithClaude",
      descKey: "rowStartWithClaudeDesc",
    }),
  ]));

  // Section: Bubbles
  parent.appendChild(buildSection(t("sectionBubbles"), [
    buildSwitchRow({
      key: "bubbleFollowPet",
      labelKey: "rowBubbleFollow",
      descKey: "rowBubbleFollowDesc",
    }),
    buildSwitchRow({
      key: "hideBubbles",
      labelKey: "rowHideBubbles",
      descKey: "rowHideBubblesDesc",
    }),
    buildSwitchRow({
      key: "showSessionId",
      labelKey: "rowShowSessionId",
      descKey: "rowShowSessionIdDesc",
    }),
  ]));
}

function buildSection(title, rows) {
  const section = document.createElement("section");
  section.className = "section";
  if (title) {
    const heading = document.createElement("h2");
    heading.className = "section-title";
    heading.textContent = title;
    section.appendChild(heading);
  }
  const wrap = document.createElement("div");
  wrap.className = "section-rows";
  for (const row of rows) wrap.appendChild(row);
  section.appendChild(wrap);
  return section;
}

// Wire click + Space/Enter keydown on any element to an async invoker that
// returns a `Promise<{status, message?}>`. Shared by switches and cards.
function attachActivation(el, invoke) {
  const run = () => {
    if (el.classList.contains("pending")) return;
    el.classList.add("pending");
    Promise.resolve()
      .then(invoke)
      .then((result) => {
        el.classList.remove("pending");
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          showToast(t("toastSaveFailed") + msg, { error: true });
        }
      })
      .catch((err) => {
        el.classList.remove("pending");
        showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
  };
  el.addEventListener("click", run);
  el.addEventListener("keydown", (ev) => {
    if (ev.key === " " || ev.key === "Enter") {
      ev.preventDefault();
      run();
    }
  });
}

function buildSwitchRow({ key, labelKey, descKey, invert = false }) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
    `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
  row.querySelector(".row-label").textContent = t(labelKey);
  row.querySelector(".row-desc").textContent = t(descKey);
  const sw = row.querySelector(".switch");
  const rawValue = !!(snapshot && snapshot[key]);
  const visualOn = invert ? !rawValue : rawValue;
  if (visualOn) sw.classList.add("on");
  sw.setAttribute("aria-checked", visualOn ? "true" : "false");
  // No optimistic update — visual state flips on broadcast, not on click.
  // If the action fails, the broadcast never fires and the switch stays.
  attachActivation(sw, () => {
    const currentRaw = !!(snapshot && snapshot[key]);
    const currentVisual = invert ? !currentRaw : currentRaw;
    const nextRaw = invert ? currentVisual : !currentVisual;
    return window.settingsAPI.update(key, nextRaw);
  });
  return row;
}

function buildLanguageRow() {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
    `<div class="row-control">` +
      `<div class="segmented" role="tablist">` +
        `<button data-lang="en"></button>` +
        `<button data-lang="zh"></button>` +
      `</div>` +
    `</div>`;
  row.querySelector(".row-label").textContent = t("rowLanguage");
  row.querySelector(".row-desc").textContent = t("rowLanguageDesc");
  const buttons = row.querySelectorAll(".segmented button");
  buttons[0].textContent = t("langEnglish");
  buttons[1].textContent = t("langChinese");
  const current = (snapshot && snapshot.lang) || "en";
  for (const btn of buttons) {
    if (btn.dataset.lang === current) btn.classList.add("active");
    btn.addEventListener("click", () => {
      const next = btn.dataset.lang;
      if (next === ((snapshot && snapshot.lang) || "en")) return;
      window.settingsAPI.update("lang", next).then((result) => {
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          showToast(t("toastSaveFailed") + msg, { error: true });
        }
      }).catch((err) => {
        showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
    });
  }
  return row;
}

// ── Boot ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

window.settingsAPI.onChanged((payload) => {
  if (payload && payload.snapshot) {
    snapshot = payload.snapshot;
  } else if (payload && payload.changes && snapshot) {
    snapshot = { ...snapshot, ...payload.changes };
  }
  // Guard against an early broadcast that lands before `getSnapshot()`
  // resolves — rendering with a null snapshot blanks the UI and the
  // initial render later would need to re-fetch static language state.
  if (!snapshot) return;
  const changes = payload && payload.changes;
  const needsAnimOverridesRefresh = !!(changes && (
    "theme" in changes || "themeVariant" in changes || "themeOverrides" in changes
  ));
  if (needsAnimOverridesRefresh) animationOverridesData = null;
  // Patch `active` in place when only `theme` changed — cheaper than
  // a full refetch. `themeOverrides` changes (e.g. removeTheme cleanup)
  // can alter the list shape, so those still refetch.
  if (changes && "themeOverrides" in changes) {
    // 只有 theme tab 关心 list（removeTheme cleanup 可能改 list 形态）。
    // animMap tab 的开关直接从 snapshot.themeOverrides 读，不用 refetch。
    if (activeTab === "theme") {
      fetchThemes().then(() => {
        renderSidebar();
        renderContent();
      });
      return;
    }
    if (activeTab === "animOverrides" || assetPickerState) {
      fetchAnimationOverridesData().then(() => {
        normalizeAssetPickerSelection();
        renderSidebar();
        renderContent();
        renderAssetPickerModal();
      });
      return;
    }
    renderSidebar();
    renderContent();
    return;
  }
  if (needsAnimOverridesRefresh && (activeTab === "animOverrides" || assetPickerState)) {
    fetchAnimationOverridesData().then(() => {
      normalizeAssetPickerSelection();
      renderSidebar();
      renderContent();
      renderAssetPickerModal();
    });
    return;
  }
  if (changes && "theme" in changes && themeList) {
    themeList = themeList.map((t) => ({ ...t, active: t.id === changes.theme }));
  }
  renderSidebar();
  renderContent();
});

window.settingsAPI.getSnapshot().then((snap) => {
  snapshot = snap || {};
  renderSidebar();
  renderContent();
});

// Fetch static agent metadata once at boot. It's a pure lookup from
// agents/registry.js — no runtime state — so there's no refresh loop.
if (typeof window.settingsAPI.listAgents === "function") {
  window.settingsAPI
    .listAgents()
    .then((list) => {
      agentMetadata = Array.isArray(list) ? list : [];
      if (activeTab === "agents") renderContent();
    })
    .catch((err) => {
      console.warn("settings: listAgents failed", err);
      agentMetadata = [];
    });
}
