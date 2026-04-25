const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const bubbleHtml = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.html"), "utf8");

describe("AskUserQuestion bubble overflow", () => {
  it("scrolls only elicitation content while leaving footer actions outside the scroll area", () => {
    assert.match(
      bubbleHtml,
      /\.card\.elicitation-scrollable \.elicitation-form \{[\s\S]*overflow-y: auto;/
    );
    assert.match(
      bubbleHtml,
      /<div class="elicitation-form" id="elicitationForm"><\/div>\s*<div class="elicitation-progress" id="elicitationProgress"><\/div>\s*<div class="actions">/
    );
    const actionsBlock = bubbleHtml.match(/\.actions\s*\{(?<body>[^}]*)\}/);
    assert.ok(actionsBlock, "bubble.html should define a base .actions block");
    assert.doesNotMatch(actionsBlock.groups.body, /overflow-y:/);
  });

  it("reports natural content height before applying the viewport scroll clamp", () => {
    assert.match(bubbleHtml, /function measureNaturalBubbleHeight\(\)/);
    assert.match(bubbleHtml, /card\.classList\.remove\("elicitation-scrollable"\);/);
    assert.match(bubbleHtml, /elicitationForm\.style\.maxHeight = "";/);
    assert.match(
      bubbleHtml,
      /window\.bubbleAPI\.reportHeight\(measureNaturalBubbleHeight\(\)\);[\s\S]*applyElicitationViewport\(\);/
    );
    assert.doesNotMatch(bubbleHtml, /max-height:\s*calc\(100vh/);
  });

  it("reapplies the internal scroll limit after Electron resizes the bubble window", () => {
    assert.match(bubbleHtml, /function applyElicitationViewport\(\)/);
    assert.match(bubbleHtml, /window\.addEventListener\("resize", applyElicitationViewport\);/);
  });
});
