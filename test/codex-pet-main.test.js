const test = require("node:test");
const assert = require("node:assert");

const createCodexPetMain = require("../src/codex-pet-main");

test("Codex Pet main helpers merge sync summaries without dropping diagnostics", () => {
  const { mergeCodexPetSyncSummaries } = createCodexPetMain.__test;
  const summary = mergeCodexPetSyncSummaries(
    {
      codexPetsDir: "old-pets",
      userThemesDir: "old-themes",
      imported: 1,
      unchanged: 2,
      activeOrphanThemeIds: [42, "codex-pet-a"],
      themes: [{ themeId: "codex-pet-a" }],
      diagnostics: [{ warnings: ["old"] }],
    },
    {
      codexPetsDir: "new-pets",
      updated: 3,
      removed: 1,
      activeOrphanThemeIds: ["42", "codex-pet-b"],
      themes: [{ themeId: "codex-pet-b" }],
      diagnostics: [{ warnings: ["new"] }],
    }
  );

  assert.strictEqual(summary.codexPetsDir, "new-pets");
  assert.strictEqual(summary.userThemesDir, "old-themes");
  assert.strictEqual(summary.imported, 1);
  assert.strictEqual(summary.updated, 3);
  assert.strictEqual(summary.unchanged, 2);
  assert.strictEqual(summary.removed, 1);
  assert.deepStrictEqual(summary.activeOrphanThemeIds, ["42", "codex-pet-a", "codex-pet-b"]);
  assert.deepStrictEqual(summary.themes.map((theme) => theme.themeId), ["codex-pet-a", "codex-pet-b"]);
  assert.strictEqual(summary.diagnostics.length, 2);
});

test("Codex Pet main helpers detect clawd protocol args case-insensitively", () => {
  const { extractClawdProtocolUrls } = createCodexPetMain.__test;
  assert.deepStrictEqual(
    extractClawdProtocolUrls([
      "Clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fpet.json",
      "--flag",
      "https://example.test",
      "clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fother.json",
    ]),
    [
      "Clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fpet.json",
      "clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fother.json",
    ]
  );
});

test("Codex Pet main runtime records sync summaries and normalizes adapter failures", () => {
  const runtime = createCodexPetMain({
    app: {
      getPath(name) {
        assert.strictEqual(name, "userData");
        return "user-data";
      },
      isReady: () => false,
    },
    dialog: {},
    shell: {},
    settingsController: {
      get: () => "clawd",
    },
    themeLoader: {},
    codexPetAdapter: {
      syncCodexPetThemes(options) {
        assert.deepStrictEqual(options, {
          userDataDir: "user-data",
          activeThemeId: "codex-pet-live",
        });
        return { imported: 1, themes: [{ themeId: "codex-pet-live" }] };
      },
    },
    codexPetImporter: {},
  });

  const summary = runtime.syncThemes("codex-pet-live");
  assert.deepStrictEqual(summary, { imported: 1, themes: [{ themeId: "codex-pet-live" }] });
  assert.strictEqual(runtime.getLastSyncSummary(), summary);

  const failingRuntime = createCodexPetMain({
    app: {
      getPath: () => "user-data",
      isReady: () => false,
    },
    dialog: {},
    shell: {},
    settingsController: {
      get: () => "clawd",
    },
    themeLoader: {},
    codexPetAdapter: {
      syncCodexPetThemes() {
        throw new Error("boom");
      },
    },
    codexPetImporter: {},
  });

  const failed = failingRuntime.syncThemes("clawd");
  assert.strictEqual(failed.error, "boom");
  assert.match(failed.diagnostics[0].errors[0], /failed to sync Codex Pet themes: boom/);
  assert.strictEqual(failingRuntime.getLastSyncSummary(), failed);
});
