"use strict";

const assert = require("node:assert");
const path = require("node:path");
const test = require("node:test");

const ensure = require("../scripts/ensure-sidecar-binaries");

function makeStream() {
  let text = "";
  return {
    write(chunk) {
      text += String(chunk);
    },
    text() {
      return text;
    },
  };
}

test("runtimeSidecarTarget maps supported runtime platforms to pinned sidecar targets", () => {
  assert.equal(ensure.runtimeSidecarTarget({ platform: "win32", arch: "x64" }).dir, "windows-x64");
  assert.equal(ensure.runtimeSidecarTarget({ platform: "darwin", arch: "arm64" }).dir, "darwin-arm64");
  assert.equal(ensure.runtimeSidecarTarget({ platform: "linux", arch: "x64" }).dir, "linux-x64");
  assert.equal(ensure.runtimeSidecarTarget({ platform: "linux", arch: "arm64" }), null);
});

test("ensureCurrentPlatformSidecar skips when the current binary already exists", async () => {
  const calls = [];
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    arch: "x64",
    rootDir: "D:\\repo",
    env: {},
    fs: {
      existsSync: () => true,
      statSync: () => ({ isFile: () => true }),
    },
    fetchSidecarBinaries: () => {
      calls.push("fetch");
      throw new Error("should not fetch");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.existing, true);
  assert.equal(result.target, "windows-x64");
  assert.deepEqual(calls, []);
});

test("ensureCurrentPlatformSidecar fetches only the current platform target when missing", async () => {
  const fetchCalls = [];
  const stdout = makeStream();
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "win32",
    arch: "x64",
    rootDir: "D:\\repo",
    env: {},
    stdout,
    fs: {
      existsSync: () => false,
    },
    fetchSidecarBinaries: async (options) => {
      fetchCalls.push(options);
      return { ok: true, installed: [] };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.fetched, true);
  assert.equal(result.target, "windows-x64");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].target, "windows-x64");
  assert.equal(fetchCalls[0].rootDir, "D:\\repo");
  assert.match(stdout.text(), /fetching pinned binary/);
});

test("ensureCurrentPlatformSidecar reports fetch failures without throwing", async () => {
  const stderr = makeStream();
  const result = await ensure.ensureCurrentPlatformSidecar({
    platform: "darwin",
    arch: "arm64",
    rootDir: "/repo",
    env: {},
    stdout: makeStream(),
    stderr,
    fs: {
      existsSync: () => false,
    },
    fetchSidecarBinaries: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.command, "npm run fetch:sidecars -- --target darwin-arm64");
  assert.match(stderr.text(), /could not be fetched automatically/);
  assert.match(stderr.text(), /npm run fetch:sidecars -- --target darwin-arm64/);
});

test("ensureCurrentPlatformSidecar honors skip and explicit override env vars", async () => {
  const fetchSidecarBinaries = () => {
    throw new Error("should not fetch");
  };
  assert.deepEqual(await ensure.ensureCurrentPlatformSidecar({
    env: { CLAWD_SKIP_SIDECAR_FETCH: "1" },
    fetchSidecarBinaries,
  }), { ok: true, skipped: true, reason: "env-skip" });
  assert.deepEqual(await ensure.ensureCurrentPlatformSidecar({
    env: { CLAWD_CC_CONNECT_CLAWD_PATH: "/tmp/sidecar" },
    fetchSidecarBinaries,
  }), { ok: true, skipped: true, reason: "override-path" });
});

test("sidecarFetchCommand gives the manual recovery command", () => {
  assert.equal(
    ensure.sidecarFetchCommand("windows-x64"),
    "npm run fetch:sidecars -- --target windows-x64"
  );
});
