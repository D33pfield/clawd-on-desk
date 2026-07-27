"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  PET_ACCESSORY_CATALOG,
} = require("../src/pet-customization-catalog");

const ASSET_DIR = path.join(__dirname, "..", "assets", "accessories");

describe("accessory asset audit", () => {
  it("ships exactly the catalog's seven local SVG assets with matching viewBoxes", () => {
    const catalogAssets = PET_ACCESSORY_CATALOG
      .filter((entry) => entry.id !== "none")
      .map((entry) => entry.file)
      .sort();
    const diskAssets = fs.readdirSync(ASSET_DIR)
      .filter((file) => file.endsWith(".svg"))
      .sort();

    assert.deepStrictEqual(diskAssets, catalogAssets);
    assert.strictEqual(diskAssets.length, 7);

    for (const entry of PET_ACCESSORY_CATALOG.filter((item) => item.id !== "none")) {
      const source = fs.readFileSync(path.join(ASSET_DIR, entry.file), "utf8");
      const match = source.match(/\bviewBox="([^"]+)"/);
      assert.ok(match, `${entry.file} should declare a viewBox`);
      assert.deepStrictEqual(
        match[1].trim().split(/\s+/).map(Number),
        [entry.viewBox.x, entry.viewBox.y, entry.viewBox.width, entry.viewBox.height],
        `${entry.file} viewBox should match the catalog`
      );
    }
  });

  it("contains only inert pixel-vector markup and literal colors", () => {
    for (const file of fs.readdirSync(ASSET_DIR).filter((name) => name.endsWith(".svg"))) {
      const source = fs.readFileSync(path.join(ASSET_DIR, file), "utf8");
      const markup = source
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<\?xml[\s\S]*?\?>/g, "");
      const tags = [...markup.matchAll(/<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)/g)]
        .map((match) => match[1].toLowerCase());

      assert.ok(tags.every((tag) => ["svg", "g", "rect", "ellipse", "path"].includes(tag)), `${file}: ${tags.join(",")}`);
      assert.doesNotMatch(source, /<script|<foreignObject|<image|<use|<!DOCTYPE/i);
      assert.doesNotMatch(source, /\bon[a-z]+\s*=|\bhref\s*=|url\s*\(|data:/i);
      for (const paint of source.matchAll(/\b(fill|stroke)="([^"]+)"/g)) {
        assert.match(
          paint[2],
          /^(?:none|#[0-9a-f]{6})$/i,
          `${file}: unsafe ${paint[1]} ${paint[2]}`
        );
      }
    }
  });

  it("centers the Santa hat by its seating brim rather than its pompom silhouette", () => {
    const source = fs.readFileSync(
      path.join(ASSET_DIR, "santa-hat.svg"),
      "utf8"
    );
    const brim = source.match(
      /<rect x="([^"]+)" y="8" width="([^"]+)" height="1" fill="#e3e3e3"\/>/
    );
    assert.ok(brim, "Santa hat should declare its bottom seating brim");
    const centerX = Number(brim[1]) + Number(brim[2]) / 2;
    assert.strictEqual(centerX, 8, "the seating brim should match the 16-unit canvas center");
  });

  it("renders the angel halo as a smooth, centered elliptical ring", () => {
    const source = fs.readFileSync(path.join(ASSET_DIR, "halo.svg"), "utf8");
    assert.doesNotMatch(source, /shape-rendering="crispEdges"|<rect\b/);
    assert.match(
      source,
      /<ellipse cx="7" cy="2\.5" rx="5\.5" ry="1\.55" fill="none" stroke="#ffd84d" stroke-width="0\.8"/
    );
    assert.match(source, /<path\b[^>]*stroke="#fff3b0"[^>]*stroke-width="0\.3"/);
    assert.doesNotMatch(source, /stroke="#e9a928"/);
  });
});
