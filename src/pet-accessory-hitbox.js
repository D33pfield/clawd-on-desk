"use strict";

function basenameOnly(value) {
  return typeof value === "string" ? value.replace(/^.*[\/\\]/, "") : value;
}

function resolveAccessoryDescriptor(theme, state, file) {
  const attachments = theme
    && theme.customization
    && theme.customization.accessories;
  if (!attachments || !file) return null;

  const safeFile = basenameOnly(file);
  if (
    attachments.files
    && Object.prototype.hasOwnProperty.call(attachments.files, safeFile)
  ) {
    return attachments.files[safeFile];
  }
  if (state && state.startsWith("mini-") && attachments.mini) {
    return attachments.mini;
  }
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

function getPadding(descriptor) {
  const padding = (descriptor && descriptor.hitBoxPadding) || {};
  return {
    left: Number.isFinite(padding.left) && padding.left >= 0 ? padding.left : 0,
    top: Number.isFinite(padding.top) && padding.top >= 0 ? padding.top : 0,
    right: Number.isFinite(padding.right) && padding.right >= 0 ? padding.right : 0,
    bottom: Number.isFinite(padding.bottom) && padding.bottom >= 0 ? padding.bottom : 0,
  };
}

/**
 * Expand the current animation's authored hit box by the exact selected
 * accessory envelope. `hitBoxPadding` belongs to the per-file descriptor and
 * accounts only for that animation's motion; it is never applied when the
 * accessory is absent or hidden.
 */
function resolveAccessoryAwareHitBox(theme, state, file, baseHitBox, accessory) {
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
  ) {
    return baseHitBox;
  }

  const descriptor = resolveAccessoryDescriptor(theme, state, file);
  const frame = descriptor && descriptor.staticFrame;
  if (
    !descriptor
    || descriptor.visibility === "hidden"
    || !frame
    || ![frame.cx, frame.baseY, frame.width].every(Number.isFinite)
    || frame.width <= 0
  ) {
    return baseHitBox;
  }

  const width = frame.width * accessory.widthScale;
  const height = width / accessory.aspect;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return baseHitBox;
  }

  const padding = getPadding(descriptor);
  const accessoryLeft = frame.cx - width / 2 - padding.left;
  const accessoryTop = frame.baseY + accessory.offsetY - height - padding.top;
  const accessoryRight = frame.cx + width / 2 + padding.right;
  const accessoryBottom = frame.baseY + accessory.offsetY + padding.bottom;

  const left = Math.min(baseHitBox.x, accessoryLeft);
  const top = Math.min(baseHitBox.y, accessoryTop);
  const right = Math.max(baseHitBox.x + baseHitBox.w, accessoryRight);
  const bottom = Math.max(baseHitBox.y + baseHitBox.h, accessoryBottom);
  return {
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  };
}

module.exports = {
  resolveAccessoryDescriptor,
  resolveAccessoryAwareHitBox,
};
