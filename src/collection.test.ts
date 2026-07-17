import { describe, it, expect } from "vitest";

import { createCollection } from "./collection.js";
import { effect } from "./signal.js";

interface Row {
  id: string;
  n: number;
}
const keyOf = (r: Row): string => r.id;

describe("createCollection", () => {
  it("setAll populates entities + order; get/has/size", () => {
    expect.assertions(5);
    const c = createCollection<Row>(keyOf);
    c.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    expect(c.size).toBe(2);
    expect(c.has("a")).toBe(true);
    expect(c.get("b")).toEqual({ id: "b", n: 2 });
    expect(c.has("z")).toBe(false);
    expect([...c.ids.peek()]).toEqual(["a", "b"]);
  });

  it("upsert appends new ids; updates existing without reordering", () => {
    expect.assertions(3);
    const c = createCollection<Row>(keyOf);
    c.upsert({ id: "a", n: 1 });
    c.upsert({ id: "b", n: 2 });
    expect([...c.ids.peek()]).toEqual(["a", "b"]);
    c.upsert({ id: "a", n: 99 });
    expect([...c.ids.peek()]).toEqual(["a", "b"]);
    expect(c.get("a")).toEqual({ id: "a", n: 99 });
  });

  it("update accepts a value or an updater; absent id is a no-op", () => {
    expect.assertions(3);
    const c = createCollection<Row>(keyOf);
    c.setAll([{ id: "a", n: 1 }]);
    c.update("a", { id: "a", n: 5 });
    expect(c.get("a")).toEqual({ id: "a", n: 5 });
    c.update("a", (cur) => ({ ...cur, n: cur.n + 10 }));
    expect(c.get("a")).toEqual({ id: "a", n: 15 });
    c.update("missing", { id: "missing", n: 1 });
    expect(c.has("missing")).toBe(false);
  });

  it("prepend adds to the front; existing ids update in place without moving", () => {
    expect.assertions(3);
    const c = createCollection<Row>(keyOf);
    c.setAll([
      { id: "b", n: 2 },
      { id: "c", n: 3 },
    ]);
    c.prepend([{ id: "a", n: 1 }]);
    expect([...c.ids.peek()]).toEqual(["a", "b", "c"]);
    c.prepend([{ id: "b", n: 20 }]); // existing → update in place, no reorder
    expect([...c.ids.peek()]).toEqual(["a", "b", "c"]);
    expect(c.get("b")).toEqual({ id: "b", n: 20 });
  });

  it("remove + clear", () => {
    expect.assertions(3);
    const c = createCollection<Row>(keyOf);
    c.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    c.remove("a");
    expect([...c.ids.peek()]).toEqual(["b"]);
    expect(c.signalFor("a")).toBeUndefined();
    c.clear();
    expect(c.size).toBe(0);
  });

  it("TWO-TIER: an effect on `ids` re-runs on structure change but NOT on content update", () => {
    expect.assertions(4);
    const c = createCollection<Row>(keyOf);
    c.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    let structureRuns = 0;
    effect(() => {
      void c.ids.value;
      structureRuns++;
    });
    expect(structureRuns).toBe(1); // initial run
    c.update("a", { id: "a", n: 99 }); // content only → no structural re-run
    expect(structureRuns).toBe(1);
    c.upsert({ id: "c", n: 3 }); // add → structural re-run
    expect(structureRuns).toBe(2);
    c.remove("b"); // remove → structural re-run
    expect(structureRuns).toBe(3);
  });

  it("TWO-TIER: a per-entity effect re-runs only on that entity's change", () => {
    expect.assertions(2);
    const c = createCollection<Row>(keyOf);
    c.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    const sigA = c.signalFor("a");
    if (sigA === undefined) {
      throw new Error("sigA missing");
    }
    const seen: number[] = [];
    effect(() => {
      seen.push(sigA.value.n);
    });
    c.update("a", (cur) => ({ ...cur, n: cur.n + 1 })); // a changes
    c.update("b", (cur) => ({ ...cur, n: cur.n + 1 })); // b changes — should NOT affect a's effect
    expect(seen).toEqual([1, 2]);
    expect(c.get("b")).toEqual({ id: "b", n: 3 });
  });

  it("same-order setAll updates entities without bumping the structure signal", () => {
    expect.assertions(2);
    const c = createCollection<Row>(keyOf);
    c.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    let structureRuns = 0;
    effect(() => {
      void c.ids.value;
      structureRuns++;
    });
    c.setAll([
      { id: "a", n: 10 },
      { id: "b", n: 20 },
    ]); // same ids, same order → no structural re-run
    expect(structureRuns).toBe(1);
    expect(c.get("a")).toEqual({ id: "a", n: 10 });
  });

  it("items() is an ordered reactive snapshot", () => {
    expect.assertions(1);
    const c = createCollection<Row>(keyOf);
    c.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    expect(c.items()).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
  });
});

describe("createCollection: setAll key deduplication", () => {
  it("deduplicates repeated keys — first occurrence keeps the position, last value wins", () => {
    expect.assertions(3);
    const c = createCollection<Row>(keyOf);
    c.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "a", n: 3 },
    ]);
    // Pre-fix, `ids` held ["a", "b", "a"] while one signal backed "a" — the
    // structure and entity tiers disagreed.
    expect([...c.ids.peek()]).toEqual(["a", "b"]);
    expect(c.get("a")).toEqual({ id: "a", n: 3 });
    expect(c.size).toBe(2);
  });

  it("items() never yields a duplicated entity after a duplicate-key setAll", () => {
    expect.assertions(1);
    const c = createCollection<Row>(keyOf);
    c.setAll([
      { id: "a", n: 1 },
      { id: "a", n: 2 },
    ]);
    expect(c.items()).toEqual([{ id: "a", n: 2 }]);
  });
});
