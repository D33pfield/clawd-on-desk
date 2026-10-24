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

// The audit lives in a hidden offscreen window so it can use real CSS layout
// instead of a DOM shim: centring, text wrapping and tooltip clamping are all
// geometric questions that only resolved layout can answer.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
  * { transition: none !important; animation: none !important; }
</style></head><body>
<div class="app"><aside class="sidebar"></aside>
<main id="content" class="content"><div style="height:180px"></div>
<section class="section" id="rows"></section></main></div>
<div id="modalRoot"></div>
</body></html>`;

const ROW_DESCRIPTION =
  "A request that would be auto-allowed waits for a human when the tool can delete data.";

async function installPageApi(win) {
  // Trailing `void 0` keeps the script's completion value undefined: the module
  // sources end on an assignment whose value cannot cross the IPC boundary.
  for (const source of scripts) await win.webContents.executeJavaScript(`${source}\n;void 0;`);
  await win.webContents.executeJavaScript(`
    window.__polish = (() => {
      const helpers = ClawdSettingsCore.helpers;
      const rows = document.getElementById("rows");

      function buildRow({ label, description, labelAlign = "" }) {
        const row = document.createElement("div");
        row.className = "row";
        const text = document.createElement("div");
        text.className = "row-text";
        const labelNode = document.createElement("span");
        labelNode.className = "row-label";
        labelNode.textContent = label;
        if (labelAlign) labelNode.style.textAlign = labelAlign;
        const desc = document.createElement("span");
        desc.className = "row-desc";
        desc.textContent = description;
        text.appendChild(labelNode);
        text.appendChild(desc);
        row.appendChild(text);
        rows.appendChild(row);
        helpers.attachDescriptionDisclosure(row);
        return row;
      }

      const firstRow = buildRow({ label: "Ask before auto-allowing", description: "${ROW_DESCRIPTION}" });
      buildRow({
        label: "A label wide enough to push its disclosure to the right edge",
        description: "${ROW_DESCRIPTION}",
        labelAlign: "right",
      });

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
        measureToggle(index) {
          const toggle = document.querySelectorAll(".row-desc-toggle")[index];
          const rect = toggle.getBoundingClientRect();
          const style = getComputedStyle(toggle);
          const dot = getComputedStyle(toggle, "::before");
          const stem = getComputedStyle(toggle, "::after");
          const borderTop = parseFloat(style.borderTopWidth);
          const borderLeft = parseFloat(style.borderLeftWidth);
          // Resolved values are normally px, but keep a percentage fallback so
          // the audit still measures geometry if that ever changes.
          const resolve = (value, base) => {
            const numeric = parseFloat(value);
            if (!Number.isFinite(numeric)) return 0;
            return String(value).trim().endsWith("%") ? (numeric / 100) * base : numeric;
          };
          const paddingBoxWidth = rect.width - borderLeft * 2;
          const dotTop = borderTop + parseFloat(dot.top);
          const dotHeight = parseFloat(dot.height);
          const stemTop = borderTop + parseFloat(stem.top);
          const stemHeight = parseFloat(stem.height);
          return {
            width: rect.width,
            height: rect.height,
            fontSize: style.fontSize,
            textContent: toggle.textContent,
            title: toggle.getAttribute("title"),
            ariaDescribedBy: toggle.getAttribute("aria-describedby"),
            dotContent: dot.content,
            dotWidth: parseFloat(dot.width),
            dotHeight,
            stemWidth: parseFloat(stem.width),
            stemHeight,
            // The pseudo elements are positioned against the padding box, so
            // the border offset turns their origin into border-box pixels.
            inkCenterX: borderLeft + resolve(dot.left, paddingBoxWidth),
            inkCenterY: (dotTop + (stemTop + stemHeight)) / 2,
          };
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

function assertToggleCentred(measure, context) {
  const detail = `${context}: ${JSON.stringify(measure)}`;
  assert.equal(Math.round(measure.width), 14, `toggle stays 14px wide; ${detail}`);
  assert.equal(Math.round(measure.height), 14, `toggle stays 14px tall; ${detail}`);
  assert.equal(measure.fontSize, "0px", `the serif glyph must not paint; ${detail}`);
  assert.equal(measure.textContent, "i", `the "i" text stays in the DOM; ${detail}`);
  assert.ok(measure.title == null, `native OS tooltip must not be used; ${detail}`);
  assert.ok(measure.ariaDescribedBy, `description stays programmatically associated; ${detail}`);
  assert.equal(measure.dotContent, '""', `the dot pseudo element paints; ${detail}`);
  assert.equal(measure.dotWidth, measure.stemWidth, `stem and dot share a width; ${detail}`);
  assert.ok(Math.abs(measure.inkCenterX - measure.width / 2) <= 0.5, `ink is horizontally centred; ${detail}`);
  assert.ok(Math.abs(measure.inkCenterY - measure.height / 2) <= 0.5, `ink is vertically centred; ${detail}`);
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
  // The other two actions must not regress into unexpected wrapping.
  assert.equal(keep.text, "保留令牌并启用", `kept label text; ${detail}`);
  assert.equal(keep.keepRect, null, `no parenthetical group for the kept label; ${detail}`);
  assert.equal(cancel.text, "取消", `cancel label text; ${detail}`);
  assert.ok(wrap.dialog.left >= -0.5 && wrap.dialog.right <= wrap.viewport.width + 0.5, `dialog fits; ${detail}`);
  assert.ok(Math.abs((wrap.dialog.left + wrap.dialog.right) / 2 - wrap.viewport.width / 2) <= 1,
    `dialog stays horizontally centred; ${detail}`);
}

function assertTooltip(measure, { expectAbove }, context) {  const detail = `${context}: ${JSON.stringify(measure)}`;
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

async function main() {
  const profile = process.env.CLAWD_DETAIL_POLISH_PROFILE;
  assert.ok(profile && path.isAbsolute(profile), "the test runner must supply an isolated profile");
  app.setPath("userData", profile);
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await installPageApi(win);

    // 1. The (i) disclosure: geometric glyph centring inside the 14px circle.
    for (const index of [0, 1]) {
      assertToggleCentred(
        await win.webContents.executeJavaScript(`__polish.measureToggle(${index})`),
        `toggle ${index}`,
      );
    }

    // 2. Approver id-type slider: the monospace segment labels are centred.
    assertIdTypeCentred(
      await win.webContents.executeJavaScript("__polish.measureIdType()"),
    );

    // 3. Mobile permission-summary dialog: "（推荐）" is moved to line two whole.
    await win.webContents.executeJavaScript("__polish.openConsentDialog()");
    await win.webContents.executeJavaScript("__polish.waitFrames()");
    assertDialogLabels(
      await win.webContents.executeJavaScript("__polish.measureDialog()"),
    );
    await win.webContents.executeJavaScript(`
      document.querySelectorAll(".settings-confirm-actions .soft-btn")[2].click();
      void 0;
    `);

    // 4. The disclosure hint: in-page tooltip, above the icon, inside the
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
        const rows = document.querySelectorAll(".row");
        rows[1].querySelector(".row-label").style.textAlign = "right";
        __polish.hoverToggle(1);
        return __polish.measureTooltip(1);
      })()
    `);
    assertTooltip(rightEdge, { expectAbove: true }, "right-edge toggle");

    // 5. Settings text zoom is a root CSS zoom, so the fixed-position hint has
    //    to convert between visual and unzoomed pixel spaces to stay glued to
    //    its icon.
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
    }
    applyZoomToWindow(win, 1);
    await win.webContents.__clawdTextZoomQueue;

    // Escape dismisses the hint; the disclosure itself is still closed.
    await win.webContents.executeJavaScript("__polish.pressEscape()");
    const dismissed = await win.webContents.executeJavaScript("__polish.measureTooltip(0)");
    assert.equal(dismissed.ariaHidden, "true", "Escape hides the hint");

    // A repaint removes the anchor, which must also dismiss the hint.
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

    console.log("PASS: disclosure glyph centring, id-type slider centring, dialog label wrap, tooltip placement");
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error(error && error.stack || error);
  app.exit(1);
});
