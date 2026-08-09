"use strict";

// Slack Block Kit message builders for the one-way notifier. Kept dependency-free
// on purpose: Slack messages are plain JSON (`{ text, blocks }`), so unlike the
// Telegram formatter this needs no markdown engine. `text` is the notification
// fallback (shown in the OS/Slack push preview); `blocks` is the rich card.
//
// Every user/agent-derived string is run through redactSecrets before it leaves
// the desktop, matching the Telegram/Feishu renderers.

const { redactSecrets } = require("./secret-redact");

// Slack hard limits: header plain_text <= 150, section mrkdwn <= 3000. Stay a
// little under. Assistant output is middle-truncated so both ends survive.
const HEADER_MAX = 150;
const SECTION_MAX = 2900;
const OUTPUT_MAX = 2600;
const FALLBACK_MAX = 3000;

const SLACK_LOCALES = Object.freeze({
  en: {
    session: "session",
    done: "done",
    interrupted: "interrupted",
    assistantOutput: "Assistant output",
    truncated: "truncated",
    permissionTitle: "Permission needed",
    permissionHint: "Approve or deny in the desktop app.",
    tool: "Tool",
    folder: "Folder",
    agent: "Agent",
    host: "Host",
    testTitle: "Slack notifications connected",
    testBody: "This is a test message from Clawd on Desk. If you can read this, notifications are working.",
    wrapStatus: (status) => `(${status})`,
  },
  zh: {
    session: "会话",
    done: "已完成",
    interrupted: "已中断",
    assistantOutput: "Assistant 输出",
    truncated: "已截断",
    permissionTitle: "需要审批",
    permissionHint: "请在桌面 App 中批准或拒绝。",
    tool: "工具",
    folder: "目录",
    agent: "Agent",
    host: "主机",
    testTitle: "Slack 通知已连接",
    testBody: "这是来自 Clawd on Desk 的测试消息。如果你能看到它，说明通知已正常工作。",
    wrapStatus: (status) => `（${status}）`,
  },
  "zh-TW": {
    session: "工作階段",
    done: "已完成",
    interrupted: "已中斷",
    assistantOutput: "Assistant 輸出",
    truncated: "已截斷",
    permissionTitle: "需要審批",
    permissionHint: "請在桌面 App 中核准或拒絕。",
    tool: "工具",
    folder: "目錄",
    agent: "Agent",
    host: "主機",
    testTitle: "Slack 通知已連線",
    testBody: "這是來自 Clawd on Desk 的測試訊息。如果你能看到它，代表通知已正常運作。",
    wrapStatus: (status) => `（${status}）`,
  },
  ko: {
    session: "세션",
    done: "완료",
    interrupted: "중단됨",
    assistantOutput: "Assistant 출력",
    truncated: "잘림",
    permissionTitle: "승인 필요",
    permissionHint: "데스크톱 앱에서 승인하거나 거부하세요.",
    tool: "도구",
    folder: "폴더",
    agent: "Agent",
    host: "호스트",
    testTitle: "Slack 알림 연결됨",
    testBody: "Clawd on Desk에서 보낸 테스트 메시지입니다. 이 메시지가 보이면 알림이 정상 작동합니다.",
    wrapStatus: (status) => `(${status})`,
  },
  ja: {
    session: "セッション",
    done: "完了",
    interrupted: "中断",
    assistantOutput: "Assistant 出力",
    truncated: "省略",
    permissionTitle: "承認が必要",
    permissionHint: "デスクトップアプリで承認または拒否してください。",
    tool: "ツール",
    folder: "フォルダ",
    agent: "Agent",
    host: "ホスト",
    testTitle: "Slack 通知が接続されました",
    testBody: "Clawd on Desk からのテストメッセージです。これが表示されていれば通知は正常に動作しています。",
    wrapStatus: (status) => `（${status}）`,
  },
  "pt-BR": {
    session: "sessão",
    done: "concluída",
    interrupted: "interrompida",
    assistantOutput: "Saída do assistente",
    truncated: "truncado",
    permissionTitle: "Aprovação necessária",
    permissionHint: "Aprove ou recuse no aplicativo de desktop.",
    tool: "Ferramenta",
    folder: "Pasta",
    agent: "Agente",
    host: "Host",
    testTitle: "Notificações do Slack conectadas",
    testBody: "Esta é uma mensagem de teste do Clawd on Desk. Se você consegue ler isto, as notificações estão funcionando.",
    wrapStatus: (status) => `(${status})`,
  },
});

function getLocale(lang) {
  return SLACK_LOCALES[lang] || SLACK_LOCALES.en;
}

function safeText(value) {
  return (typeof value === "string" ? value : String(value == null ? "" : value))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, " ");
}

// Slack mrkdwn only requires &, <, > to be escaped; everything else is literal.
function escapeMrkdwn(value) {
  return safeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clip(value, maxLength) {
  const text = safeText(value);
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  let result = "";
  let length = 0;
  for (const character of text) {
    if (length + character.length > maxLength) break;
    result += character;
    length += character.length;
  }
  return result;
}

function truncateMiddle(text, maxLen) {
  const value = safeText(text);
  if (value.length <= maxLen) return { text: value, truncated: false };
  const marker = "\n...[truncated]...\n";
  if (maxLen <= marker.length + 20) {
    return { text: clip(value, maxLen), truncated: true };
  }
  const keep = maxLen - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  const safeHead = clip(value, head);
  let safeTail = "";
  let safeTailLength = 0;
  for (const character of Array.from(value).reverse()) {
    if (safeTailLength + character.length > tail) break;
    safeTail = `${character}${safeTail}`;
    safeTailLength += character.length;
  }
  return { text: `${safeHead}${marker}${safeTail}`, truncated: true };
}

function folderName(cwd) {
  if (!cwd) return "";
  const parts = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function shortId(id) {
  const s = String(id || "");
  return s.length > 6 ? s.slice(0, 6) : s;
}

function headerBlock(text) {
  return { type: "header", text: { type: "plain_text", text: clip(text, HEADER_MAX) || " ", emoji: true } };
}

function sectionBlock(mrkdwnText) {
  return { type: "section", text: { type: "mrkdwn", text: clip(mrkdwnText, SECTION_MAX) } };
}

function contextBlock(mrkdwnText) {
  return { type: "context", elements: [{ type: "mrkdwn", text: clip(mrkdwnText, SECTION_MAX) }] };
}

// Break any embedded ``` so it can't close our fenced code block early.
function neutralizeFences(text) {
  return safeText(text).replace(/`/g, "`\u200b");
}

function prepareAssistantOutput(entry) {
  const raw = entry && typeof entry.assistantLastOutput === "string" ? entry.assistantLastOutput : "";
  let text = safeText(raw).replace(/[ \t]+\n/g, "\n").trim();
  if (!text) return null;
  text = redactSecrets(text);
  const limited = truncateMiddle(text, OUTPUT_MAX);
  return {
    text: limited.text,
    truncated: limited.truncated || !!(entry && entry.assistantLastOutputTruncated === true),
  };
}

function metaLine(entry) {
  const meta = [];
  if (entry.agentId) meta.push(escapeMrkdwn(entry.agentId));
  const folder = folderName(entry.cwd);
  if (folder) meta.push(escapeMrkdwn(folder));
  if (entry.host) meta.push(escapeMrkdwn(entry.host));
  if (entry.id) meta.push(`#${escapeMrkdwn(shortId(entry.id))}`);
  return meta.join(" · ");
}

// Completion ping. `includeOutput` mirrors the Telegram companion's
// outputMode === "full"; when false, only the title + metadata are sent.
function buildCompletionMessage(entry, options = {}) {
  if (!entry) return null;
  const locale = getLocale(options.lang);
  const interrupted = entry.badge === "interrupted";
  const icon = interrupted ? "⚠️" : "✅";
  const status = interrupted ? locale.interrupted : locale.done;
  const title = entry.displayTitle || (entry.id ? `${shortId(entry.id)}..` : locale.session);
  const wrapStatus = typeof locale.wrapStatus === "function" ? locale.wrapStatus(status) : `(${status})`;

  const blocks = [headerBlock(`${icon} ${title}`)];
  const meta = metaLine(entry);
  const statusLine = `*${escapeMrkdwn(status)}*${meta ? `  ·  ${meta}` : ""}`;
  blocks.push(sectionBlock(statusLine));

  const prepared = options.includeOutput ? prepareAssistantOutput(entry) : null;
  if (prepared) {
    const label = prepared.truncated ? `${locale.assistantOutput} (${locale.truncated})` : locale.assistantOutput;
    blocks.push(sectionBlock(`*${escapeMrkdwn(label)}:*`));
    const body = neutralizeFences(prepared.text);
    blocks.push(sectionBlock("```\n" + clip(body, SECTION_MAX - 8) + "\n```"));
  }

  const fallback = clip(`${icon} ${title} ${wrapStatus}${meta ? ` — ${folderName(entry.cwd) || ""}` : ""}`, FALLBACK_MAX);
  return { text: fallback, blocks };
}

// Read-only "permission needed" heads-up. Slack cannot resolve the approval in
// this build, so the message tells the user to act in the desktop app.
function buildPermissionMessage(payload, options = {}) {
  const locale = getLocale(options.lang);
  const p = payload && typeof payload === "object" ? payload : {};
  const title = safeText(p.title).trim() || locale.permissionTitle;
  const blocks = [headerBlock(`⏳ ${locale.permissionTitle}`)];

  const lines = [`*${escapeMrkdwn(title)}*`];
  const fields = [];
  if (p.toolName) fields.push(`*${escapeMrkdwn(locale.tool)}:* ${escapeMrkdwn(redactSecrets(p.toolName))}`);
  if (p.agentId) fields.push(`*${escapeMrkdwn(locale.agent)}:* ${escapeMrkdwn(p.agentId)}`);
  const folder = folderName(p.folder || p.cwd);
  if (folder) fields.push(`*${escapeMrkdwn(locale.folder)}:* ${escapeMrkdwn(folder)}`);
  if (fields.length) lines.push(fields.join("\n"));
  const detail = safeText(p.detail || p.summary).trim();
  if (detail) lines.push(escapeMrkdwn(redactSecrets(detail)));
  blocks.push(sectionBlock(clip(lines.join("\n\n"), SECTION_MAX)));
  blocks.push(contextBlock(`ℹ️ ${escapeMrkdwn(locale.permissionHint)}`));

  return { text: clip(`⏳ ${locale.permissionTitle}: ${title}`, FALLBACK_MAX), blocks };
}

function buildTestMessage(options = {}) {
  const locale = getLocale(options.lang);
  return {
    text: locale.testTitle,
    blocks: [headerBlock(`🦀 ${locale.testTitle}`), sectionBlock(escapeMrkdwn(locale.testBody))],
  };
}

module.exports = {
  buildCompletionMessage,
  buildPermissionMessage,
  buildTestMessage,
  prepareAssistantOutput,
  neutralizeFences,
  escapeMrkdwn,
  truncateMiddle,
  getLocale,
  SLACK_LOCALES,
  HEADER_MAX,
  SECTION_MAX,
  OUTPUT_MAX,
};
