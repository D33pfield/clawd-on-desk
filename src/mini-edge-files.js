"use strict";

// Mini mode draws the whole pet through the #pet-facing-stage mirror on the
// left screen edge (see pet-accessory-mirror.js), so raster art that carries
// legible glyphs — a scroll or a talisman with text — would read backwards
// there. A theme can ship a left-edge variant whose glyphs are pre-mirrored;
// the stage mirror then turns them the right way round:
//
//   "miniMode": { "leftEdgeFiles": { "mini-happy.apng": "mini-happy-left.apng" } }
//
// main swaps the file while it builds the visual request, so the renderer,
// the settlement ACK and the committed visual all agree on what is on screen.
function resolveMiniEdgeFile(theme, file, { miniMode = false, edge = "right" } = {}) {
  if (!miniMode || edge !== "left" || typeof file !== "string" || !file) return file;
  const files = theme && theme.miniMode && theme.miniMode.leftEdgeFiles;
  if (!files || typeof files !== "object") return file;
  const variant = Object.prototype.hasOwnProperty.call(files, file) ? files[file] : null;
  return typeof variant === "string" && variant ? variant : file;
}

module.exports = { resolveMiniEdgeFile };
