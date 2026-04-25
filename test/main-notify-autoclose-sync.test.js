"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("main settings subscriber notification auto-close sync", () => {
  it("refreshes visible notify timers when notification auto-close seconds change to a positive value", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

    assert.ok(
      source.includes('changes.notificationBubbleAutoCloseSeconds === 0'),
      "main.js should keep the immediate-clear path for 0-second notification bubbles"
    );
    assert.ok(
      source.includes('changes.notificationBubbleAutoCloseSeconds > 0'),
      "main.js should react to positive notificationBubbleAutoCloseSeconds changes"
    );
    assert.ok(
      source.includes('_perm.refreshPassiveNotifyAutoClose'),
      "main.js should trigger permission-side notify timer refreshes"
    );
  });

  it("refreshes visible update-bubble timers when update auto-close seconds change to a positive value", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

    assert.ok(
      source.includes('changes.updateBubbleAutoCloseSeconds === 0'),
      "main.js should keep the immediate-hide path for 0-second update bubbles"
    );
    assert.ok(
      source.includes('changes.updateBubbleAutoCloseSeconds > 0'),
      "main.js should react to positive updateBubbleAutoCloseSeconds changes"
    );
    assert.ok(
      source.includes('_updateBubble.refreshAutoCloseForPolicy'),
      "main.js should trigger update-bubble timer refreshes"
    );
  });
});
