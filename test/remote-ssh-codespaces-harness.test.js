"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "manual", "remote-ssh-codespaces-546.ps1");
const README = path.join(ROOT, "scripts", "manual", "README.md");

test("#546 manual harness is tracked, isolated, and never uses broad process cleanup", () => {
  assert.equal(fs.existsSync(SCRIPT), true);
  assert.equal(fs.existsSync(README), true);
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.match(source, /gh auth status/);
  assert.match(source, /codespace create/);
  assert.match(source, /--retention-period 24h/);
  assert.doesNotMatch(source, /--retention-period 1d/);
  assert.match(source, /--json "name,displayName,state"/);
  assert.match(source, /\$script:CreatedDisplayName = \$displayName/);
  assert.match(source, /Expected one exact display-name match/);
  assert.match(source, /codespace delete --codespace \$deleteName/);
  assert.match(source, /\$env:USERPROFILE = \$harnessHome/);
  assert.match(source, /Get-CimInstance Win32_Process/);
  assert.doesNotMatch(source, /\b(?:taskkill|Stop-Process)\b/i);
});

test("production composition has no harness import or packaged failure-injection switch", () => {
  const production = [
    "main.js",
    "remote-ssh-ipc.js",
    "remote-ssh-runtime.js",
    "remote-ssh-transport-coordinator.js",
  ].map((name) => fs.readFileSync(path.join(ROOT, "src", name), "utf8")).join("\n");
  assert.doesNotMatch(production, /remote-ssh-codespaces-546|scripts[\\/]manual/i);
  assert.doesNotMatch(production, /CLAWD_.*(?:FAIL|INJECT).*SSH/i);
});
