"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { isDeepStrictEqual } = require("util");
const { spawnSync } = require("child_process");
const { writeJsonAtomic } = require("../hooks/json-utils");

let app;
let nativeImage;
try {
  ({ app, nativeImage } = require("electron"));
} catch {
  app = null;
  nativeImage = null;
}

const { getAllAgents } = require("../agents/registry");

const ICON_SIZE = 64;
const ARTWORK_SIZE = 56;
const BYTES_PER_PIXEL = 4;
const ALPHA_CHANNEL_OFFSET = 3;
const SOURCE_DIR = path.join(__dirname, "..", "assets", "source", "agent-icons");
const SOURCE_MANIFEST_PATH = path.join(SOURCE_DIR, "source-manifest.json");
const OUTPUT_DIR = path.join(__dirname, "..", "assets", "icons", "agents");
const SOURCE_EXTENSIONS = [".png", ".svg"];
const EXPORTER_ENV = "CLAWD_AGENT_ICON_EXPORTER";
const SOURCE_PROVENANCE = Object.freeze({
  "antigravity-cli": { originalFilename: "antigravity-color.png", fallback: false },
  "claude-code": { originalFilename: "claudecode-color.png", fallback: false },
  codebuddy: { originalFilename: "codebuddy-color.png", fallback: false },
  codewhale: { originalFilename: "codewhale.png", fallback: true },
  codex: { originalFilename: "openai.png", fallback: false },
  "copilot-cli": { originalFilename: "githubcopilot.png", fallback: false },
  "cursor-agent": { originalFilename: "cursor.png", fallback: false },
  "gemini-cli": { originalFilename: "geminicli-color.png", fallback: false },
  hermes: { originalFilename: "hermesagent.png", fallback: false },
  "kimi-cli": {
    originalFilename: "kimi-cli.png",
    sourceFilename: "kimi-cli-legacy.png",
    fallback: true,
    exportMode: "passthrough",
    archivedSources: [
      { originalFilename: "kimi-color.png", sourceFilename: "kimi-cli.png" },
      { originalFilename: "kimi-color.svg", sourceFilename: "kimi-cli.svg" },
    ],
  },
  "kiro-cli": { originalFilename: "kiro-color.png", fallback: false },
  mimocode: { originalFilename: "xiaomimimo.png", fallback: false },
  openclaw: { originalFilename: "openclaw-color.png", fallback: false },
  opencode: { originalFilename: "opencode.png", fallback: false },
  pi: { originalFilename: "pi.png", fallback: false },
  qoder: { originalFilename: "qoder-color.png", fallback: false },
  qoderwork: {
    originalFilename: "qoderwork.png",
    sourceFilename: "qoderwork-legacy.png",
    fallback: true,
    exportMode: "passthrough",
    archivedSources: [
      { originalFilename: "qoderwork.png", sourceFilename: "qoderwork.png" },
    ],
  },
  "qwen-code": { originalFilename: "qwen-color.png", fallback: false },
  reasonix: { originalFilename: "reasonix.png", fallback: true },
  workbuddy: { originalFilename: "workbuddy.png", fallback: false },
  zcode: { originalFilename: "zcode.png", fallback: true, exportMode: "passthrough" },
});

function getSourceCandidatePath(agentId, extension) {
  return path.join(SOURCE_DIR, `${agentId}${extension}`);
}

function getSourcePath(agentId) {
  const configuredFilename = SOURCE_PROVENANCE[agentId] && SOURCE_PROVENANCE[agentId].sourceFilename;
  if (configuredFilename) {
    const configuredPath = path.join(SOURCE_DIR, configuredFilename);
    return fs.existsSync(configuredPath) ? configuredPath : null;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const sourcePath = getSourceCandidatePath(agentId, extension);
    if (fs.existsSync(sourcePath)) return sourcePath;
  }
  return null;
}

function normalizeTextLineEndings(value) {
  return String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function hashSvgSource(filePath) {
  return crypto
    .createHash("sha256")
    .update(normalizeTextLineEndings(fs.readFileSync(filePath, "utf8")), "utf8")
    .digest("hex");
}

function hashFileSource(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashSource(filePath) {
  return path.extname(filePath).toLowerCase() === ".svg"
    ? hashSvgSource(filePath)
    : hashFileSource(filePath);
}

function readSourceManifest() {
  if (!fs.existsSync(SOURCE_MANIFEST_PATH)) return { sources: {}, svgSources: {} };
  const manifest = JSON.parse(fs.readFileSync(SOURCE_MANIFEST_PATH, "utf8"));
  if (!manifest || typeof manifest !== "object") return { sources: {}, svgSources: {} };
  if (!manifest.sources || typeof manifest.sources !== "object") {
    manifest.sources = {};
  }
  if (!manifest.svgSources || typeof manifest.svgSources !== "object") {
    manifest.svgSources = {};
  }
  return manifest;
}

function writeSourceManifest(manifest) {
  writeJsonAtomic(SOURCE_MANIFEST_PATH, manifest);
}

function hasRasterAndSvgSources(agentId) {
  const pngPath = getSourceCandidatePath(agentId, ".png");
  const svgPath = getSourceCandidatePath(agentId, ".svg");
  return fs.existsSync(pngPath) && fs.existsSync(svgPath);
}

function updateSvgSourceHashes(manifest, agents) {
  manifest.svgSources = {};
  for (const agent of agents) {
    if (!hasRasterAndSvgSources(agent.id)) continue;
    const svgPath = getSourceCandidatePath(agent.id, ".svg");
    manifest.svgSources[agent.id] = { sha256: hashSvgSource(svgPath) };
  }
  return manifest;
}

function getSourceManifestRecord(agentId) {
  const sourcePath = getSourcePath(agentId);
  if (!sourcePath) {
    throw new Error(`Missing source asset for agent icon: ${agentId}`);
  }

  const provenance = SOURCE_PROVENANCE[agentId];
  if (!provenance) {
    throw new Error(`Missing source provenance for agent icon: ${agentId}`);
  }

  const record = {
    agentId,
    originalFilename: provenance.originalFilename,
    sourceFilename: path.basename(sourcePath),
    sourceType: path.extname(sourcePath).slice(1).toLowerCase(),
    sha256: hashSource(sourcePath),
    fallback: provenance.fallback,
  };
  if (provenance.exportMode) record.exportMode = provenance.exportMode;
  if (provenance.archivedSources) {
    record.archivedSources = provenance.archivedSources.map((source) => {
      const archivedPath = path.join(SOURCE_DIR, source.sourceFilename);
      if (!fs.existsSync(archivedPath)) {
        throw new Error(`Missing archived source asset for agent icon: ${source.sourceFilename}`);
      }
      return {
        originalFilename: source.originalFilename,
        sourceFilename: source.sourceFilename,
        sourceType: path.extname(archivedPath).slice(1).toLowerCase(),
        sha256: hashSource(archivedPath),
      };
    });
  }
  return record;
}

function updateSourceRecords(manifest, agents) {
  manifest.sources = {};
  for (const agent of agents) {
    manifest.sources[agent.id] = getSourceManifestRecord(agent.id);
  }
  return manifest;
}

function updateSourceManifest(manifest, agents) {
  updateSourceRecords(manifest, agents);
  updateSvgSourceHashes(manifest, agents);
  return manifest;
}

function assertSourceManifestCurrent(agentId, manifest = readSourceManifest()) {
  const actual = manifest.sources && manifest.sources[agentId];
  const expected = getSourceManifestRecord(agentId);
  if (actual && isDeepStrictEqual(actual, expected)) return;

  throw new Error(
    [
      `Source manifest changed for ${agentId}.`,
      "Review the canonical source and run: npm run export-agent-icons -- --accept-svg-sources",
    ].join(" ")
  );
}

function assertRasterSourceCurrent(agentId, manifest = readSourceManifest()) {
  if (!hasRasterAndSvgSources(agentId)) return;

  const svgPath = getSourceCandidatePath(agentId, ".svg");
  const record = manifest.svgSources && manifest.svgSources[agentId];
  const expectedHash = record && typeof record.sha256 === "string" ? record.sha256 : null;
  if (!expectedHash) {
    throw new Error(
      [
        `Missing SVG source hash for ${agentId}.`,
        "After refreshing the same-name PNG source, run: npm run export-agent-icons -- --accept-svg-sources",
      ].join(" ")
    );
  }

  const actualHash = hashSvgSource(svgPath);
  if (actualHash.toLowerCase() === expectedHash.toLowerCase()) return;

  throw new Error(
    [
      `SVG source hash changed for ${agentId}.`,
      `Refresh the same-name PNG source from ${path.relative(process.cwd(), svgPath)}, then run: npm run export-agent-icons -- --accept-svg-sources`,
    ].join(" ")
  );
}

function getAlphaBounds(bitmap, width, height) {
  const expectedLength = width * height * BYTES_PER_PIXEL;
  if (!Buffer.isBuffer(bitmap) || bitmap.length < expectedLength) {
    throw new Error(`Invalid bitmap buffer for ${width}x${height} image`);
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let hasTransparency = false;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = bitmap[(y * width + x) * BYTES_PER_PIXEL + ALPHA_CHANNEL_OFFSET];
      if (alpha < 255) hasTransparency = true;
      if (alpha === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return {
    hasTransparency,
    bounds: maxX < minX || maxY < minY
      ? null
      : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

function calculateContainedSize(width, height, maximumSize = ARTWORK_SIZE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid artwork dimensions: ${width}x${height}`);
  }

  const scale = Math.min(maximumSize / width, maximumSize / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function centerOffset(containerSize, contentSize) {
  return Math.floor((containerSize - contentSize) / 2);
}

function prepareArtwork(image) {
  const sourceSize = image.getSize();
  const analysis = getAlphaBounds(image.toBitmap(), sourceSize.width, sourceSize.height);
  if (!analysis.bounds) {
    throw new Error("Agent icon source contains no visible pixels");
  }

  const sourceBounds = analysis.hasTransparency
    ? analysis.bounds
    : { x: 0, y: 0, width: sourceSize.width, height: sourceSize.height };
  const cropped = analysis.hasTransparency ? image.crop(sourceBounds) : image;
  const targetSize = calculateContainedSize(sourceBounds.width, sourceBounds.height);
  const resized = targetSize.width === sourceBounds.width && targetSize.height === sourceBounds.height
    ? cropped
    : cropped.resize({ ...targetSize, quality: "best" });
  if (!resized || resized.isEmpty()) {
    throw new Error("Unable to resize agent icon artwork");
  }

  return { resized, sourceSize, sourceBounds, targetSize, hadTransparency: analysis.hasTransparency };
}

function composeCenteredImage(image, targetSize) {
  const bitmap = image.toBitmap();
  const expectedLength = targetSize.width * targetSize.height * BYTES_PER_PIXEL;
  if (bitmap.length < expectedLength) {
    throw new Error(`Invalid resized bitmap for ${targetSize.width}x${targetSize.height} image`);
  }

  const canvas = Buffer.alloc(ICON_SIZE * ICON_SIZE * BYTES_PER_PIXEL);
  const x = centerOffset(ICON_SIZE, targetSize.width);
  const y = centerOffset(ICON_SIZE, targetSize.height);
  const sourceRowBytes = targetSize.width * BYTES_PER_PIXEL;
  const canvasRowBytes = ICON_SIZE * BYTES_PER_PIXEL;

  for (let row = 0; row < targetSize.height; row += 1) {
    const sourceStart = row * sourceRowBytes;
    const canvasStart = (y + row) * canvasRowBytes + x * BYTES_PER_PIXEL;
    bitmap.copy(canvas, canvasStart, sourceStart, sourceStart + sourceRowBytes);
  }

  const composed = nativeImage.createFromBitmap(canvas, {
    width: ICON_SIZE,
    height: ICON_SIZE,
    scaleFactor: 1,
  });
  if (!composed || composed.isEmpty()) {
    throw new Error("Unable to compose centered agent icon");
  }
  return { image: composed, offset: { x, y } };
}

function exportIcon(agentId, options = {}) {
  if (!nativeImage) {
    throw new Error("Run the Node entrypoint instead: node scripts/export-agent-icons.js");
  }

  const sourcePath = getSourcePath(agentId);
  if (!sourcePath) {
    throw new Error(`Missing source asset for agent icon: ${agentId}`);
  }
  assertSourceManifestCurrent(agentId, options.manifest);
  assertRasterSourceCurrent(agentId, options.manifest);

  const image = nativeImage.createFromPath(sourcePath);
  if (!image || image.isEmpty()) {
    throw new Error(`Unable to load agent icon source: ${sourcePath}`);
  }

  const outputPath = path.join(OUTPUT_DIR, `${agentId}.png`);
  const provenance = SOURCE_PROVENANCE[agentId];
  if (provenance.exportMode === "passthrough") {
    if (!options.dryRun) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      fs.copyFileSync(sourcePath, outputPath);
    }
    return { agentId, sourcePath, outputPath, exportMode: "passthrough" };
  }

  const artwork = prepareArtwork(image);
  const composed = composeCenteredImage(artwork.resized, artwork.targetSize);

  if (!options.dryRun) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(outputPath, composed.image.toPNG());
  }

  return {
    agentId,
    sourcePath,
    outputPath,
    sourceSize: artwork.sourceSize,
    sourceBounds: artwork.sourceBounds,
    targetSize: artwork.targetSize,
    offset: composed.offset,
    hadTransparency: artwork.hadTransparency,
  };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const acceptSvgSources = process.argv.includes("--accept-svg-sources");
  const exported = [];
  const agents = getAllAgents();
  const manifest = readSourceManifest();

  if (acceptSvgSources) {
    updateSourceManifest(manifest, agents);
    if (!dryRun) writeSourceManifest(manifest);
  }

  for (const agent of agents) {
    exported.push(exportIcon(agent.id, { dryRun, manifest }));
  }

  for (const entry of exported) {
    const mode = dryRun ? "checked" : "exported";
    console.log(`${mode} ${entry.agentId}: ${path.relative(process.cwd(), entry.outputPath)}`);
  }
}

function getElectronBinary() {
  try {
    const electronPath = require("electron");
    if (typeof electronPath === "string" && electronPath) return electronPath;
  } catch {}

  if (process.platform === "win32") {
    return path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
  }
  return path.join(__dirname, "..", "node_modules", ".bin", "electron");
}

function runInElectron() {
  const electronBin = getElectronBinary();
  if (!fs.existsSync(electronBin)) {
    throw new Error("Electron is not installed. Run npm install before exporting agent icons.");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-agent-icons-"));
  const entryPath = path.join(tempDir, "main.js");
  const packagePath = path.join(tempDir, "package.json");

  fs.writeFileSync(packagePath, JSON.stringify({ main: "main.js" }));
  fs.writeFileSync(
    entryPath,
    [
      `"use strict";`,
      `process.env.${EXPORTER_ENV} = "1";`,
      `require(${JSON.stringify(__filename)});`,
      "",
    ].join("\n")
  );

  const result = spawnSync(electronBin, [tempDir, ...process.argv.slice(2)], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, [EXPORTER_ENV]: "1" },
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
}

if (require.main === module) {
  try {
    runInElectron();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  }
} else if (process.env[EXPORTER_ENV] === "1") {
  try {
    main();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  } finally {
    if (app && typeof app.quit === "function") {
      app.quit();
    }
    process.exit(process.exitCode || 0);
  }
}

module.exports = {
  ICON_SIZE,
  ARTWORK_SIZE,
  SOURCE_DIR,
  SOURCE_MANIFEST_PATH,
  OUTPUT_DIR,
  SOURCE_PROVENANCE,
  getSourcePath,
  readSourceManifest,
  writeSourceManifest,
  normalizeTextLineEndings,
  hashSvgSource,
  hashFileSource,
  hashSource,
  getElectronBinary,
  updateSvgSourceHashes,
  getSourceManifestRecord,
  updateSourceRecords,
  updateSourceManifest,
  assertSourceManifestCurrent,
  assertRasterSourceCurrent,
  getAlphaBounds,
  calculateContainedSize,
  centerOffset,
  prepareArtwork,
  composeCenteredImage,
  exportIcon,
};
