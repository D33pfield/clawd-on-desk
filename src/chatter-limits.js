"use strict";

// Limits on the chatter prefs that both the prefs validator and the Settings
// update validator apply, so the two can never disagree. (The Settings page is a
// browser script and cannot require this file; its copy of CUSTOM_MAX is checked
// against this one in test/settings-tab-chatter.test.js.)

const MAX_CUSTOM_PERSONALITY_CHARS = 300;
const MAX_MODEL_NAME_CHARS = 120;

// An Ollama model name: plain name characters only, no "..", not an absolute path.
function isValidChatterModel(value) {
  return typeof value === "string"
    && value.length <= MAX_MODEL_NAME_CHARS
    && /^[A-Za-z0-9._:/-]*$/.test(value)
    && !value.includes("..")
    && !value.startsWith("/");
}

function isValidCustomPersonality(value) {
  return typeof value === "string" && value.length <= MAX_CUSTOM_PERSONALITY_CHARS;
}

module.exports = { MAX_CUSTOM_PERSONALITY_CHARS, MAX_MODEL_NAME_CHARS, isValidChatterModel, isValidCustomPersonality };
