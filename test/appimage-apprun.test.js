"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  REVIEWED_PATH_EXPORTS,
  validateAppRunContent,
} = require("../scripts/verify-appimage-apprun");

const ROOT = path.join(__dirname, "..");
const FIXTURE_ROOT = path.join(__dirname, "fixtures", "appimage-apprun");
const SAFE_FIXTURE = fs.readFileSync(
  path.join(FIXTURE_ROOT, "electron-builder-26.15.7.AppRun"),
  "utf8"
);
const VULNERABLE_FIXTURE = fs.readFileSync(
  path.join(FIXTURE_ROOT, "electron-builder-26.8.1.AppRun"),
  "utf8"
);

test("accepts the reviewed electron-builder 26.15.7 AppRun assignments", () => {
  const result = validateAppRunContent(SAFE_FIXTURE);
  assert.deepStrictEqual(Object.keys(result), [...REVIEWED_PATH_EXPORTS]);
  for (const variableName of REVIEWED_PATH_EXPORTS) {
    assert.match(result[variableName].inheritedUnset, /^\//);
    assert.match(result[variableName].inheritedSet, /^\//);
  }
});

test("rejects the vulnerable electron-builder 26.8.1 AppRun assignments", () => {
  assert.throws(
    () => validateAppRunContent(VULNERABLE_FIXTURE),
    /exactly one top-level export|empty search-path|non-absolute|unreviewed shell syntax/
  );
});

test("rejects a relative literal path component", () => {
  const changed = SAFE_FIXTURE.replace(
    "${APPDIR}/usr/share/",
    "./share/"
  );
  assert.throws(() => validateAppRunContent(changed), /non-absolute/);
});

test("rejects an empty path element", () => {
  const changed = SAFE_FIXTURE.replace(
    "${APPDIR}/usr/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}",
    "${APPDIR}/usr/lib::${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
  );
  assert.throws(() => validateAppRunContent(changed), /empty search-path/);
});

test("rejects command substitution in a reviewed export", () => {
  const changed = SAFE_FIXTURE.replace(
    "${APPDIR}:${APPDIR}/usr/sbin",
    "${APPDIR}:$(id):${APPDIR}/usr/sbin"
  );
  assert.throws(() => validateAppRunContent(changed), /unreviewed shell syntax/);
});

test("rejects a duplicate reviewed top-level export", () => {
  const changed = `${SAFE_FIXTURE}\nexport PATH="\${APPDIR}"\n`;
  assert.throws(() => validateAppRunContent(changed), /exactly one top-level export/);
});

test("does not count command-prefix LD_LIBRARY_PATH assignments", () => {
  const result = validateAppRunContent(SAFE_FIXTURE);
  assert.strictEqual(result.LD_LIBRARY_PATH.line > 0, true);
});

test("rejects a fifth unreviewed top-level path-list export", () => {
  const changed = `${SAFE_FIXTURE}\nexport PYTHONPATH="\${APPDIR}/python\${PYTHONPATH:+:\${PYTHONPATH}}"\n`;
  assert.throws(() => validateAppRunContent(changed), /path-list exports changed/);
});

test("release and Wayland workflows run the final-artifact AppRun gate", () => {
  const release = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
  const wayland = fs.readFileSync(path.join(ROOT, ".github", "workflows", "wayland-smoke.yml"), "utf8");
  const command = /node scripts\/verify-appimage-apprun\.js --artifact dist\/\*\.AppImage/;

  assert.match(release, command);
  assert.match(wayland, command);
  assert.match(release, /uses: actions\/upload-artifact@v4\n\s+if: always\(\)/);
});
