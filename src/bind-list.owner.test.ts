import { describe, expect, it } from "vitest";

import { bindList } from "./bind-list.js";
import { createCollection } from "./collection.js";
import { createRoot, effect, signal, type Owner } from "./signal.js";

interface Row {
  id: string;
  n: number;
}

describe("bindList rows have their own owners", () => {
  it("a reorder keeps each surviving row's effect; a removed row's owner is disposed", () => {
    const parent = document.createElement("div");
    const coll = createCollection<Row>((r) => r.id);
    const tick = signal(0);
    let nextInstance = 0;
    const instances = new Map<string, number[]>();
    const mounted = new Map<string, number>();
    const owners = new Map<string, Owner>();
    bindList(parent, coll, {
      mount: (_item, id, owner) => {
        owners.set(id, owner);
        const instance = nextInstance++;
        mounted.set(id, instance);
        effect(() => {
          void tick.value;
          const seen = instances.get(id) ?? [];
          seen.push(instance);
          instances.set(id, seen);
        });
        return document.createElement("div");
      },
    });
    coll.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "c", n: 3 },
    ]);
    coll.setAll([
      { id: "c", n: 3 },
      { id: "a", n: 1 },
    ]);
    instances.clear();
    tick.value = 1;
    expect(nextInstance).toBe(3);
    expect(Object.fromEntries(instances)).toEqual({
      a: [mounted.get("a")],
      c: [mounted.get("c")],
    });
    expect(owners.get("b")?.signal.aborted).toBe(true);
    expect(owners.get("a")?.signal.aborted).toBe(false);
    expect(owners.get("c")?.signal.aborted).toBe(false);
  });

  it("a row's owner is disposed before onRemove runs", () => {
    const parent = document.createElement("div");
    const coll = createCollection<Row>((r) => r.id);
    let owner: Owner | undefined;
    let abortedAtRemove: boolean | undefined;
    bindList(parent, coll, {
      mount: (_item, _id, o) => {
        owner = o;
        return document.createElement("div");
      },
      onRemove: () => {
        abortedAtRemove = owner?.signal.aborted;
      },
    });
    coll.setAll([{ id: "a", n: 1 }]);
    coll.remove("a");
    expect(abortedAtRemove).toBe(true);
  });

  it("the list's dispose disposes every row", () => {
    const parent = document.createElement("div");
    const coll = createCollection<Row>((r) => r.id);
    const owners: Owner[] = [];
    const dispose = bindList(parent, coll, {
      mount: (_item, _id, o) => {
        owners.push(o);
        return document.createElement("div");
      },
    });
    coll.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    dispose();
    expect(owners.map((o) => o.signal.aborted)).toEqual([true, true]);
  });

  it("a list bound inside a root is disposed with it", () => {
    const parent = document.createElement("div");
    const coll = createCollection<Row>((r) => r.id);
    let rowOwner: Owner | undefined;
    let updates = 0;
    createRoot((dispose) => {
      bindList(parent, coll, {
        mount: (_item, _id, o) => {
          rowOwner = o;
          return document.createElement("div");
        },
        update: () => {
          updates++;
        },
      });
      coll.setAll([{ id: "a", n: 1 }]);
      dispose();
    });
    coll.update("a", { id: "a", n: 2 });
    coll.setAll([{ id: "b", n: 1 }]);
    expect(rowOwner?.signal.aborted).toBe(true);
    expect(updates).toBe(1);
    expect(parent.children.length).toBe(1);
  });

  it("a row disposal that removes another row finishes the reconcile before the next one", () => {
    const parent = document.createElement("div");
    const coll = createCollection<Row>((r) => r.id);
    const removed: string[] = [];
    bindList(parent, coll, {
      mount: (_item, id, owner) => {
        if (id === "a") {
          owner.onDispose(() => {
            coll.remove("b");
          });
        }
        const el = document.createElement("div");
        el.textContent = id;
        return el;
      },
      onRemove: (_el, id) => {
        removed.push(id);
      },
    });
    coll.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    coll.remove("a");
    expect(coll.ids.peek()).toEqual([]);
    expect([...parent.children].map((c) => c.textContent)).toEqual([]);
    expect(removed).toEqual(["a", "b"]);
  });

  it("a mount's signal reads do not re-run the list's structure", () => {
    const parent = document.createElement("div");
    const coll = createCollection<Row>((r) => r.id);
    const external = signal(0);
    let mounts = 0;
    bindList(parent, coll, {
      mount: () => {
        mounts++;
        void external.value;
        return document.createElement("div");
      },
    });
    coll.setAll([{ id: "a", n: 1 }]);
    const row = parent.children[0];
    external.value = 1;
    expect(mounts).toBe(1);
    expect(parent.children[0]).toBe(row);
  });
});
