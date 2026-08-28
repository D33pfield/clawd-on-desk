"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  PET_ACCESSORY_CATALOG,
  PET_MOUTH_ACCESSORY_CATALOG,
} = require("../src/pet-customization-catalog");

const ASSET_DIR = path.join(__dirname, "..", "assets", "accessories");

describe("accessory asset audit", () => {
  it("ships exactly the head and mouth catalogs' local SVG assets with matching viewBoxes", () => {
    const catalogEntries = [...PET_ACCESSORY_CATALOG, ...PET_MOUTH_ACCESSORY_CATALOG]
      .filter((entry) => entry.id !== "none");
    const catalogAssets = catalogEntries
      .map((entry) => entry.file)
      .sort();
    const diskAssets = fs.readdirSync(ASSET_DIR)
      .filter((file) => file.endsWith(".svg"))
      .sort();

    assert.deepStrictEqual(diskAssets, catalogAssets);
    assert.strictEqual(new Set(catalogAssets).size, catalogAssets.length, "catalog asset names must not collide");
    assert.strictEqual(diskAssets.length, 8);

    for (const entry of catalogEntries) {
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
    for (const file of PET_ACCESSORY_CATALOG.filter((entry) => entry.file).map((entry) => entry.file)) {
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

  it("allows the cigarette's narrow, bounded SMIL grammar and no active references", () => {
    const file = "cigarette.svg";
    const source = fs.readFileSync(path.join(ASSET_DIR, file), "utf8");
    const markup = source
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\?xml[\s\S]*?\?>/g, "");
    const tags = [...markup.matchAll(/<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)/g)]
      .map((match) => match[1]);
    assert.ok(tags.every((tag) => ["svg", "g", "rect", "animate", "animateTransform"].includes(tag)), tags.join(","));
    assert.doesNotMatch(source, /<script|<foreignObject|<image|<use|<!DOCTYPE/i);
    assert.doesNotMatch(source, /\bon[a-z]+\s*=|\bhref\s*=|url\s*\(|data:/i);
    assert.match(source, /shape-rendering="crispEdges"/);
    assert.match(source, /shape-rendering="auto"/);

    const animations = [...source.matchAll(/<(animate|animateTransform)\b([^>]*)\/>/g)];
    assert.ok(animations.length > 0);
    for (const [, tag, rawAttrs] of animations) {
      const attrs = Object.fromEntries(
        [...rawAttrs.matchAll(/([A-Za-z][A-Za-z0-9:-]*)="([^"]*)"/g)]
          .map((match) => [match[1], match[2]])
      );
      const allowed = new Set([
        "attributeName", "type", "values", "keyTimes", "dur", "begin",
        "repeatCount", "calcMode",
      ]);
      assert.ok(Object.keys(attrs).every((name) => allowed.has(name)), `${tag}: ${Object.keys(attrs)}`);
      assert.ok(["fill", "opacity", "transform"].includes(attrs.attributeName));
      if (tag === "animateTransform") assert.strictEqual(attrs.type, "translate");
      else assert.strictEqual(attrs.type, undefined);
      assert.strictEqual(attrs.repeatCount, "indefinite");
      if (attrs.calcMode !== undefined) assert.ok(["discrete", "linear"].includes(attrs.calcMode));
      const dur = Number(String(attrs.dur || "").replace(/s$/, ""));
      assert.ok(Number.isFinite(dur) && dur > 0 && dur <= 10, attrs.dur);
      if (attrs.begin !== undefined) {
        const begin = Number(String(attrs.begin).replace(/s$/, ""));
        assert.ok(Number.isFinite(begin) && Math.abs(begin) <= dur, attrs.begin);
      }
      const values = String(attrs.values || "").split(";");
      assert.ok(values.length >= 2 && values.length <= 16, attrs.values);
      if (attrs.attributeName === "fill") {
        assert.ok(values.every((value) => /^#[0-9a-f]{6}$/i.test(value)));
      } else {
        assert.ok(values.every((value) => (
          value.trim().split(/\s+/).every((part) => Number.isFinite(Number(part)))
        )), attrs.values);
      }
      if (attrs.keyTimes !== undefined) {
        const times = attrs.keyTimes.split(";").map(Number);
        assert.strictEqual(times.length, values.length);
        assert.ok(times.every((value, index) => (
          Number.isFinite(value)
          && value >= 0
          && value <= 1
          && (index === 0 || value >= times[index - 1])
        )));
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
