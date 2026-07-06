const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { detectIrreversible } = require("../src/bubble-format");

const bubbleRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");
const bubbleHtml = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.html"), "utf8");
const bubbleCss = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.css"), "utf8");

describe("detectIrreversible — destructive shell commands get a hint", () => {
  const hits = [
    ["force push", "git push origin main --force", "force-push"],
    ["force push -f", "git push -f origin main", "force-push"],
    ["force-with-lease", "git push --force-with-lease origin main", "force-push"],
    ["remote branch delete", "git push origin --delete feature/x", "remote-delete"],
    ["local branch -D", "git branch -D feature/x", "branch-delete"],
    ["reset --hard", "git reset --hard HEAD~3", "history-rewrite"],
    ["filter-branch", "git filter-branch --tree-filter 'rm secret' HEAD", "history-rewrite"],
    ["rm -rf", "rm -rf build/", "file-delete"],
    ["rm -r", "rm -r old_dir", "file-delete"],
    ["git clean -fd", "git clean -fd", "git-clean"],
    ["npm publish", "npm publish --access public", "publish"],
    ["twine upload", "twine upload dist/*", "publish"],
    ["gh repo delete", "gh repo delete owner/repo --yes", "repo-delete"],
    ["go public", "gh repo edit owner/repo --visibility public", "go-public"],
    ["DROP TABLE", "psql -c 'DROP TABLE users'", "db-destroy"],
    ["terraform destroy", "terraform destroy -auto-approve", "infra-destroy"],
  ];
  for (const [label, cmd, tag] of hits) {
    it(`flags: ${label}`, () => {
      const r = detectIrreversible("Bash", { command: cmd });
      assert.ok(r, `expected hit for: ${cmd}`);
      assert.strictEqual(r.tag, tag);
    });
  }

  it("flags explicit file-delete tools", () => {
    assert.ok(detectIrreversible("delete_file", { path: "/tmp/x" }));
  });
});

describe("detectIrreversible — ordinary commands stay quiet (precision over recall)", () => {
  const misses = [
    ["plain push", "git push origin main"],
    ["pull", "git pull --rebase"],
    ["status", "git status"],
    ["ls", "ls -la"],
    ["npm install", "npm install --save-dev jest"],
    ["npm run publish-docs script name", "npm run docs"],
    ["mkdir", "mkdir -p out"],
    ["rm without -r/-f", "rm notes.txt"],
    ["gh repo view", "gh repo view owner/repo"],
    ["kubectl get", "kubectl get pods"],
  ];
  for (const [label, cmd] of misses) {
    it(`quiet: ${label}`, () => {
      assert.strictEqual(detectIrreversible("Bash", { command: cmd }), null, cmd);
    });
  }

  it("non-shell, non-delete tools stay quiet (delete_draft-like MCP names too)", () => {
    assert.strictEqual(detectIrreversible("Write", { file_path: "/tmp/a" }), null);
    assert.strictEqual(detectIrreversible("mcp__mail__delete_draft", { id: "1" }), null);
  });

  it("missing/garbage input stays quiet, never throws", () => {
    assert.strictEqual(detectIrreversible("Bash", {}), null);
    assert.strictEqual(detectIrreversible("Bash", null), null);
    assert.strictEqual(detectIrreversible(null, null), null);
  });
});

describe("bubble wiring — badge is display-only", () => {
  it("renderer defines localized hint for all 5 bubble locales", () => {
    const count = (bubbleRenderer.match(/irreversibleHint:/g) || []).length;
    assert.strictEqual(count, 5);
  });
  it("badge element exists and starts hidden", () => {
    assert.match(bubbleHtml, /id="irreversibleBadge" style="display:none"/);
  });
  it("badge uses textContent only (never innerHTML)", () => {
    assert.match(bubbleRenderer, /irreversibleBadge\.textContent =/);
    assert.doesNotMatch(bubbleRenderer, /irreversibleBadge\.innerHTML/);
  });
  it("badge never touches decide()/Allow/Deny semantics", () => {
    // the badge block must not call bubbleAPI.decide — display-only invariant
    const block = bubbleRenderer.slice(
      bubbleRenderer.indexOf("Irreversible-action hint"),
      bubbleRenderer.indexOf("Button labels"));
    assert.ok(block.length > 0);
    assert.doesNotMatch(block, /bubbleAPI\.decide/);
  });
  it("badge style exists", () => {
    assert.match(bubbleCss, /\.irreversible-badge \{/);
  });
});
