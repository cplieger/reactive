import { describe, expect, it } from "vitest";

import { createCollection, effect } from "./index.js";

interface Entity {
  readonly id: string;
  readonly rev: number;
  readonly label: string;
}

const sameRev = (a: Entity, b: Entity): boolean => a.rev === b.rev;

function watch(sig: { readonly value: unknown } | undefined): {
  runs: () => number;
  stop: () => void;
} {
  let runs = 0;
  const stop = effect(() => {
    void sig?.value;
    runs++;
  });
  return { runs: () => runs, stop };
}

describe("createCollection equals", () => {
  it("setAll, upsert, prepend and update notify nothing for an equal entity", () => {
    const coll = createCollection<Entity>((e) => e.id, { equals: sameRev });
    coll.setAll([{ id: "a", rev: 1, label: "first" }]);
    const w = watch(coll.signalFor("a"));
    coll.setAll([{ id: "a", rev: 1, label: "refetched" }]);
    coll.upsert({ id: "a", rev: 1, label: "pushed" });
    coll.prepend([{ id: "a", rev: 1, label: "older page" }]);
    coll.update("a", (cur) => ({ ...cur, label: "edited" }));
    expect(w.runs()).toBe(1);
    expect(coll.get("a")?.label).toBe("first");
    coll.update("a", { id: "a", rev: 2, label: "next" });
    expect(w.runs()).toBe(2);
    expect(coll.get("a")?.label).toBe("next");
    w.stop();
  });

  it("without equals a new entity object notifies", () => {
    const coll = createCollection<Entity>((e) => e.id);
    coll.setAll([{ id: "a", rev: 1, label: "first" }]);
    const w = watch(coll.signalFor("a"));
    coll.setAll([{ id: "a", rev: 1, label: "first" }]);
    expect(w.runs()).toBe(2);
    w.stop();
  });
});
