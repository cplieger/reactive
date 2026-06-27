// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";

import { bindList } from "./bind-list.js";
import { createCollection } from "./collection.js";
import { signal, computed } from "./signal.js";

interface Row {
  id: string;
  n: number;
}
const keyOf = (r: Row): string => r.id;

function setup(): {
  parent: HTMLElement;
  coll: ReturnType<typeof createCollection<Row>>;
  counts: { mount: number; update: number; remove: number };
  dispose: () => void;
} {
  const parent = document.createElement("div");
  const coll = createCollection<Row>(keyOf);
  const counts = { mount: 0, update: 0, remove: 0 };
  const dispose = bindList(parent, coll, {
    mount: (_item, id) => {
      counts.mount++;
      const el = document.createElement("div");
      el.setAttribute("data-row", id);
      return el;
    },
    update: (el, item) => {
      counts.update++;
      el.textContent = String(item.n);
    },
    onRemove: () => {
      counts.remove++;
    },
  });
  return { parent, coll, counts, dispose };
}

describe("bindList", () => {
  it("mounts rows for the initial ids in order, content filled by update", () => {
    expect.assertions(4);
    const { parent, coll, counts } = setup();
    coll.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    expect(parent.children.length).toBe(2);
    expect(counts.mount).toBe(2);
    expect(parent.children[0]?.textContent).toBe("1");
    expect(parent.children[1]?.textContent).toBe("2");
  });

  it("TWO-TIER: a content update repaints only its row — no re-mount", () => {
    expect.assertions(4);
    const { parent, coll, counts } = setup();
    coll.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    const mountAfterInit = counts.mount; // 2
    coll.update("a", { id: "a", n: 99 });
    expect(counts.mount).toBe(mountAfterInit); // no new mount
    expect(parent.children[0]?.textContent).toBe("99"); // a repainted
    expect(parent.children[1]?.textContent).toBe("2"); // b untouched
    expect(parent.children.length).toBe(2);
  });

  it("upsert appends a row; remove drops it and fires onRemove + per-row dispose", () => {
    expect.assertions(4);
    const { parent, coll, counts } = setup();
    coll.setAll([{ id: "a", n: 1 }]);
    coll.upsert({ id: "b", n: 2 });
    expect(parent.children.length).toBe(2);
    expect(parent.children[1]?.getAttribute("data-row")).toBe("b");
    coll.remove("a");
    expect(parent.children.length).toBe(1);
    expect(counts.remove).toBe(1);
  });

  it("setAll reorder repositions existing rows without re-mounting", () => {
    expect.assertions(3);
    const { parent, coll, counts } = setup();
    coll.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    coll.setAll([
      { id: "b", n: 2 },
      { id: "a", n: 1 },
    ]);
    expect(parent.children[0]?.getAttribute("data-row")).toBe("b");
    expect(parent.children[1]?.getAttribute("data-row")).toBe("a");
    expect(counts.mount).toBe(2); // reuse, no new mounts
  });

  it("renders a computed view (ListSource): filtered subset, reactive to the filter signal", () => {
    expect.assertions(3);
    const coll = createCollection<Row>(keyOf);
    coll.setAll([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "c", n: 3 },
    ]);
    const threshold = signal(0);
    const view = {
      ids: computed(() =>
        coll
          .items()
          .filter((r) => r.n > threshold.value)
          .map((r) => r.id),
      ),
      signalFor: (id: string) => coll.signalFor(id),
    };
    const parent = document.createElement("div");
    bindList(parent, view, {
      mount: (_item, id) => {
        const el = document.createElement("div");
        el.setAttribute("data-row", id);
        return el;
      },
      update: (el, item) => {
        el.textContent = String(item.n);
      },
    });
    expect(parent.children.length).toBe(3);
    threshold.value = 1; // drops a (n=1); view recomputes → structural reconcile
    expect(parent.children.length).toBe(2);
    expect(parent.children[0]?.getAttribute("data-row")).toBe("b");
  });

  it("dispose tears down: later updates no longer touch the DOM", () => {
    expect.assertions(2);
    const { parent, coll, counts, dispose } = setup();
    coll.setAll([{ id: "a", n: 1 }]);
    const updatesBefore = counts.update;
    dispose();
    coll.update("a", { id: "a", n: 5 });
    expect(counts.update).toBe(updatesBefore); // per-row effect disposed
    expect(parent.children[0]?.textContent).toBe("1"); // unchanged
  });

  it("immutable rows (spec without `update`): no per-row effect, content changes do not repaint", () => {
    const parent = document.createElement("div");
    const coll = createCollection<Row>(keyOf);
    let mountCount = 0;
    const dispose = bindList(parent, coll, {
      mount: (item, id) => {
        mountCount++;
        const el = document.createElement("div");
        el.setAttribute("data-row", id);
        el.textContent = String(item.n);
        return el;
      },
    });
    coll.setAll([{ id: "a", n: 1 }]);
    expect(parent.children[0]?.textContent).toBe("1");
    expect(mountCount).toBe(1);
    coll.update("a", { id: "a", n: 99 });
    expect(parent.children[0]?.textContent).toBe("1");
    expect(mountCount).toBe(1);
    dispose();
  });

  it("mount tolerates a source whose signalFor returns undefined for a listed id", () => {
    const parent = document.createElement("div");
    const ids = signal<readonly string[]>(["ghost"]);
    const source = { ids, signalFor: (): undefined => undefined };
    const dispose = bindList(parent, source, {
      mount: (_item, id) => {
        const el = document.createElement("div");
        el.setAttribute("data-row", id);
        return el;
      },
      update: (el, _item, id) => {
        el.setAttribute("data-updated", id);
      },
    });
    expect(parent.children[0]?.getAttribute("data-row")).toBe("ghost");
    expect(parent.children[0]?.hasAttribute("data-updated")).toBe(false);
    dispose();
  });
});
