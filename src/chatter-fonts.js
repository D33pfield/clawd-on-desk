"use strict";

// The bubble fonts the user may pick. A fixed list, not free text: every entry
// is a monospace face with its own size and line height, tuned so a full-length
// reply (16 words per bubble) fits the bubble window whichever one is chosen.
// Only faces installed system-wide on Windows: Chromium here does not see fonts
// installed per user, so those would silently fall back. Every stack ends in the
// default's fallbacks, so a missing font degrades to a terminal face, not a serif.

const FALLBACK = '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace';

const CHATTER_FONTS = Object.freeze({
  cascadia: { family: FALLBACK, size: 14, lineHeight: 1.4 },
  consolas: { family: `Consolas, ${FALLBACK}`, size: 15, lineHeight: 1.4 },
  lucida: { family: `"Lucida Console", ${FALLBACK}`, size: 14, lineHeight: 1.4 },
  courier: { family: `"Courier New", ${FALLBACK}`, size: 15, lineHeight: 1.4 },
});

const CHATTER_FONT_IDS = Object.freeze(Object.keys(CHATTER_FONTS));
const DEFAULT_CHATTER_FONT = "cascadia";

// Unknown ids fall back to the default.
function resolveChatterFont(id) {
  return CHATTER_FONTS[id] || CHATTER_FONTS[DEFAULT_CHATTER_FONT];
}

module.exports = { CHATTER_FONTS, CHATTER_FONT_IDS, DEFAULT_CHATTER_FONT, resolveChatterFont };
