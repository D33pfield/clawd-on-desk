"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { fileURLToPath } = require("url");

const { getAllAgents } = require("../agents/registry");
const { INSTALLABLE_AGENT_IDS } = require("../src/settings-actions-agents");
const {
  ARTWORK_SIZE,
  SOURCE_DIR,
  SOURCE_PROVENANCE,
  calculateContainedSize,
  centerOffset,
  getAlphaBounds,
  getElectronBinary,
  getSourcePath,
  hashFileSource,
  hashSource,
  hashSvgSource,
  prepareArtwork,
  readSourceManifest,
  normalizeTextLineEndings,
  updateSourceManifest,
} = require("../scripts/export-agent-icons");
const {
  AGENT_ICON_DIR,
  getAgentIconPath,
  getAgentIcon,
  getAgentIconUrl,
} = require("../src/state-agent-icons");

function readPngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.strictEqual(buffer.toString("ascii", 1, 4), "PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodeRgbaPng(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.strictEqual(buffer.toString("ascii", 1, 4), "PNG");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  assert.strictEqual(bitDepth, 8, `${path.basename(filePath)} should use 8-bit channels`);
  assert.strictEqual(colorType, 6, `${path.basename(filePath)} should be encoded as RGBA`);
  assert.strictEqual(interlace, 0, `${path.basename(filePath)} should not be interlaced`);

  const idatChunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      idatChunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }

  const bytesPerPixel = 4;
  const rowBytes = width * bytesPerPixel;
  const encoded = zlib.inflateSync(Buffer.concat(idatChunks));
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  let encodedOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = encoded[encodedOffset];
    encodedOffset += 1;
    assert.ok(filter >= 0 && filter <= 4, `Unsupported PNG filter ${filter}`);

    for (let x = 0; x < rowBytes; x += 1) {
      const targetIndex = y * rowBytes + x;
      const left = x >= bytesPerPixel ? pixels[targetIndex - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[targetIndex - rowBytes] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[targetIndex - rowBytes - bytesPerPixel]
        : 0;
      const encodedValue = encoded[encodedOffset];
      encodedOffset += 1;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = above;
      if (filter === 3) predictor = Math.floor((left + above) / 2);
      if (filter === 4) predictor = paethPredictor(left, above, upperLeft);
      pixels[targetIndex] = (encodedValue + predictor) & 0xff;
    }
  }

  return { width, height, pixels };
}

function shouldCheckRuntimeIconEntry(entry) {
  return entry.isFile() && !entry.name.startsWith(".");
}

describe("state agent icons", () => {
  it("returns undefined for BrowserWindow menu icons when nativeImage is unavailable", () => {
    assert.strictEqual(getAgentIcon("claude-code"), undefined);
  });

  it("returns null for missing agent ids and icons", () => {
    assert.strictEqual(getAgentIconUrl(null), null);
    assert.strictEqual(getAgentIconUrl(""), null);
    assert.strictEqual(getAgentIconUrl("missing-agent"), null);
    assert.strictEqual(getAgentIconUrl("../claude-code"), null);
  });

  it("returns a file URL for bundled agent icons", () => {
    const iconUrl = getAgentIconUrl("claude-code");

    assert.strictEqual(new URL(iconUrl).protocol, "file:");
    assert.strictEqual(
      path.normalize(fileURLToPath(iconUrl)),
      path.join(AGENT_ICON_DIR, "claude-code.png")
    );
  });

  it("returns the bundled Kiro PNG icon", () => {
    const iconUrl = getAgentIconUrl("kiro-cli");

    assert.strictEqual(new URL(iconUrl).protocol, "file:");
    assert.strictEqual(
      path.normalize(fileURLToPath(iconUrl)),
      path.join(AGENT_ICON_DIR, "kiro-cli.png")
    );
    assert.strictEqual(getAgentIconPath("kiro-cli"), path.join(AGENT_ICON_DIR, "kiro-cli.png"));
  });

  it("returns bundled PNG icons for Pi and OpenClaw", () => {
    const iconUrl = getAgentIconUrl("pi");

    assert.strictEqual(new URL(iconUrl).protocol, "file:");
    assert.strictEqual(
      path.normalize(fileURLToPath(iconUrl)),
      path.join(AGENT_ICON_DIR, "pi.png")
    );
    assert.strictEqual(getAgentIconPath("pi"), path.join(AGENT_ICON_DIR, "pi.png"));

    const openClawIconUrl = getAgentIconUrl("openclaw");
    assert.strictEqual(new URL(openClawIconUrl).protocol, "file:");
    assert.strictEqual(
      path.normalize(fileURLToPath(openClawIconUrl)),
      path.join(AGENT_ICON_DIR, "openclaw.png")
    );
    assert.strictEqual(getAgentIconPath("openclaw"), path.join(AGENT_ICON_DIR, "openclaw.png"));
  });

  it("has canonical runtime PNG icons for every registered agent", () => {
    const runtimeIconFiles = new Set(
      fs.readdirSync(AGENT_ICON_DIR, { withFileTypes: true })
        .filter(shouldCheckRuntimeIconEntry)
        .map((entry) => entry.name)
    );

    for (const agent of getAllAgents()) {
      assert.ok(
        runtimeIconFiles.has(`${agent.id}.png`),
        `Missing exact runtime PNG icon for ${agent.id}`
      );
    }
    assert.deepStrictEqual(
      [...runtimeIconFiles].sort(),
      getAllAgents().map((agent) => `${agent.id}.png`).sort(),
      "Runtime icon directory should exactly match the agent registry"
    );
  });

  it("has a canonical selected source and provenance record for every registered agent", () => {
    const manifest = readSourceManifest();
    const registeredIds = getAllAgents().map((agent) => agent.id).sort();

    assert.deepStrictEqual(Object.keys(manifest.sources).sort(), registeredIds);
    assert.deepStrictEqual(Object.keys(SOURCE_PROVENANCE).sort(), registeredIds);
    for (const agentId of registeredIds) {
      const sourcePath = getSourcePath(agentId);
      const record = manifest.sources[agentId];
      assert.ok(sourcePath, `Missing canonical source for ${agentId}`);
      assert.ok(fs.existsSync(sourcePath), `Missing source file for ${agentId}`);
      assert.strictEqual(path.dirname(sourcePath), SOURCE_DIR);
      assert.strictEqual(record.agentId, agentId);
      assert.strictEqual(record.sourceFilename, path.basename(sourcePath));
      assert.strictEqual(record.sourceType, path.extname(sourcePath).slice(1));
      assert.strictEqual(record.originalFilename, SOURCE_PROVENANCE[agentId].originalFilename);
      assert.strictEqual(record.fallback, SOURCE_PROVENANCE[agentId].fallback);
    }

    assert.deepStrictEqual(
      Object.entries(manifest.sources)
        .filter(([, record]) => record.fallback)
        .map(([agentId]) => agentId)
        .sort(),
      ["codewhale", "kimi-cli", "qoderwork", "reasonix", "zcode"]
    );
  });

  it("resolves an icon URL for every installable tutorial agent", () => {
    for (const agentId of INSTALLABLE_AGENT_IDS) {
      const iconUrl = getAgentIconUrl(agentId);
      assert.ok(iconUrl, `Missing tutorial icon URL for ${agentId}`);
      assert.strictEqual(
        path.normalize(fileURLToPath(iconUrl)),
        path.join(AGENT_ICON_DIR, `${agentId}.png`),
      );
    }
  });

  it("keeps runtime agent PNG icons at 64x64", () => {
    for (const entry of fs.readdirSync(AGENT_ICON_DIR, { withFileTypes: true })) {
      if (!shouldCheckRuntimeIconEntry(entry)) continue;
      assert.strictEqual(
        path.extname(entry.name).toLowerCase(),
        ".png",
        `${entry.name} should not be stored in the runtime icon directory`
      );
      const iconPath = path.join(AGENT_ICON_DIR, entry.name);
      const size = readPngSize(iconPath);
      assert.deepStrictEqual(size, { width: 64, height: 64 }, `${entry.name} should be 64x64`);
    }
  });

  it("exports centered RGBA artwork inside the 56x56 safe area", () => {
    for (const agent of getAllAgents()) {
      const iconPath = path.join(AGENT_ICON_DIR, `${agent.id}.png`);
      const png = decodeRgbaPng(iconPath);
      const analysis = getAlphaBounds(png.pixels, png.width, png.height);
      const bounds = analysis.bounds;
      assert.ok(bounds, `${agent.id} should have visible artwork`);
      assert.ok(analysis.hasTransparency, `${agent.id} should use a transparent canvas`);
      if (SOURCE_PROVENANCE[agent.id].exportMode === "passthrough") continue;
      assert.ok(bounds.width <= ARTWORK_SIZE, `${agent.id} exceeds the safe-area width`);
      assert.ok(bounds.height <= ARTWORK_SIZE, `${agent.id} exceeds the safe-area height`);

      const leftPadding = bounds.x;
      const rightPadding = png.width - bounds.x - bounds.width;
      const topPadding = bounds.y;
      const bottomPadding = png.height - bounds.y - bounds.height;
      assert.ok(leftPadding >= 4 && rightPadding >= 4, `${agent.id} lacks horizontal padding`);
      assert.ok(topPadding >= 4 && bottomPadding >= 4, `${agent.id} lacks vertical padding`);
      assert.ok(Math.abs(leftPadding - rightPadding) <= 1, `${agent.id} is not horizontally centered`);
      assert.ok(Math.abs(topPadding - bottomPadding) <= 1, `${agent.id} is not vertically centered`);
    }
  });

  it("preserves aspect ratio while containing artwork", () => {
    assert.deepStrictEqual(calculateContainedSize(1200, 600), { width: 56, height: 28 });
    assert.deepStrictEqual(calculateContainedSize(600, 1200), { width: 28, height: 56 });
    assert.deepStrictEqual(calculateContainedSize(640, 640), { width: 56, height: 56 });
    assert.deepStrictEqual(calculateContainedSize(32, 24), { width: 32, height: 24 });
    assert.strictEqual(centerOffset(64, 56), 4);
    assert.strictEqual(centerOffset(64, 35), 14);
  });

  it("preserves approved passthrough icons byte-for-byte", () => {
    const expectedHashes = {
      "kimi-cli": "f2df6353abdcccb3aca6512f04c64c3934a35361b92a0f2e475cdb9f8efe5351",
      qoderwork: "e354f670f8b7310a7bbcb9ca7d313221fb87131aa5d3fef05747718af44b81cf",
      zcode: "491802e3a5b169006b3c56e400d051c0cca9cc8c47c5eedfd0bbe958faacc5b7",
    };
    const manifest = readSourceManifest();

    for (const [agentId, expectedHash] of Object.entries(expectedHashes)) {
      const sourcePath = getSourcePath(agentId);
      const runtimePath = path.join(AGENT_ICON_DIR, `${agentId}.png`);
      const record = manifest.sources[agentId];
      assert.strictEqual(record.fallback, true);
      assert.strictEqual(record.exportMode, "passthrough");
      assert.strictEqual(hashFileSource(sourcePath), expectedHash);
      assert.strictEqual(hashFileSource(runtimePath), expectedHash);
    }
  });

  it("keeps archived Kimi CLI and QoderWork candidates with original provenance", () => {
    const expected = {
      "kimi-cli": [
        { originalFilename: "kimi-color.png", sourceFilename: "kimi-cli.png", sha256: "fb460178c19cd28fc953fb446eb200b4050f4046eae3d84d1a15189eb50f717c" },
        { originalFilename: "kimi-color.svg", sourceFilename: "kimi-cli.svg", sha256: "74a7292aeb0220445d14c5d397d75760e2e8c6ed6a9e5fe4f3023471bf62a9ff" },
      ],
      qoderwork: [
        { originalFilename: "qoderwork.png", sourceFilename: "qoderwork.png", sha256: "31e3cec21e8d99e01208f1fd2a62f2ee5c690eee8210efce011e6de87fa24d92" },
      ],
    };
    const manifest = readSourceManifest();

    for (const [agentId, candidates] of Object.entries(expected)) {
      const archivedSources = manifest.sources[agentId].archivedSources;
      assert.deepStrictEqual(
        archivedSources.map(({ originalFilename, sourceFilename, sha256 }) => ({ originalFilename, sourceFilename, sha256 })),
        candidates
      );
      for (const candidate of archivedSources) {
        assert.strictEqual(hashSource(path.join(SOURCE_DIR, candidate.sourceFilename)), candidate.sha256);
      }
    }
  });

  it("keeps an opaque source's complete canvas instead of alpha-cropping", () => {
    const width = 120;
    const height = 60;
    const bitmap = Buffer.alloc(width * height * 4);
    for (let offset = 3; offset < bitmap.length; offset += 4) bitmap[offset] = 255;
    let cropCalled = false;
    let resizeOptions = null;
    const resized = { isEmpty: () => false };
    const image = {
      getSize: () => ({ width, height }),
      toBitmap: () => bitmap,
      crop: () => {
        cropCalled = true;
        return image;
      },
      resize: (options) => {
        resizeOptions = options;
        return resized;
      },
    };

    const artwork = prepareArtwork(image);
    assert.strictEqual(cropCalled, false);
    assert.strictEqual(artwork.hadTransparency, false);
    assert.deepStrictEqual(artwork.sourceBounds, { x: 0, y: 0, width, height });
    assert.deepStrictEqual(artwork.targetSize, { width: 56, height: 28 });
    assert.deepStrictEqual(resizeOptions, { width: 56, height: 28, quality: "best" });
    assert.strictEqual(artwork.resized, resized);
  });

  it("ignores local dotfiles and directories when checking runtime icon dimensions", () => {
    const entries = [
      { name: ".DS_Store", isFile: () => true },
      { name: "scratch", isFile: () => false },
      { name: "codex.png", isFile: () => true },
    ];

    assert.deepStrictEqual(
      entries
        .filter(shouldCheckRuntimeIconEntry)
        .map((entry) => entry.name),
      ["codex.png"]
    );
  });

  it("keeps selected source and SVG hashes aligned with the source manifest", () => {
    const expectedManifest = updateSourceManifest({ sources: {}, svgSources: {} }, getAllAgents());
    assert.deepStrictEqual(readSourceManifest(), expectedManifest);
  });

  it("normalizes SVG source line endings before hashing", () => {
    assert.strictEqual(
      normalizeTextLineEndings("<svg>\r\n  <path />\r\n</svg>\r"),
      "<svg>\n  <path />\n</svg>\n"
    );

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-svg-hash-"));
    try {
      const lfPath = path.join(tempDir, "lf.svg");
      const crlfPath = path.join(tempDir, "crlf.svg");
      fs.writeFileSync(lfPath, "<svg>\n  <path />\n</svg>\n");
      fs.writeFileSync(crlfPath, "<svg>\r\n  <path />\r\n</svg>\r\n");
      assert.strictEqual(hashSvgSource(crlfPath), hashSvgSource(lfPath));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves the real Electron binary for the exporter entrypoint", () => {
    const electronBinary = getElectronBinary();
    assert.ok(path.isAbsolute(electronBinary), "Electron binary path should be absolute");
    if (process.platform === "win32") {
      assert.strictEqual(path.basename(electronBinary).toLowerCase(), "electron.exe");
    }
  });

  it("returns the cached URL value for repeated lookups", () => {
    const first = getAgentIconUrl("codex");
    const second = getAgentIconUrl("codex");

    assert.strictEqual(second, first);
  });
});
