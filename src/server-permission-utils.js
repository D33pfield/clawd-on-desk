"use strict";

const crypto = require("crypto");

// Truncate large string values in objects (recursive) — bubble only needs a preview
const PREVIEW_MAX = 500;
const MAX_PERMISSION_SUGGESTIONS = 20;
const MAX_ELICITATION_QUESTIONS = 5;
const MAX_ELICITATION_OPTIONS = 5;
const MAX_ELICITATION_HEADER = 48;
const MAX_ELICITATION_PROMPT = 240;
const MAX_ELICITATION_OPTION_LABEL = 80;
const MAX_ELICITATION_OPTION_DESCRIPTION = 160;
const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;

function truncateDeep(obj, depth) {
  if ((depth || 0) > 10) return obj;
  if (Array.isArray(obj)) return obj.map(v => truncateDeep(v, (depth || 0) + 1));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = truncateDeep(v, (depth || 0) + 1);
    return out;
  }
  return typeof obj === "string" && obj.length > PREVIEW_MAX
    ? obj.slice(0, PREVIEW_MAX) + "\u2026" : obj;
}

function clampPreviewText(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}\u2026` : trimmed;
}

function normalizePermissionSuggestions(rawSuggestions) {
  const suggestions = Array.isArray(rawSuggestions)
    ? rawSuggestions.filter((entry) => entry && typeof entry === "object")
    : [];
  const addRulesItems = suggestions.filter((entry) => entry.type === "addRules");
  const nonAddRules = suggestions.filter((entry) => entry.type !== "addRules");
  const mergedAddRules = addRulesItems.length > 1
    ? {
        type: "addRules",
        destination: addRulesItems[0].destination || "localSettings",
        behavior: addRulesItems[0].behavior || "allow",
        rules: addRulesItems.flatMap((entry) => (
          Array.isArray(entry.rules) ? entry.rules : [{ toolName: entry.toolName, ruleContent: entry.ruleContent }]
        )),
      }
    : addRulesItems[0] || null;

  if (!mergedAddRules) return nonAddRules.slice(0, MAX_PERMISSION_SUGGESTIONS);
  if (nonAddRules.length + 1 <= MAX_PERMISSION_SUGGESTIONS) return [...nonAddRules, mergedAddRules];
  return [
    ...nonAddRules.slice(0, MAX_PERMISSION_SUGGESTIONS - 1),
    mergedAddRules,
  ];
}

function normalizeElicitationToolInput(toolInput) {
  return prepareElicitationToolInput(toolInput).displayInput;
}

// Keep the renderer's bounded display text separate from the protocol payload
// used to build updatedInput. The wire answer key is the exact upstream
// question string; putting that string through preview clamping before reply
// silently changes the key and makes Claude/Hermes discard the answer.
//
// Unsupported/ambiguous shapes are not partially rendered. The route hands
// those requests back to the agent's native UI, because truncating questions
// or options would let the user approve a different choice set than the agent
// actually sent.
function prepareElicitationToolInput(toolInput) {
  const wireInput = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
    ? toolInput
    : {};
  const rawQuestions = Array.isArray(wireInput.questions) ? wireInput.questions : [];
  if (!rawQuestions.length) {
    return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "no-questions" };
  }
  if (rawQuestions.length > MAX_ELICITATION_QUESTIONS) {
    return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "too-many-questions" };
  }

  const answerKeys = new Set();
  const displayQuestions = new Set();
  const questions = [];
  for (let index = 0; index < rawQuestions.length; index++) {
    const question = rawQuestions[index];
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "invalid-question" };
    }
    const answerKey = typeof question.question === "string" ? question.question : "";
    if (!answerKey.trim()) {
      return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "missing-answer-key" };
    }
    if (answerKeys.has(answerKey)) {
      return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "duplicate-answer-key" };
    }
    answerKeys.add(answerKey);

    const rawOptions = Array.isArray(question.options) ? question.options : [];
    if (rawOptions.length > MAX_ELICITATION_OPTIONS) {
      return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "too-many-options" };
    }
    const options = [];
    const optionAnswerKeys = new Set();
    for (const option of rawOptions) {
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "invalid-option" };
      }
      const rawLabel = typeof option.label === "string" ? option.label : "";
      const displayLabel = clampPreviewText(rawLabel, MAX_ELICITATION_OPTION_LABEL);
      // The renderer returns the displayed label as the answer value. Until
      // the wire contract carries stable option ids too, never render a label
      // whose preview normalization would change the upstream answer.
      if (!displayLabel) {
        return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "missing-option-label" };
      }
      if (displayLabel !== rawLabel) {
        return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "unsafe-option-label-preview" };
      }
      if (optionAnswerKeys.has(rawLabel)) {
        return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "duplicate-option-label" };
      }
      optionAnswerKeys.add(rawLabel);
      options.push({
        label: displayLabel,
        description: clampPreviewText(option.description, MAX_ELICITATION_OPTION_DESCRIPTION),
      });
    }
    const displayQuestion = clampPreviewText(answerKey, MAX_ELICITATION_PROMPT);
    if (displayQuestions.has(displayQuestion)) {
      return { displayInput: { questions: [] }, wireInput, canAnswer: false, reason: "duplicate-display-question" };
    }
    displayQuestions.add(displayQuestion);
    questions.push({
      id: String(index),
      header: clampPreviewText(question.header, MAX_ELICITATION_HEADER),
      question: displayQuestion,
      displayQuestion,
      multiSelect: question.multiSelect === true,
      options,
    });
  }

  return {
    displayInput: { questions },
    wireInput,
    canAnswer: true,
    reason: null,
  };
}

function normalizeHookToolUseId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeToolMatchValue(value, depth = 0) {
  if (depth > TOOL_MATCH_DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, TOOL_MATCH_ARRAY_MAX)
      .map((entry) => normalizeToolMatchValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, TOOL_MATCH_OBJECT_KEYS_MAX)) {
      out[key] = normalizeToolMatchValue(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > TOOL_MATCH_STRING_MAX
      ? `${value.slice(0, TOOL_MATCH_STRING_MAX - 1)}…`
      : value;
  }
  return value;
}

function buildToolInputFingerprint(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const normalized = normalizeToolMatchValue(toolInput);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function normalizeCodexPermissionToolInput(rawInput, description) {
  const base = rawInput && typeof rawInput === "object" ? truncateDeep(rawInput) : {};
  const trimmedDescription = typeof description === "string" && description.trim()
    ? description.trim()
    : null;
  if (!trimmedDescription) return base;
  return {
    ...base,
    description: trimmedDescription,
  };
}

function findPendingPermissionForStateEvent(pendingPermissions, options) {
  const sessionId = typeof options.sessionId === "string" && options.sessionId
    ? options.sessionId
    : "default";
  const sourceAgentId = typeof options.agentId === "string" && options.agentId
    ? options.agentId
    : null;
  const hasSubagentScope = Object.prototype.hasOwnProperty.call(options, "subagentId");
  const sourceSubagentId = typeof options.subagentId === "string" && options.subagentId
    ? options.subagentId
    : null;
  const sessionPending = pendingPermissions.filter((perm) => (
    perm && perm.res && perm.sessionId === sessionId
      && (!sourceAgentId || perm.agentId === sourceAgentId)
      && (!hasSubagentScope || (perm.subagentId || null) === sourceSubagentId)
  ));
  if (!sessionPending.length) return null;

  const toolUseId = normalizeHookToolUseId(options.toolUseId);
  if (toolUseId) {
    const matchByToolUseId = sessionPending.find((perm) => perm.toolUseId === toolUseId);
    if (matchByToolUseId) return matchByToolUseId;
  }

  const toolName = typeof options.toolName === "string" && options.toolName
    ? options.toolName
    : null;
  const toolInputFingerprint = typeof options.toolInputFingerprint === "string" && options.toolInputFingerprint
    ? options.toolInputFingerprint
    : null;
  if (toolName && toolInputFingerprint) {
    const matchesByFingerprint = sessionPending.filter((perm) => (
      perm.toolName === toolName
        && perm.toolInputFingerprint === toolInputFingerprint
        && (!toolUseId || !perm.toolUseId)
    ));
    if (matchesByFingerprint.length === 1) return matchesByFingerprint[0];
  }

  const allowSingletonFallback = options.allowSingletonFallback === true;
  return allowSingletonFallback && sessionPending.length === 1 ? sessionPending[0] : null;
}

module.exports = {
  PREVIEW_MAX,
  MAX_PERMISSION_SUGGESTIONS,
  MAX_ELICITATION_QUESTIONS,
  MAX_ELICITATION_OPTIONS,
  MAX_ELICITATION_HEADER,
  MAX_ELICITATION_PROMPT,
  MAX_ELICITATION_OPTION_LABEL,
  MAX_ELICITATION_OPTION_DESCRIPTION,
  TOOL_MATCH_STRING_MAX,
  TOOL_MATCH_ARRAY_MAX,
  TOOL_MATCH_OBJECT_KEYS_MAX,
  TOOL_MATCH_DEPTH_MAX,
  truncateDeep,
  clampPreviewText,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  prepareElicitationToolInput,
  normalizeHookToolUseId,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  normalizeCodexPermissionToolInput,
  findPendingPermissionForStateEvent,
};
