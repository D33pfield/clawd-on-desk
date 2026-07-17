"use strict";

// JSONC install matrix for opencode-family members with jsonc: true (today:
// mimocode). Exercises the REAL thin installer (hooks/mimocode-install.js →
// makeFamilyInstaller → opencode-family-jsonc.js) against real temp files —
// the plan §4.1 contract: element-level edits that PRESERVE user comments and
// trailing commas, JSON-branch-identical return shapes, unregister removes
// ALL exact matches (high index → low), and corrupt input never gets
// clobbered.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("node:test");

const {
  registerMimocodePlugin,
  unregisterMimocodePlugin,
  DEFAULT_CONFIG_PATH,
} = require("../hooks/mimocode-install");

const INSTALLER_PATH = path.join(__dirname, "..", "hooks", "mimocode-install.js");
const PLUGIN_DIR = "/abs/hooks/mimocode-plugin";

function tmpConfig(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-mimocode-jsonc-"));
  const configPath = path.join(dir, "mimocode.jsonc");
  if (text !== undefined) fs.writeFileSync(configPath, text);
  return { dir, configPath };
}

function parseJsonc(text) {
  // eslint-disable-next-line global-require
  const { parse } = require("jsonc-parser");
  const errors = [];
  const tree = parse(text, errors, { allowTrailingComma: true });
  assert.deepStrictEqual(errors, [], "fixture/output must stay valid JSONC");
  return tree;
}

describe("mimocode JSONC installer — register", () => {
  it("creates mimocode.jsonc when missing, without a foreign $schema", () => {
    const { configPath } = tmpConfig(undefined);
    const res = registerMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    assert.deepStrictEqual(res, { added: true, skipped: false, created: true, configPath, pluginDir: PLUGIN_DIR });
    const text = fs.readFileSync(configPath, "utf8");
    const tree = parseJsonc(text);
    assert.deepStrictEqual(tree, { plugin: [PLUGIN_DIR] });
    // The pre-family installer wrote opencode.ai's schema URL into mimocode
    // configs; the registry pins schema: null so that never happens again.
    assert.ok(!text.includes("$schema"), "mimocode must not be given opencode's $schema");
  });

  it("appends while PRESERVING comments and trailing commas", () => {
    const original = [
      "{",
      "  // my provider notes",
      '  "model": "mimo/base", /* inline note */',
      '  "plugin": [',
      '    "@vendor/some-plugin",',
      "  ], // keep this array",
      "}",
    ].join("\n");
    const { configPath } = tmpConfig(original);
    const res = registerMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    assert.strictEqual(res.added, true);
    assert.strictEqual(res.created, false);
    const text = fs.readFileSync(configPath, "utf8");
    for (const comment of ["// my provider notes", "/* inline note */", "// keep this array"]) {
      assert.ok(text.includes(comment), `comment lost: ${comment}`);
    }
    assert.deepStrictEqual(parseJsonc(text).plugin, ["@vendor/some-plugin", PLUGIN_DIR]);
  });

  it("is idempotent — second register is byte-identical and reports skipped", () => {
    const { configPath } = tmpConfig('{\n  // note\n  "plugin": [],\n}');
    registerMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    const afterFirst = fs.readFileSync(configPath, "utf8");
    const res = registerMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    assert.deepStrictEqual(res, { added: false, skipped: true, created: false, configPath, pluginDir: PLUGIN_DIR });
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), afterFirst, "skipped register must not rewrite the file");
  });

  it("updates a stale absolute path in place (basename match), keeping comments", () => {
    const { configPath } = tmpConfig('{\n  // stale install\n  "plugin": ["/old/place/hooks/mimocode-plugin"],\n}');
    const res = registerMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    assert.strictEqual(res.added, true);
    const text = fs.readFileSync(configPath, "utf8");
    assert.ok(text.includes("// stale install"));
    assert.deepStrictEqual(parseJsonc(text).plugin, [PLUGIN_DIR]);
  });

  it("never stomps scoped npm specifiers ending in mimocode-plugin", () => {
    const { configPath } = tmpConfig('{\n  "plugin": ["@vendor/mimocode-plugin"],\n}');
    registerMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    assert.deepStrictEqual(parseJsonc(fs.readFileSync(configPath, "utf8")).plugin, [
      "@vendor/mimocode-plugin",
      PLUGIN_DIR,
    ]);
  });

  it("adds the plugin property when missing, preserving sibling keys and comments", () => {
    const { configPath } = tmpConfig('{\n  // just a model\n  "model": "mimo/base",\n}');
    const res = registerMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    assert.strictEqual(res.added, true);
    const text = fs.readFileSync(configPath, "utf8");
    assert.ok(text.includes("// just a model"));
    assert.deepStrictEqual(parseJsonc(text), { model: "mimo/base", plugin: [PLUGIN_DIR] });
  });

  it("replaces a non-array plugin value", () => {
    const { configPath } = tmpConfig('{\n  "plugin": "not-an-array",\n}');
    registerMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    assert.deepStrictEqual(parseJsonc(fs.readFileSync(configPath, "utf8")).plugin, [PLUGIN_DIR]);
  });

  it("throws (and does not clobber) on genuinely corrupt JSONC", () => {
    const original = '{\n  "plugin": [\n';
    const { configPath } = tmpConfig(original);
    assert.throws(
      () => registerMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR }),
      /Failed to read/
    );
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), original, "corrupt config must be left untouched");
  });
});

describe("mimocode JSONC installer — unregister", () => {
  it("removes ALL exact matches (high index → low), keeping comments and other entries", () => {
    const original = [
      "{",
      "  // header",
      '  "plugin": [',
      "    // third-party, keep me",
      '    "@vendor/other",',
      `    "${PLUGIN_DIR}",`,
      `    "${PLUGIN_DIR}",`,
      `    "${PLUGIN_DIR}",`,
      "  ],",
      "}",
    ].join("\n");
    const { configPath } = tmpConfig(original);
    const res = unregisterMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    assert.strictEqual(res.removed, 3);
    assert.strictEqual(res.changed, true);
    assert.strictEqual(res.skipped, false);
    const text = fs.readFileSync(configPath, "utf8");
    assert.ok(text.includes("// header"));
    assert.ok(text.includes("// third-party, keep me"), "comments not adjacent-after a removed element must survive");
    assert.deepStrictEqual(parseJsonc(text).plugin, ["@vendor/other"]);
  });

  it("KNOWN LIMIT: trivia immediately FOLLOWING a removed element may be dropped", () => {
    // jsonc-parser's element removal spans forward to the next element, so a
    // trailing same-line comment or a full-line comment sitting between a
    // removed element and its successor is collateral (empirically probed).
    // Pinned here so the behavior is documented, not accidental — comments
    // above elements that are not preceded by a removed element are the
    // guaranteed-preserved shape (previous test).
    const { configPath } = tmpConfig([
      "{",
      '  "plugin": [',
      `    "${PLUGIN_DIR}",`,
      "    // note below the removed entry (may be dropped)",
      '    "@vendor/other", // boundary comment (may be dropped)',
      "  ],",
      "}",
    ].join("\n"));
    const res = unregisterMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    assert.strictEqual(res.removed, 1);
    assert.deepStrictEqual(parseJsonc(fs.readFileSync(configPath, "utf8")).plugin, ["@vendor/other"]);
  });

  it("is exact-match only: a different absolute path with the same basename survives", () => {
    const { configPath } = tmpConfig(`{\n  "plugin": ["/elsewhere/hooks/mimocode-plugin"],\n}`);
    const res = unregisterMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR });
    assert.strictEqual(res.removed, 0);
    assert.strictEqual(res.skipped, true);
    assert.deepStrictEqual(parseJsonc(fs.readFileSync(configPath, "utf8")).plugin, ["/elsewhere/hooks/mimocode-plugin"]);
  });

  it("tolerates ENOENT and a missing plugin array", () => {
    const missing = tmpConfig(undefined);
    assert.deepStrictEqual(
      unregisterMimocodePlugin({ silent: true, configPath: missing.configPath, pluginDir: PLUGIN_DIR }),
      { removed: 0, changed: false, skipped: true, configPath: missing.configPath, pluginDir: PLUGIN_DIR }
    );
    const noArray = tmpConfig('{\n  // nothing here\n  "model": "mimo/base",\n}');
    const res = unregisterMimocodePlugin({ silent: true, configPath: noArray.configPath, pluginDir: PLUGIN_DIR });
    assert.strictEqual(res.removed, 0);
    assert.strictEqual(res.skipped, true);
  });

  it("writes a backup of the PRE-EDIT text when options.backup is set", () => {
    const original = `{\n  // precious\n  "plugin": ["${PLUGIN_DIR}"],\n}`;
    const { configPath } = tmpConfig(original);
    const res = unregisterMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR, backup: true });
    assert.strictEqual(res.removed, 1);
    assert.ok(res.backupPath, "backupPath must be reported when backup: true");
    assert.strictEqual(fs.readFileSync(res.backupPath, "utf8"), original, "backup must hold the pre-edit text");
  });

  it("throws on corrupt JSONC instead of guessing", () => {
    const { configPath } = tmpConfig("{ oops");
    assert.throws(
      () => unregisterMimocodePlugin({ silent: true, configPath, pluginDir: PLUGIN_DIR }),
      /Failed to read/
    );
  });
});

describe("mimocode installer wrapper surface (plan §5 contract)", () => {
  it("exports the complete legacy surface and family default paths", () => {
    const mod = require("../hooks/mimocode-install");
    for (const key of [
      "DEFAULT_PARENT_DIR",
      "DEFAULT_CONFIG_PATH",
      "registerMimocodePlugin",
      "unregisterMimocodePlugin",
      "resolvePluginDir",
      "__test",
    ]) {
      assert.ok(key in mod, `missing export: ${key}`);
    }
    assert.ok(
      DEFAULT_CONFIG_PATH.replace(/\\/g, "/").endsWith(".config/mimocode/mimocode.jsonc"),
      `unexpected default config path: ${DEFAULT_CONFIG_PATH}`
    );
    assert.ok(mod.resolvePluginDir("/x/hooks").endsWith("/x/hooks/mimocode-plugin"));
  });

  it("register reports the mimocode-not-found reason integration-sync branches on", () => {
    // Same contract pin as the opencode wrapper test: the shared installer
    // emits `${agentId}-not-found`, and integration-sync's mimocode branch
    // must consume exactly "mimocode-not-found". The real skip behavior runs
    // in the CLI polite-skip case below.
    const familySrc = fs.readFileSync(require.resolve("../hooks/opencode-family-install.js"), "utf8");
    assert.match(familySrc, /reason: `\$\{agentId\}-not-found`/);
    const syncSrc = fs.readFileSync(require.resolve("../src/integration-sync.js"), "utf8");
    assert.match(syncSrc, /"mimocode-not-found"/);
  });
});

function spawnCli(args, homeDir) {
  const result = spawnSync(process.execPath, [INSTALLER_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  });
  return { status: result.status, stdout: `${result.stdout || ""}${result.stderr || ""}` };
}

describe("mimocode installer CLI entry (node hooks/mimocode-install.js)", () => {
  it("registers on default invocation and unregisters with --uninstall", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-mimocode-cli-"));
    const configDir = path.join(homeDir, ".config", "mimocode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mimocode.jsonc"), '{\n  // hand config\n  "plugin": [],\n}');

    const reg = spawnCli([], homeDir);
    assert.strictEqual(reg.status, 0, reg.stdout);
    assert.match(reg.stdout, /Clawd mimocode plugin → /);
    assert.match(reg.stdout, /Registered: /);
    const text = fs.readFileSync(path.join(configDir, "mimocode.jsonc"), "utf8");
    assert.ok(text.includes("// hand config"), "CLI register must preserve comments");
    assert.strictEqual(parseJsonc(text).plugin.length, 1);

    const un = spawnCli(["--uninstall"], homeDir);
    assert.strictEqual(un.status, 0, un.stdout);
    assert.match(un.stdout, /Clawd mimocode plugin entries removed: 1/);
    assert.deepStrictEqual(parseJsonc(fs.readFileSync(path.join(configDir, "mimocode.jsonc"), "utf8")).plugin, []);
  });

  it("skips politely when mimocode is not installed (exit 0, no config created)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-mimocode-cli-empty-"));
    const res = spawnCli([], homeDir);
    assert.strictEqual(res.status, 0, res.stdout);
    assert.match(res.stdout, /not found — skipping mimocode plugin registration/);
    assert.ok(!fs.existsSync(path.join(homeDir, ".config", "mimocode", "mimocode.jsonc")));
  });
});
