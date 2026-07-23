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

      assert.ok(tags.every((tag) => ["svg", "g", "rect"].includes(tag)), `${file}: ${tags.join(",")}`);
      assert.doesNotMatch(source, /<script|<foreignObject|<image|<use|<!DOCTYPE/i);
      assert.doesNotMatch(source, /\bon[a-z]+\s*=|\bhref\s*=|url\s*\(|data:/i);
      for (const fill of source.matchAll(/\bfill="([^"]+)"/g)) {
        assert.match(fill[1], /^#[0-9a-f]{6}$/i, `${file}: unsafe fill ${fill[1]}`);
      }
    }
  });
});
