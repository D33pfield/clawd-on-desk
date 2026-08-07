"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  parseUpdaterYaml,
  sha512Base64,
  verifyUpdaterMetadata,
  parseArgs,
} = require("../scripts/verify-updater-metadata");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-updater-metadata-"));
}

function writeArtifact(root, name, content) {
  const filename = path.join(root, name);
  fs.writeFileSync(filename, content);
  return {
    name,
    size: fs.statSync(filename).size,
    sha512: sha512Base64(filename),
  };
}

function yamlFor(files, topPath, { appImageBlockMap = false } = {}) {
  const top = files.find((entry) => entry.name === topPath);
  const lines = ["version: 0.14.0", "files:"];
  for (const entry of files) {
    lines.push(`  - url: ${entry.name}`);
    lines.push(`    sha512: ${entry.sha512}`);
    lines.push(`    size: ${entry.size}`);
    if (appImageBlockMap && entry.name.endsWith(".AppImage")) lines.push("    blockMapSize: 123");
  }
  lines.push(`path: ${topPath}`);
  lines.push(`sha512: ${top.sha512}`);
  lines.push("releaseDate: '2026-08-02T00:00:00.000Z'");
  return `${lines.join("\n")}\n`;
}

test("minimal updater YAML parser keeps files and top-level path separate", () => {
  const parsed = parseUpdaterYaml([
    "version: 1.2.3",
    "files:",
    "  - url: one.exe",
    "    sha512: abc",
    "    size: 10",
    "path: one.exe",
    "sha512: abc",
  ].join("\n"));
  assert.equal(parsed.version, "1.2.3");
  assert.deepEqual(parsed.files, [{ url: "one.exe", sha512: "abc", size: 10 }]);
  assert.equal(parsed.path, "one.exe");
});

test("Windows dual-architecture updater metadata verifies bytes and hashes", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const x64 = writeArtifact(root, "Clawd-on-Desk-Setup-0.14.0-x64.exe", "x64");
  const arm64 = writeArtifact(root, "Clawd-on-Desk-Setup-0.14.0-arm64.exe", "arm64");
  const metadata = path.join(root, "latest.yml");
  fs.writeFileSync(metadata, yamlFor([x64, arm64], x64.name));
  const report = verifyUpdaterMetadata({ metadataPath: metadata, artifactRoot: root, contract: "windows" });
  assert.deepEqual(report.errors, []);
  assert.equal(report.files.length, 2);
});

test("macOS contract requires two DMGs and no invented zip", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const x64 = writeArtifact(root, "Clawd-on-Desk-0.14.0-x64.dmg", "x64");
  const arm64 = writeArtifact(root, "Clawd-on-Desk-0.14.0-arm64.dmg", "arm64");
  const metadata = path.join(root, "latest-mac.yml");
  fs.writeFileSync(metadata, yamlFor([x64, arm64], x64.name));
  assert.deepEqual(
    verifyUpdaterMetadata({ metadataPath: metadata, artifactRoot: root, contract: "mac" }).errors,
    [],
  );
});

test("Linux contract requires AppImage, deb, path, and blockMapSize", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appImage = writeArtifact(root, "Clawd-on-Desk-0.14.0-x86_64.AppImage", "appimage");
  const deb = writeArtifact(root, "Clawd-on-Desk-0.14.0-amd64.deb", "deb");
  const metadata = path.join(root, "latest-linux.yml");
  fs.writeFileSync(metadata, yamlFor([appImage, deb], appImage.name, { appImageBlockMap: true }));
  assert.deepEqual(
    verifyUpdaterMetadata({ metadataPath: metadata, artifactRoot: root, contract: "linux" }).errors,
    [],
  );
});

test("metadata verification reports missing artifacts and tampered hashes", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const x64 = writeArtifact(root, "Clawd-on-Desk-Setup-0.14.0-x64.exe", "x64");
  const arm64 = { name: "Clawd-on-Desk-Setup-0.14.0-arm64.exe", size: 10, sha512: "wrong" };
  const metadata = path.join(root, "latest.yml");
  fs.writeFileSync(metadata, yamlFor([x64, arm64], x64.name));
  const report = verifyUpdaterMetadata({ metadataPath: metadata, artifactRoot: root, contract: "windows" });
  assert.equal(report.errors.some((error) => /does not exist/.test(error)), true);
});

test("updater CLI parser requires metadata, artifact root, and contract", () => {
  assert.throws(() => parseArgs([]), /--metadata is required/);
  assert.throws(() => parseArgs(["--metadata", "latest.yml"]), /--artifact-root is required/);
  assert.throws(
    () => parseArgs(["--metadata", "latest.yml", "--artifact-root", "dist"]),
    /--contract is required/,
  );
});
