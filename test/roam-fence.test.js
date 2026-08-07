"use strict";

// test/roam-fence.test.js — validation and failure semantics of the roam
// fence loader (src/roam-fence.js). The contract under test (PR #810 review):
//   • ENOENT is stable "fence disabled";
//   • malformed / partially saved / schema-invalid content keeps the last
//     known good state (never fails open to full-area roaming);
//   • strict validation: real booleans and finite in-range numbers only,
//     no Number() coercion of strings;
//   • a UTF-8 BOM does not break parsing.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const createRoamFenceLoader = require("../src/roam-fence");

const VALID = JSON.stringify({
  enabled: true,
  left: 0.25,
  top: 0.1,
  right: 0.75,
  bottom: 0.9,
});

function loaderWith(contents) {
  // contents: string → file body; Error instance → readFile rejects with it
  let current = contents;
  const loader = createRoamFenceLoader({
    readFile: async () => {
      if (current instanceof Error) throw current;
      return current;
    },
    filePath: "/nonexistent/roam-area.json",
  });
  return {
    loader,
    set: (next) => {
      current = next;
    },
  };
}

function enoent() {
  const err = new Error("ENOENT: no such file");
  err.code = "ENOENT";
  return err;
}

describe("roam-fence loader", () => {
  it("starts inactive before any refresh", () => {
    const { loader } = loaderWith(VALID);
    assert.equal(loader.get().active, false);
  });

  it("parses a valid file into an active fence", async () => {
    const { loader } = loaderWith(VALID);
    await loader.refresh();
    assert.deepEqual(loader.get(), {
      active: true,
      left: 0.25,
      top: 0.1,
      right: 0.75,
      bottom: 0.9,
    });
  });

  it("defaults missing edges to the full range", async () => {
    const { loader } = loaderWith(
      JSON.stringify({ enabled: true, left: 0.3 }),
    );
    await loader.refresh();
    assert.deepEqual(loader.get(), {
      active: true,
      left: 0.3,
      top: 0,
      right: 1,
      bottom: 1,
    });
  });

  it("treats a missing file (ENOENT) as fence disabled", async () => {
    const { loader, set } = loaderWith(VALID);
    await loader.refresh();
    assert.equal(loader.get().active, true);
    set(enoent());
    await loader.refresh();
    assert.equal(loader.get().active, false);
  });

  it("treats enabled:false as fence disabled", async () => {
    const { loader } = loaderWith(
      JSON.stringify({ enabled: false, left: 0.25, right: 0.75 }),
    );
    await loader.refresh();
    assert.equal(loader.get().active, false);
  });

  it("strips a UTF-8 BOM before parsing", async () => {
    const { loader } = loaderWith("﻿" + VALID);
    await loader.refresh();
    assert.equal(loader.get().active, true);
  });

  it("keeps the last known good state across a malformed (partial) save", async () => {
    const { loader, set } = loaderWith(VALID);
    await loader.refresh();
    set('{ "enabled": true, "left": 0.2'); // truncated mid-write
    await loader.refresh();
    assert.deepEqual(loader.get(), {
      active: true,
      left: 0.25,
      top: 0.1,
      right: 0.75,
      bottom: 0.9,
    });
  });

  it("keeps the last known good state across a transient read error", async () => {
    const { loader, set } = loaderWith(VALID);
    await loader.refresh();
    const eacces = new Error("EACCES");
    eacces.code = "EACCES";
    set(eacces);
    await loader.refresh();
    assert.equal(loader.get().active, true);
  });

  it("never fails open: invalid content after a valid fence keeps the fence", async () => {
    const { loader, set } = loaderWith(VALID);
    await loader.refresh();
    for (const bad of [
      "not json at all",
      "null",
      "[0.1, 0.9]",
      '"a string"',
      JSON.stringify({ left: 0.1, right: 0.9 }), // enabled missing
      JSON.stringify({ enabled: "true", left: 0.1, right: 0.9 }), // string boolean
      JSON.stringify({ enabled: 1, left: 0.1, right: 0.9 }), // numeric boolean
      JSON.stringify({ enabled: true, left: "0.1", right: 0.9 }), // coercible string
      JSON.stringify({ enabled: true, left: 0.9, right: 0.1 }), // reversed
      JSON.stringify({ enabled: true, left: 0.5, right: 0.5 }), // zero-width fraction
      JSON.stringify({ enabled: true, left: -0.2, right: 0.9 }), // out of range
      JSON.stringify({ enabled: true, left: 0.1, right: 1.5 }), // out of range
      JSON.stringify({ enabled: true, top: 0.8, bottom: 0.2 }), // reversed vertical
      JSON.stringify({ enabled: true, left: 1e999, right: 1 }), // Infinity via JSON
    ]) {
      set(bad);
      await loader.refresh();
      assert.equal(
        loader.get().active,
        true,
        `invalid content must not disturb the fence: ${bad}`,
      );
      assert.equal(loader.get().left, 0.25);
    }
  });

  it("invalid content before any valid save leaves the fence inactive", async () => {
    const { loader } = loaderWith("garbage");
    await loader.refresh();
    assert.equal(loader.get().active, false);
  });

  it("coalesces concurrent refreshes into one read", async () => {
    let reads = 0;
    const loader = createRoamFenceLoader({
      readFile: async () => {
        reads += 1;
        return VALID;
      },
      filePath: "/nonexistent/roam-area.json",
    });
    await Promise.all([loader.refresh(), loader.refresh(), loader.refresh()]);
    assert.equal(reads, 1);
    assert.equal(loader.get().active, true);
  });
});
