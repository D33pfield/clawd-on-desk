"use strict";

const { resolveViewBox } = require("./hit-geometry");

function basenameOnly(value) {
  return typeof value === "string" ? value.replace(/^.*[\/\\]/, "") : value;
}

// Measured against the real built-in SVG transforms. These are minimum motion
// envelopes in theme units; authored hitBoxPadding can only widen them.
// Unknown/external themes never inherit these values.
const BUILTIN_ACCESSORY_MOTION_PADDING = Object.freeze({
  clawd: Object.freeze({
    "clawd-happy.svg": Object.freeze({ top: 12 }),
    "clawd-idle-yawn.svg": Object.freeze({ left: 0.75, top: 4.5, right: 0.75, bottom: 1.5 }),
    "clawd-sleeping.svg": Object.freeze({ left: 0.25, top: 5.5, right: 0.25 }),
    "clawd-working-debugger.svg": Object.freeze({ left: 3.5, top: 1.5, right: 3.5, bottom: 2 }),
    "clawd-working-sweeping.svg": Object.freeze({ left: 3.5, top: 2, right: 3.5, bottom: 2 }),
    "clawd-headphones-groove.svg": Object.freeze({ left: 2.3, top: 1.5, right: 2.3, bottom: 1.5 }),
  }),
  cloudling: Object.freeze({
    // Scripted idle reaches 1.15x distance scale around the 12,12 face center.
    // Chromium sampling puts the accessory about 4.8-4.9 units past the
    // static projection, so retain a 5-unit measured envelope.
    "cloudling-idle.svg": Object.freeze({ left: 5, top: 5, right: 5, bottom: 5 }),
  }),
});

function resolveAccessoryDescriptor(theme, state, file) {
  const attachments = theme && theme.customization && theme.customization.accessories;
  if (!attachments || !file) return null;

  const safeFile = basenameOnly(file);
  if (attachments.files && Object.prototype.hasOwnProperty.call(attachments.files, safeFile)) {
    return attachments.files[safeFile];
  }
  if (state && state.startsWith("mini-") && attachments.mini) return attachments.mini;
  return attachments.default || null;
}

function isFiniteHitBox(value) {
  return !!(
    value
    && [value.x, value.y, value.w, value.h].every(Number.isFinite)
    && value.w > 0
    && value.h > 0
  );
}

function normalizedPadding(value) {
  const padding = value || {};
  return {
    left: Number.isFinite(padding.left) && padding.left >= 0 ? padding.left : 0,
    top: Number.isFinite(padding.top) && padding.top >= 0 ? padding.top : 0,
    right: Number.isFinite(padding.right) && padding.right >= 0 ? padding.right : 0,
    bottom: Number.isFinite(padding.bottom) && padding.bottom >= 0 ? padding.bottom : 0,
  };
}

function getPadding(theme, file, descriptor) {
  const authored = normalizedPadding(descriptor && descriptor.hitBoxPadding);
  const themeId = theme && theme._builtin === true && typeof theme._id === "string" ? theme._id : null;
  const measured = normalizedPadding(
    themeId
    && BUILTIN_ACCESSORY_MOTION_PADDING[themeId]
    && BUILTIN_ACCESSORY_MOTION_PADDING[themeId][basenameOnly(file)]
  );
  return {
    left: Math.max(authored.left, measured.left),
    top: Math.max(authored.top, measured.top),
    right: Math.max(authored.right, measured.right),
    bottom: Math.max(authored.bottom, measured.bottom),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mirrorHorizontal(left, right, viewBox) {
  const axis2 = 2 * viewBox.x + viewBox.width;
  return { left: axis2 - right, right: axis2 - left };
}

/**
 * Expand the current animation's authored hit box by the exact selected
 * accessory envelope. Accessory-only geometry is clamped to the render-visible
 * effective viewBox before unioning, so an external theme cannot turn a broad
 * staticFrame/padding declaration into a giant transparent native input window.
 * The base hitbox is deliberately never clamped or rewritten.
 */
function resolveAccessoryAwareHitBox(theme, state, file, baseHitBox, accessory, options = {}) {
  if (!isFiniteHitBox(baseHitBox)) return baseHitBox;
  if (
    !accessory
    || accessory.id === "none"
    || !accessory.assetFile
    || !Number.isFinite(accessory.aspect)
    || accessory.aspect <= 0
    || !Number.isFinite(accessory.widthScale)
    || accessory.widthScale <= 0
    || !Number.isFinite(accessory.offsetY)
  ) return baseHitBox;

  const descriptor = resolveAccessoryDescriptor(theme, state, file);
  const frame = descriptor && descriptor.staticFrame;
  if (
    !descriptor
    || descriptor.visibility === "hidden"
    || !frame
    || ![frame.cx, frame.baseY, frame.width].every(Number.isFinite)
    || frame.width <= 0
  ) return baseHitBox;

  const width = frame.width * accessory.widthScale;
  const height = width / accessory.aspect;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return baseHitBox;

  const padding = getPadding(theme, file, descriptor);
  let accessoryLeft = frame.cx - width / 2 - padding.left;
  let accessoryTop = frame.baseY + accessory.offsetY - height - padding.top;
  let accessoryRight = frame.cx + width / 2 + padding.right;
  let accessoryBottom = frame.baseY + accessory.offsetY + padding.bottom;

  const viewBox = options.viewBox || resolveViewBox(theme, state, file);
  if (
    viewBox
    && [viewBox.x, viewBox.y, viewBox.width, viewBox.height].every(Number.isFinite)
    && viewBox.width > 0
    && viewBox.height > 0
  ) {
    if (options.mirrorX === true) {
      ({ left: accessoryLeft, right: accessoryRight } = mirrorHorizontal(accessoryLeft, accessoryRight, viewBox));
    }
    const maxX = viewBox.x + viewBox.width;
    const maxY = viewBox.y + viewBox.height;
    accessoryLeft = clamp(accessoryLeft, viewBox.x, maxX);
    accessoryRight = clamp(accessoryRight, viewBox.x, maxX);
    accessoryTop = clamp(accessoryTop, viewBox.y, maxY);
    accessoryBottom = clamp(accessoryBottom, viewBox.y, maxY);
  }

  if (accessoryRight <= accessoryLeft || accessoryBottom <= accessoryTop) return baseHitBox;

  const left = Math.min(baseHitBox.x, accessoryLeft);
  const top = Math.min(baseHitBox.y, accessoryTop);
  const right = Math.max(baseHitBox.x + baseHitBox.w, accessoryRight);
  const bottom = Math.max(baseHitBox.y + baseHitBox.h, accessoryBottom);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

module.exports = {
  BUILTIN_ACCESSORY_MOTION_PADDING,
  resolveAccessoryDescriptor,
  resolveAccessoryAwareHitBox,
};
