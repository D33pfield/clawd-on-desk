"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

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
const SOURCE_DIR = path.join(__dirname, "..", "assets", "source", "agent-icons");
const SOURCE_MANIFEST_PATH = path.join(SOURCE_DIR, "source-manifest.json");
const OUTPUT_DIR = path.join(__dirname, "..", "assets", "icons", "agents");
const SOURCE_EXTENSIONS = [".png", ".svg"];
const EXPORTER_ENV = "CLAWD_AGENT_ICON_EXPORTER";

function getSourceCandidatePath(agentId, extension) {
  return path.join(SOURCE_DIR, `${agentId}${extension}`);
}

function getSourcePath(agentId) {
  for (const extension of SOURCE_EXTENSIONS) {
    const sourcePath = getSourceCandidatePath(agentId, extension);
    if (fs.existsSync(sourcePath)) return sourcePath;
  }
  return null;
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readSourceManifest() {
  if (!fs.existsSync(SOURCE_MANIFEST_PATH)) return { svgSources: {} };
  const manifest = JSON.parse(fs.readFileSync(SOURCE_MANIFEST_PATH, "utf8"));
  if (!manifest || typeof manifest !== "object") return { svgSources: {} };
  if (!manifest.svgSources || typeof manifest.svgSources !== "object") {
    manifest.svgSources = {};
  }
  return manifest;
}

function writeSourceManifest(manifest) {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  fs.writeFileSync(SOURCE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
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
    manifest.svgSources[agent.id] = { sha256: hashFile(svgPath) };
  }
  return manifest;
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
        "After refreshing the same-name PNG source, run: node scripts/export-agent-icons.js --accept-svg-sources",
      ].join(" ")
    );
  }

  const actualHash = hashFile(svgPath);
  if (actualHash.toLowerCase() === expectedHash.toLowerCase()) return;

  throw new Error(
    [
      `SVG source hash changed for ${agentId}.`,
      `Refresh the same-name PNG source from ${path.relative(process.cwd(), svgPath)}, then run: node scripts/export-agent-icons.js --accept-svg-sources`,
    ].join(" ")
  );
}

function exportIcon(agentId, options = {}) {
  if (!nativeImage) {
    throw new Error("Run the Node entrypoint instead: node scripts/export-agent-icons.js");
  }

  const sourcePath = getSourcePath(agentId);
  if (!sourcePath) {
    throw new Error(`Missing source asset for agent icon: ${agentId}`);
  }
  assertRasterSourceCurrent(agentId, options.manifest);

  const image = nativeImage.createFromPath(sourcePath);
  if (!image || image.isEmpty()) {
    throw new Error(`Unable to load agent icon source: ${sourcePath}`);
  }

  const outputPath = path.join(OUTPUT_DIR, `${agentId}.png`);
  const resized = image.resize({ width: ICON_SIZE, height: ICON_SIZE, quality: "best" });
  if (!resized || resized.isEmpty()) {
    throw new Error(`Unable to export agent icon: ${agentId}`);
  }

  if (!options.dryRun) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(outputPath, resized.toPNG());
  }

  return { agentId, sourcePath, outputPath };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const acceptSvgSources = process.argv.includes("--accept-svg-sources");
  const exported = [];
  const agents = getAllAgents();
  const manifest = readSourceManifest();

  if (acceptSvgSources) {
    updateSvgSourceHashes(manifest, agents);
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
  const extension = process.platform === "win32" ? ".cmd" : "";
  return path.join(__dirname, "..", "node_modules", ".bin", `electron${extension}`);
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
    shell: process.platform === "win32",
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
  SOURCE_DIR,
  SOURCE_MANIFEST_PATH,
  OUTPUT_DIR,
  getSourcePath,
  readSourceManifest,
  writeSourceManifest,
  updateSvgSourceHashes,
  assertRasterSourceCurrent,
  exportIcon,
};
