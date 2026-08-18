import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coerceSheetAction, collectSheetActions, MAX_SHEET_ACTIONS } from "../src/entourage.js";

describe("coerceSheetAction", () => {
  it("accepts a well-formed append", () => {
    assert.deepEqual(coerceSheetAction({ op: "append", list: "shopping", item: "balloons" }), {
      op: "append",
      list: "shopping",
      item: "balloons",
    });
  });

  it("normalises op case/whitespace and trims list", () => {
    assert.deepEqual(coerceSheetAction({ op: " APPEND ", list: " shopping ", item: "cooler" }), {
      op: "append",
      list: "shopping",
      item: "cooler",
    });
  });

  it("allows list op without an item", () => {
    assert.deepEqual(coerceSheetAction({ op: "list", list: "todo" }), {
      op: "list",
      list: "todo",
      item: "",
    });
  });

  it("rejects unknown ops", () => {
    assert.equal(coerceSheetAction({ op: "delete_all", list: "shopping", item: "x" }), null);
  });

  it("rejects a missing list", () => {
    assert.equal(coerceSheetAction({ op: "append", item: "x" }), null);
  });

  it("rejects append/remove with an empty item", () => {
    assert.equal(coerceSheetAction({ op: "append", list: "shopping", item: "  " }), null);
    assert.equal(coerceSheetAction({ op: "remove", list: "shopping" }), null);
  });

  it("rejects non-object / nullish input", () => {
    assert.equal(coerceSheetAction(null), null);
    assert.equal(coerceSheetAction(undefined), null);
  });
});

describe("collectSheetActions", () => {
  it("collects a plural array", () => {
    const out = collectSheetActions({
      sheetActions: [
        { op: "append", list: "shopping", item: "milk" },
        { op: "append", list: "shopping", item: "batteries" },
        { op: "list", list: "todo" },
      ],
    });
    assert.equal(out.length, 3);
    assert.equal(out[1].item, "batteries");
  });

  it("still handles the singular field (back-compat)", () => {
    const out = collectSheetActions({ sheetAction: { op: "append", list: "shopping", item: "x" } });
    assert.deepEqual(out, [{ op: "append", list: "shopping", item: "x" }]);
  });

  it("merges plural then singular", () => {
    const out = collectSheetActions({
      sheetActions: [{ op: "list", list: "todo" }],
      sheetAction: { op: "append", list: "shopping", item: "x" },
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].op, "list");
    assert.equal(out[1].op, "append");
  });

  it("drops malformed entries but keeps valid ones", () => {
    const out = collectSheetActions({
      sheetActions: [
        { op: "append", list: "shopping", item: "good" },
        { op: "nuke", list: "shopping", item: "bad" },
        { op: "append", item: "no-list" },
        { op: "list", list: "todo" },
      ],
    });
    assert.deepEqual(out.map(a => a.op), ["append", "list"]);
  });

  it("caps at MAX_SHEET_ACTIONS", () => {
    const many = Array.from({ length: MAX_SHEET_ACTIONS + 5 }, (_, i) => ({
      op: "append", list: "shopping", item: `item${i}`,
    }));
    assert.equal(collectSheetActions({ sheetActions: many }).length, MAX_SHEET_ACTIONS);
  });

  it("returns empty for no sheet fields", () => {
    assert.deepEqual(collectSheetActions({}), []);
    assert.deepEqual(collectSheetActions({ sheetActions: "not-an-array" }), []);
  });
});
