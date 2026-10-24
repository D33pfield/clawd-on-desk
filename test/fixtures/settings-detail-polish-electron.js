"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { applyZoomToWindow } = require("../../src/text-scale");

const SRC = path.resolve(__dirname, "../../src");
const css = ["settings.css", "language-picker.css"]
  .map((file) => fs.readFileSync(path.join(SRC, file), "utf8"))
  .join("\n");
const scripts = ["settings-size-slider.js", "settings-i18n.js", "settings-ui-core.js"]
  .map((file) => fs.readFileSync(path.join(SRC, file), "utf8"));

// The audit lives in a hidden offscreen window so it can use real CSS layout and
// real rasterisation instead of a DOM shim: glyph centring, text wrapping and
// tooltip clamping are geometric/raster questions that only a rendering engine
// can answer. The icon assertions look at pixels inside the circle, because a
// serif italic glyph's advance box and its ink box are not the same thing.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
  * { transition: none !important; animation: none !important; }
</style></head><body>
<div class="app"><aside class="sidebar"></aside>
<main id="content" class="content"><div style="height:180px"></div>
<section class="section" id="rows"></section>
<section class="section" id="badges"></section></main></div>
<div id="modalRoot"></div>
</body></html>`;

const ROW_DESCRIPTION =
  "A request that would be auto-allowed waits for a human when the tool can delete data.";
const ROW_LABELS = [
  "Ask before auto-allowing",
  "Ask before auto-allowing destructive commands",
  "Ask before auto-allowing destructive commands that could delete or rewrite files",
  "在手机上显示权限摘要",
];
// Labels that also carry another inline child, plus a label long enough to wrap
// inside a narrow row: the (i) must stay on the text's line in both shapes.
const EXTRA_CHILD_LABEL = "Token configured";
const LONG_LABEL = "在手机上显示权限摘要以及更多说明文字以便在窄窗口里换行显示";
const BADGE_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const INK_LUMINANCE_THRESHOLD = 205;

async function installPageApi(win) {
  // Trailing `void 0` keeps the script's completion value undefined: the module
  // sources end on an assignment whose value cannot cross the IPC boundary.
  for (const source of scripts) await win.webContents.executeJavaScript(`${source}\n;void 0;`);
  await win.webContents.executeJavaScript(`
    window.__polish = (() => {
      const helpers = ClawdSettingsCore.helpers;
      const rows = document.getElementById("rows");
      const badges = document.getElementById("badges");

      for (const [index, labelText] of ${JSON.stringify(ROW_LABELS)}.entries()) {
        const row = document.createElement("div");
        row.className = "row";
        row.dataset.rowIndex = String(index);
        row.dataset.labelAlignment = "plain-" + String(index);
        const text = document.createElement("div");
        text.className = "row-text";
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = labelText;
        const desc = document.createElement("span");
        desc.className = "row-desc";
        desc.textContent = ${JSON.stringify(ROW_DESCRIPTION)};
        text.appendChild(label);
        text.appendChild(desc);
        row.appendChild(text);
        rows.appendChild(row);
        helpers.attachDescriptionDisclosure(row);
      }

      // A label with an extra inline child (the masked token) next to the (i).
      {
        const row = document.createElement("div");
        row.className = "row";
        row.dataset.labelAlignment = "extra-child";
        const text = document.createElement("div");
        text.className = "row-text";
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = ${JSON.stringify(EXTRA_CHILD_LABEL)};
        const masked = document.createElement("span");
        masked.className = "tg-approval-token-masked";
        masked.textContent = "1234";
        label.appendChild(masked);
        const desc = document.createElement("span");
        desc.className = "row-desc";
        desc.textContent = ${JSON.stringify(ROW_DESCRIPTION)};
        text.appendChild(label);
        text.appendChild(desc);
        row.appendChild(text);
        rows.appendChild(row);
        helpers.attachDescriptionDisclosure(row);
      }

      // A label that must wrap inside a narrow row without losing the icon.
      {
        const narrow = document.createElement("div");
        narrow.style.width = "260px";
        rows.appendChild(narrow);
        const row = document.createElement("div");
        row.className = "row";
        row.dataset.labelAlignment = "wrapped";
        const text = document.createElement("div");
        text.className = "row-text";
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = ${JSON.stringify(LONG_LABEL)};
        const desc = document.createElement("span");
        desc.className = "row-desc";
        desc.textContent = ${JSON.stringify(ROW_DESCRIPTION)};
        text.appendChild(label);
        text.appendChild(desc);
        row.appendChild(text);
        narrow.appendChild(row);
        helpers.attachDescriptionDisclosure(row);
      }

      for (const digit of ${JSON.stringify(BADGE_DIGITS)}) {
        const step = document.createElement("div");
        step.className = "channel-setup-step";
        step.dataset.digit = digit;
        const num = document.createElement("span");
        num.className = "channel-setup-num";
        num.textContent = digit;
        const body = document.createElement("div");
        body.className = "channel-setup-body";
        body.textContent = "step body";
        step.appendChild(num);
        step.appendChild(body);
        badges.appendChild(step);
      }

      const idType = helpers.buildSegmentedRadio({
        id: "feishu-id-type",
        ariaLabel: "approver id type",
        className: "feishu-approval-id-type",
        value: "open_id",
        options: ["open_id", "user_id", "union_id"].map((id) => ({
          value: id,
          label: id,
          dataset: { idType: id },
        })),
      });
      const idTypeRow = document.createElement("div");
      idTypeRow.className = "row";
      const idTypeControl = document.createElement("div");
      idTypeControl.className = "row-control tg-approval-input-row";
      idTypeControl.appendChild(idType.element);
      idTypeRow.appendChild(idTypeControl);
      rows.appendChild(idTypeRow);

      const waitFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      return {
        waitFrames,
        toggleAt(index) {
          return document.querySelectorAll(".row-desc-toggle")[index];
        },
        toggleSelector(index) {
          return '.row[data-row-index="' + String(index) + '"] .row-desc-toggle';
        },
        badgeSelector(digit) {
          return '.channel-setup-step[data-digit="' + String(digit) + '"] .channel-setup-num';
        },
        describeToggle(index) {
          const toggle = document.querySelectorAll(".row-desc-toggle")[index];
          const rect = toggle.getBoundingClientRect();
          return {
            textContent: toggle.textContent,
            title: toggle.getAttribute("title"),
            ariaDescribedBy: toggle.getAttribute("aria-describedby"),
            ariaLabel: toggle.getAttribute("aria-label"),
            fontSize: getComputedStyle(toggle).fontSize,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          };
        },
        measureLabelAlignment() {
          return Array.from(document.querySelectorAll(".row[data-label-alignment]")).map((row) => {
            const label = row.querySelector(".row-label");
            const toggle = row.querySelector(".row-desc-toggle");
            const labelRect = label.getBoundingClientRect();
            const toggleRect = toggle.getBoundingClientRect();
            const masked = row.querySelector(".tg-approval-token-masked");
            const maskedRect = masked ? masked.getBoundingClientRect() : null;
            return {
              key: row.dataset.labelAlignment,
              labelHeight: Number(labelRect.height.toFixed(2)),
              labelWidth: Number(labelRect.width.toFixed(2)),
              overflow: Number((label.scrollWidth - label.clientWidth).toFixed(2)),
              display: getComputedStyle(label).display,
              delta: Number(((toggleRect.top + toggleRect.height / 2)
                - (labelRect.top + labelRect.height / 2)).toFixed(3)),
              toggleInside: toggleRect.left >= labelRect.left - 0.5
                && toggleRect.right <= labelRect.right + 0.5
                && toggleRect.top >= labelRect.top - 0.5
                && toggleRect.bottom <= labelRect.bottom + 0.5,
              masked: maskedRect && {
                centreDelta: Number(((maskedRect.top + maskedRect.height / 2)
                  - (labelRect.top + labelRect.height / 2)).toFixed(3)),
                height: Number(maskedRect.height.toFixed(2)),
              },
            };
          });
        },
        measureIdType() {
          return Array.from(document.querySelectorAll(".feishu-approval-id-type button")).map((button) => {
            const buttonRect = button.getBoundingClientRect();
            const label = button.querySelector(".settings-segmented-radio-label");
            const labelRect = label.getBoundingClientRect();
            return {
              value: button.dataset.value,
              active: button.classList.contains("active"),
              buttonWidth: buttonRect.width,
              labelWidth: labelRect.width,
              dx: (labelRect.left + labelRect.right) / 2 - (buttonRect.left + buttonRect.right) / 2,
              dy: (labelRect.top + labelRect.bottom) / 2 - (buttonRect.top + buttonRect.bottom) / 2,
              alignItems: getComputedStyle(button).alignItems,
              justifyContent: getComputedStyle(button).justifyContent,
              textAlign: getComputedStyle(button).textAlign,
            };
          });
        },
        openConsentDialog() {
          void helpers.showSettingsConfirmModal({
            title: "启用移动端权限摘要？",
            detail: "手机将通过明文 WebSocket 收到工具名、尽力脱敏的操作摘要。",
            actions: [
              { id: "reset", label: "重置令牌并启用（推荐）", tone: "accent", defaultFocus: true },
              { id: "keep", label: "保留令牌并启用", tone: "neutral" },
              { id: "cancel", label: "取消", tone: "neutral" },
            ],
          });
        },
        closeConsentDialog() {
          const buttons = document.querySelectorAll(".settings-confirm-actions .soft-btn");
          if (buttons[2]) buttons[2].click();
        },
        measureDialog() {
          const dialog = document.querySelector(".settings-confirm-modal");
          const dialogRect = dialog.getBoundingClientRect();
          const buttons = Array.from(dialog.querySelectorAll(".settings-confirm-actions .soft-btn"));
          return {
            dialog: {
              left: dialogRect.left,
              right: dialogRect.right,
              top: dialogRect.top,
              bottom: dialogRect.bottom,
            },
            viewport: { width: innerWidth, height: innerHeight },
            buttons: buttons.map((button) => {
              const label = button.querySelector(".settings-button-label");
              const labelRect = label.getBoundingClientRect();
              const keep = label.querySelector(".settings-button-label-keep");
              const text = label.querySelector(".settings-button-label-text");
              const keepRect = keep ? keep.getBoundingClientRect() : null;
              const textRect = text ? text.getBoundingClientRect() : null;
              return {
                text: label.textContent,
                labelRect: {
                  left: labelRect.left,
                  right: labelRect.right,
                  top: labelRect.top,
                  bottom: labelRect.bottom,
                  width: labelRect.width,
                },
                keepRect: keepRect && {
                  left: keepRect.left,
                  right: keepRect.right,
                  top: keepRect.top,
                  bottom: keepRect.bottom,
                  width: keepRect.width,
                  height: keepRect.height,
                },
                textRect: textRect && {
                  left: textRect.left,
                  right: textRect.right,
                  top: textRect.top,
                  bottom: textRect.bottom,
                  width: textRect.width,
                },
                keepWhiteSpace: keep ? getComputedStyle(keep).whiteSpace : "",
              };
            }),
          };
        },
        hoverToggle(index) {
          document.querySelectorAll(".row-desc-toggle")[index].dispatchEvent(
            new MouseEvent("mouseenter", { bubbles: false }),
          );
        },
        pressEscape() {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        },
        measureTooltip(index) {
          const tooltip = document.querySelector(".settings-tooltip");
          const anchor = document.querySelectorAll(".row-desc-toggle")[index];
          if (!tooltip) return null;
          const rect = tooltip.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();
          const style = getComputedStyle(tooltip);
          return {
            text: tooltip.textContent,
            ariaHidden: tooltip.getAttribute("aria-hidden"),
            role: tooltip.getAttribute("role"),
            className: tooltip.className,
            opacity: style.opacity,
            visibility: style.visibility,
            pointerEvents: style.pointerEvents,
            rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            anchorRect: { left: anchorRect.left, right: anchorRect.right, top: anchorRect.top },
            viewport: { width: innerWidth, height: innerHeight },
          };
        },
      };
    })();
    void 0;
  `);
}

// Crop the icon's box and measure the ink of the glyph inside the circle: the
// border ring is excluded by radius, so only the glyph contributes.
// Offscreen `capturePage` occasionally returns a frame from before the latest
// layout, so an empty scan is retried after letting a frame paint.
async function waitForPaint(win) {
  await win.webContents.executeJavaScript(
    "new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 30))",
  );
}

async function measureInk(win, selector, ringInset) {
  const box = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    return { pageX: r.left, pageY: r.top, width: r.width, height: r.height };
  })()`);
  const cropX = Math.floor(box.pageX);
  const cropY = Math.floor(box.pageY);
  const cropWidth = Math.ceil(box.width) + 1;
  const cropHeight = Math.ceil(box.height) + 1;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const image = await win.webContents.capturePage({
      x: cropX,
      y: cropY,
      width: cropWidth,
      height: cropHeight,
    });
    const measure = analyseInk(image, box, cropX, cropY, cropWidth, ringInset);
    if (measure.ink > 0 || attempt === 2) return measure;
    await waitForPaint(win);
  }
  return { ink: 0, scale: 0, delta: null, inkSize: null };
}

function analyseInk(image, box, cropX, cropY, cropWidth, ringInset) {
  const size = image.getSize();
  const bitmap = image.getBitmap();
  const scale = size.width / cropWidth;
  const centreDeviceX = (box.pageX + box.width / 2 - cropX) * scale;
  const centreDeviceY = (box.pageY + box.height / 2 - cropY) * scale;
  const radiusDevice = (box.width / 2 - ringInset + 0.6) * scale;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let ink = 0;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const index = (y * size.width + x) * 4;
      const luminance = 0.2126 * bitmap[index + 2]
        + 0.7152 * bitmap[index + 1]
        + 0.0722 * bitmap[index];
      if (luminance >= INK_LUMINANCE_THRESHOLD) continue;
      if (Math.hypot(x + 0.5 - centreDeviceX, y + 0.5 - centreDeviceY) > radiusDevice) continue;
      ink += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (ink === 0) return { ink: 0, scale, delta: null, inkSize: null };
  const centreX = (minX + (maxX - minX) / 2 + 0.5) / scale + cropX;
  const centreY = (minY + (maxY - minY) / 2 + 0.5) / scale + cropY;
  return {
    ink,
    scale: Number(scale.toFixed(3)),
    inkSize: {
      width: Number(((maxX - minX + 1) / scale).toFixed(2)),
      height: Number(((maxY - minY + 1) / scale).toFixed(2)),
    },
    delta: {
      x: Number((centreX - (box.pageX + box.width / 2)).toFixed(3)),
      y: Number((centreY - (box.pageY + box.height / 2)).toFixed(3)),
    },
  };
}

// Full painted extent of an icon (circle ring plus glyph), used to prove every
// icon rasterises to the same size regardless of its fractional position.
async function measureRasterBox(win, selector) {
  const box = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    return { pageX: r.left, pageY: r.top, width: r.width, height: r.height };
  })()`);
  const cropX = Math.floor(box.pageX) - 2;
  const cropY = Math.floor(box.pageY) - 2;
  const cropWidth = Math.ceil(box.width) + 4;
  const cropHeight = Math.ceil(box.height) + 4;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const image = await win.webContents.capturePage({
      x: cropX,
      y: cropY,
      width: cropWidth,
      height: cropHeight,
    });
    const size = image.getSize();
    const bitmap = image.getBitmap();
    const scale = size.width / cropWidth;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let ink = 0;
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const index = (y * size.width + x) * 4;
        const luminance = 0.2126 * bitmap[index + 2]
          + 0.7152 * bitmap[index + 1]
          + 0.0722 * bitmap[index];
        if (luminance >= 210) continue;
        ink += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (ink > 0 || attempt === 2) {
      return {
        ink,
        width: Number(((maxX - minX + 1) / scale).toFixed(2)),
        height: Number(((maxY - minY + 1) / scale).toFixed(2)),
      };
    }
    await waitForPaint(win);
  }
  return { ink: 0, width: 0, height: 0 };
}

// Icon centre against the label's line-box centre, plus a raster check of the
// text ink centre so the icon cannot merely be centred in an empty box.
function assertLabelAlignment(rows, context) {
  assert.ok(rows.length >= 5, `label alignment rows are mounted; ${context}`);
  for (const row of rows) {
    const detail = `${context} ${JSON.stringify(row)}`;
    assert.equal(row.display, "flex", `the row label becomes a centred flex line; ${detail}`);
    assert.ok(Math.abs(row.delta) <= 0.5, `the (i) shares the label's line; ${detail}`);
    assert.ok(row.toggleInside, `the (i) stays inside the label box; ${detail}`);
  }
  const wrapped = rows.find((row) => row.key === "wrapped");
  assert.ok(wrapped, "the wrapping row is mounted");
  assert.ok(wrapped.labelHeight > 20, `a long label still wraps; ${JSON.stringify(wrapped)}`);
  assert.ok(wrapped.overflow <= 1, `the wrapped label does not overflow; ${JSON.stringify(wrapped)}`);
  const extra = rows.find((row) => row.key === "extra-child");
  assert.ok(extra && extra.masked, "the masked-token row keeps its inline child");
  assert.ok(Math.abs(extra.masked.centreDelta) <= 1,
    `the masked token stays on the label's line; ${JSON.stringify(extra)}`);
  assert.ok(extra.labelHeight <= 30,
    `the masked token chip keeps the label on one line; ${JSON.stringify(extra)}`);
}

async function measureLabelInkAlignment(win, rowKey) {
  const box = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.row[data-label-alignment="${rowKey}"]');
    const label = row.querySelector(".row-label");
    const toggle = row.querySelector(".row-desc-toggle");
    const labelRect = label.getBoundingClientRect();
    const toggleRect = toggle.getBoundingClientRect();
    return {
      pageX: labelRect.left,
      pageY: labelRect.top,
      width: labelRect.width,
      height: labelRect.height,
      iconLeft: toggleRect.left,
      iconCentreY: toggleRect.top + toggleRect.height / 2,
    };
  })()`);
  const cropX = Math.floor(box.pageX);
  const cropY = Math.floor(box.pageY);
  const cropWidth = Math.ceil(box.width);
  const cropHeight = Math.ceil(box.height);
  let image = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    image = await win.webContents.capturePage({
      x: cropX,
      y: cropY,
      width: cropWidth,
      height: cropHeight,
    });
    const probe = image.getBitmap();
    let anyInk = false;
    for (let index = 0; index < probe.length; index += 4) {
      const luminance = 0.2126 * probe[index + 2] + 0.7152 * probe[index + 1] + 0.0722 * probe[index];
      if (luminance < INK_LUMINANCE_THRESHOLD) { anyInk = true; break; }
    }
    if (anyInk || attempt === 2) break;
    await waitForPaint(win);
  }
  const size = image.getSize();
  const bitmap = image.getBitmap();
  const scale = size.width / cropWidth;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const index = (y * size.width + x) * 4;
      const luminance = 0.2126 * bitmap[index + 2]
        + 0.7152 * bitmap[index + 1]
        + 0.0722 * bitmap[index];
      if (luminance >= INK_LUMINANCE_THRESHOLD) continue;
      if (x / scale + cropX >= box.iconLeft - 1) continue;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxY < 0) return { empty: true };
  const textInkCentre = (minY + maxY) / 2 / scale + cropY;
  return {
    textInkCentre: Number(textInkCentre.toFixed(3)),
    iconCentre: Number(box.iconCentreY.toFixed(3)),
    delta: Number((box.iconCentreY - textInkCentre).toFixed(3)),
  };
}

function assertGlyphCentred(measure, context, tolerance = 0.75) {
  const detail = `${context}: ${JSON.stringify(measure)}`;
  assert.ok(measure.ink >= 10, `the serif glyph is painted, not hidden; ${detail}`);
  assert.ok(Math.abs(measure.delta.x) <= tolerance, `glyph ink is horizontally centred; ${detail}`);
  assert.ok(Math.abs(measure.delta.y) <= tolerance, `glyph ink is vertically centred; ${detail}`);
}

// Every icon rasterises to the same extent: with 4n CSS px boxes a fractional
// row position cannot round the same circle to 17 or 18 device px.
function assertIconSizesUniform(toggles, badges, context) {
  const spread = (items) => {
    const widths = items.map((item) => item.width);
    const heights = items.map((item) => item.height);
    return {
      width: Number((Math.max(...widths) - Math.min(...widths)).toFixed(2)),
      height: Number((Math.max(...heights) - Math.min(...heights)).toFixed(2)),
    };
  };
  const toggleSpread = spread(toggles);
  const badgeSpread = spread(badges);
  assert.ok(toggleSpread.width <= 0.5 && toggleSpread.height <= 0.5,
    `every (i) circle rasterises to one size (${JSON.stringify(toggles)}); ${context}`);
  assert.ok(badgeSpread.width <= 0.5 && badgeSpread.height <= 0.5,
    `every step-number circle rasterises to one size (${JSON.stringify(badges)}); ${context}`);
  for (const item of [...toggles, ...badges]) {
    assert.ok(Math.abs(item.width - Math.round(item.width)) <= 0.5, `icon box is integral; ${JSON.stringify(item)}`);
  }
}

function assertBadgeCentred(measure, context, tolerance = 0.9) {
  const detail = `${context}: ${JSON.stringify(measure)}`;
  assert.ok(measure.ink >= 10, `the step digit is painted; ${detail}`);
  assert.ok(Math.abs(measure.delta.x) <= tolerance, `step digit is horizontally centred; ${detail}`);
  assert.ok(Math.abs(measure.delta.y) <= tolerance, `step digit is vertically centred; ${detail}`);
}

function assertIdTypeCentred(measures) {
  assert.equal(measures.length, 3, "the approver id-type slider keeps three segments");
  for (const measure of measures) {
    const detail = JSON.stringify(measure);
    assert.ok(measure.buttonWidth > measure.labelWidth, `label sits inside the segment; ${detail}`);
    assert.ok(Math.abs(measure.dx) <= 0.5, `label is horizontally centred; ${detail}`);
    assert.ok(Math.abs(measure.dy) <= 1, `label is vertically centred; ${detail}`);
    assert.equal(measure.alignItems, "center", `segment centres its content; ${detail}`);
    assert.equal(measure.justifyContent, "center", `segment centres its content; ${detail}`);
    assert.equal(measure.textAlign, "center", `segment text is centred; ${detail}`);
  }
}

function assertDialogLabels(wrap) {
  const [reset, keep, cancel] = wrap.buttons;
  const detail = JSON.stringify(wrap);
  assert.equal(reset.text, "重置令牌并启用（推荐）", `label text preserved; ${detail}`);
  assert.ok(reset.keepRect, `the (推荐) group is a single unbreakable run; ${detail}`);
  assert.equal(reset.keepWhiteSpace, "nowrap", `the group cannot break internally; ${detail}`);
  assert.ok(reset.keepRect.right <= reset.labelRect.right + 0.5, `the group fits its label box; ${detail}`);
  assert.ok(reset.keepRect.left >= reset.labelRect.left - 0.5, `the group fits its label box; ${detail}`);
  assert.ok(reset.textRect, `the descriptive part stays its own run; ${detail}`);
  assert.ok(reset.textRect.right <= reset.labelRect.right + 0.5, `the first line fits; ${detail}`);
  assert.ok(reset.keepRect.top >= reset.textRect.bottom - 0.5,
    `"（推荐）" starts on the next line instead of splitting as "（推" + "荐）"; ${detail}`);
  assert.ok(reset.keepRect.height <= 20, `the group stays on one line; ${detail}`);
  const groupCentre = (reset.keepRect.left + reset.keepRect.right) / 2;
  const labelCentre = (reset.labelRect.left + reset.labelRect.right) / 2;
  assert.ok(Math.abs(groupCentre - labelCentre) <= 1, `the wrapped group stays centred; ${detail}`);
  assert.equal(keep.text, "保留令牌并启用", `kept label text; ${detail}`);
  assert.equal(keep.keepRect, null, `no parenthetical group for the kept label; ${detail}`);
  assert.equal(cancel.text, "取消", `cancel label text; ${detail}`);
  assert.ok(wrap.dialog.left >= -0.5 && wrap.dialog.right <= wrap.viewport.width + 0.5, `dialog fits; ${detail}`);
  assert.ok(Math.abs((wrap.dialog.left + wrap.dialog.right) / 2 - wrap.viewport.width / 2) <= 1,
    `dialog stays horizontally centred; ${detail}`);
}

function assertTooltip(measure, { expectAbove }, context) {
  const detail = `${context}: ${JSON.stringify(measure)}`;
  assert.ok(measure, `tooltip is mounted; ${detail}`);
  assert.equal(measure.text, ROW_DESCRIPTION, `hint shows the folded description; ${detail}`);
  assert.equal(measure.ariaHidden, "false", `visible hint is exposed; ${detail}`);
  assert.equal(measure.role, "tooltip", `hint carries the tooltip role; ${detail}`);
  assert.equal(measure.visibility, "visible", `hint is visible; ${detail}`);
  assert.equal(measure.opacity, "1", `hint is fully opaque; ${detail}`);
  assert.equal(measure.pointerEvents, "none", `hint must not swallow pointer events; ${detail}`);
  const { rect, viewport, anchorRect } = measure;
  assert.ok(rect.left >= 7 && rect.right <= viewport.width - 7, `hint stays inside the viewport; ${detail}`);
  assert.ok(rect.top >= 7 && rect.bottom <= viewport.height - 7, `hint stays inside the viewport; ${detail}`);
  if (expectAbove) {
    assert.ok(rect.bottom <= anchorRect.top + 0.5, `hint sits above its anchor; ${detail}`);
  }
}

// Measured rectangles are post-zoom (visual) pixels; the CSS gap and the
// viewport inset scale with the zoom factor too.
function assertTooltipUnderZoom(measure, zoom, context) {
  const detail = `${context}: ${JSON.stringify(measure)}`;
  assert.ok(measure, `hint is mounted at ${context}`);
  const { rect, anchorRect, viewport } = measure;
  const gap = anchorRect.top - rect.bottom;
  assert.ok(gap >= 6 * zoom && gap <= 12 * zoom,
    `hint keeps its gap above the icon instead of drifting by the zoom factor; ${detail}`);
  const centreDelta = Math.abs((rect.left + rect.right) / 2 - (anchorRect.left + anchorRect.right) / 2);
  assert.ok(centreDelta <= 1.5, `hint stays centred on its icon; ${detail}`);
  assert.ok(rect.left >= 7 * zoom && rect.right <= viewport.width - 7 * zoom,
    `hint stays inside the visual viewport; ${detail}`);
  assert.ok(rect.top >= 7 * zoom && rect.bottom <= viewport.height - 7 * zoom,
    `hint stays inside the vertical visual viewport; ${detail}`);
}

function assertToggleContract(description) {
  const detail = JSON.stringify(description);
  assert.equal(description.textContent, "i", `the "i" text stays in the DOM; ${detail}`);
  assert.ok(description.title == null, `native OS tooltip must not be used; ${detail}`);
  assert.ok(description.ariaDescribedBy, `description stays programmatically associated; ${detail}`);
  assert.equal(description.fontSize, "10.5px", `the serif glyph keeps its proportional size; ${detail}`);
}

async function main() {
  const profile = process.env.CLAWD_DETAIL_POLISH_PROFILE;
  assert.ok(profile && path.isAbsolute(profile), "the test runner must supply an isolated profile");
  app.setPath("userData", profile);
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1600,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await installPageApi(win);
    await win.webContents.executeJavaScript("__polish.waitFrames()");

    // 1. The (i) disclosure keeps the original serif italic glyph (curved tail,
    //    "i" in the DOM) and its ink is centred inside the circle at three
    //    different sub-pixel positions (row labels of different widths).
    const toggleInk = [];
    for (const index of [0, 1, 2]) {
      const selector = await win.webContents.executeJavaScript(`__polish.toggleSelector(${index})`);
      const measure = await measureInk(win, selector, 3.5);
      assertGlyphCentred(measure, `toggle ${index}`);
      toggleInk.push(measure.ink);
      assertToggleContract(
        await win.webContents.executeJavaScript(`__polish.describeToggle(${index})`),
      );
    }
    // Same glyph, same weight: sub-pixel positions must not change the stroke
    // coverage the way the old 2px geometric bars did.
    const inkRatio = Math.max(...toggleInk) / Math.min(...toggleInk);
    assert.ok(inkRatio <= 1.5,
      `the restored glyph renders at a consistent weight (ink ${toggleInk.join("/")})`);

    // 1a2. Every icon rasterises to the same size (4n px boxes at fractional
    //      positions).
    {
      const toggleBoxes = [];
      for (const index of [0, 1, 2]) {
        const selector = await win.webContents.executeJavaScript(`__polish.toggleSelector(${index})`);
        toggleBoxes.push(await measureRasterBox(win, selector));
      }
      const badgeBoxes = [];
      for (const digit of ["1", "2", "3"]) {
        const selector = await win.webContents.executeJavaScript(`__polish.badgeSelector(${JSON.stringify(digit)})`);
        badgeBoxes.push(await measureRasterBox(win, selector));
      }
      assertIconSizesUniform(toggleBoxes, badgeBoxes, "default zoom");
    }

    // 1b. The (i) and its label text share one horizontal line: centre-vs-box
    //     for every label shape, plus the rasterised text ink for the reported
    //     Chinese label.
    assertLabelAlignment(
      await win.webContents.executeJavaScript("__polish.measureLabelAlignment()"),
      "default zoom",
    );
    const chineseInk = await measureLabelInkAlignment(win, "plain-3");
    assert.ok(!chineseInk.empty, "the Chinese label has rasterised ink");
    assert.ok(Math.abs(chineseInk.delta) <= 1,
      `the (i) sits on the Chinese text's optical centre; ${JSON.stringify(chineseInk)}`);

    // 2. Step-number badges: every digit is centred in its circle.
    for (const digit of BADGE_DIGITS) {
      const selector = await win.webContents.executeJavaScript(`__polish.badgeSelector(${JSON.stringify(digit)})`);
      assertBadgeCentred(await measureInk(win, selector, 4), `step ${digit}`);
    }

    // 3. Approver id-type slider: the monospace segment labels are centred.
    assertIdTypeCentred(await win.webContents.executeJavaScript("__polish.measureIdType()"));

    // 4. Mobile permission-summary dialog: "（推荐）" is moved to line two whole.
    await win.webContents.executeJavaScript("__polish.openConsentDialog()");
    await win.webContents.executeJavaScript("__polish.waitFrames()");
    assertDialogLabels(await win.webContents.executeJavaScript("__polish.measureDialog()"));
    await win.webContents.executeJavaScript("__polish.closeConsentDialog()");
    await win.webContents.executeJavaScript("__polish.waitFrames()");

    // 5. The disclosure hint: in-page tooltip, above the icon, inside the
    //    viewport, and clamped for a right-edge anchor.
    await win.webContents.executeJavaScript("__polish.hoverToggle(0)");
    await win.webContents.executeJavaScript("__polish.waitFrames()");
    assertTooltip(
      await win.webContents.executeJavaScript("__polish.measureTooltip(0)"),
      { expectAbove: true },
      "first toggle",
    );
    const rightEdge = await win.webContents.executeJavaScript(`
      (() => {
        const row = document.querySelectorAll(".row")[2];
        row.querySelector(".row-label").style.textAlign = "right";
        __polish.hoverToggle(2);
        return __polish.measureTooltip(2);
      })()
    `);
    assertTooltip(rightEdge, { expectAbove: true }, "right-edge toggle");

    // 6. Settings text zoom is a root CSS zoom, so the fixed-position hint has
    //    to convert between visual and unzoomed pixel spaces to stay glued to
    //    its icon, and the glyph must stay centred at every scale.
    for (const zoom of [0.8, 1.25, 1.5]) {
      applyZoomToWindow(win, zoom);
      await win.webContents.__clawdTextZoomQueue;
      await win.webContents.executeJavaScript("__polish.waitFrames()");
      await win.webContents.executeJavaScript("__polish.hoverToggle(0)");
      await win.webContents.executeJavaScript("__polish.waitFrames()");
      assertTooltipUnderZoom(
        await win.webContents.executeJavaScript("__polish.measureTooltip(0)"),
        zoom,
        `zoom ${zoom}`,
      );
      const selector = await win.webContents.executeJavaScript("__polish.toggleSelector(0)");
      assertGlyphCentred(await measureInk(win, selector, 3.5), `zoom ${zoom} glyph`, 0.9);
      assertLabelAlignment(
        await win.webContents.executeJavaScript("__polish.measureLabelAlignment()"),
        `zoom ${zoom} labels`,
      );
    }
    applyZoomToWindow(win, 1);
    await win.webContents.__clawdTextZoomQueue;

    // 7. Escape dismisses the hint; the disclosure itself is still closed.
    await win.webContents.executeJavaScript("__polish.pressEscape()");
    const dismissed = await win.webContents.executeJavaScript("__polish.measureTooltip(0)");
    assert.equal(dismissed.ariaHidden, "true", "Escape hides the hint");

    // 8. A repaint removes the anchor, which must also dismiss the hint.
    await win.webContents.executeJavaScript("__polish.hoverToggle(0)");
    await win.webContents.executeJavaScript(`
      document.getElementById("rows").innerHTML = "";
      ClawdSettingsCore.ops.requestRender({ content: true });
      void 0;
    `);
    const afterRepaint = await win.webContents.executeJavaScript(`
      (() => {
        const tooltip = document.querySelector(".settings-tooltip");
        return tooltip ? tooltip.getAttribute("aria-hidden") : "missing";
      })()
    `);
    assert.equal(afterRepaint, "true", "a repaint cannot leave a stale hint on screen");

    console.log("PASS: disclosure glyph centring and weight, step-number centring, "
      + "id-type slider centring, dialog label wrap, tooltip placement at 80/100/125/150% zoom");
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error(error && error.stack || error);
  app.exit(1);
});
