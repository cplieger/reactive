// Keyed-list DOM reconciliation: reconcile() mount/update/onRemove + KEY_ATTR.
import { describe, it, expect, vi } from "vitest";
import { signal, effect, reconcile, KEY_ATTR } from "./index.js";
import type { ReconcileSpec } from "./index.js";

describe("reconcile", () => {
  it("mounts items into empty parent", () => {
    expect.assertions(2);
    const parent = document.createElement("div");
    reconcile(parent, [{ id: "a" }, { id: "b" }], {
      key: (i) => i.id,
      mount: (i) => {
        const el = document.createElement("span");
        el.textContent = i.id;
        return el;
      },
    });
    expect(parent.children.length).toBe(2);
    expect(parent.children[0]!.getAttribute(KEY_ATTR)).toBe("a");
  });

  it("removes orphans", () => {
    expect.assertions(1);
    const parent = document.createElement("div");
    reconcile(parent, [{ id: "a" }, { id: "b" }], {
      key: (i) => i.id,
      mount: (i) => {
        const el = document.createElement("span");
        el.textContent = i.id;
        return el;
      },
    });
    reconcile(parent, [{ id: "a" }], {
      key: (i) => i.id,
      mount: (i) => {
        const el = document.createElement("span");
        el.textContent = i.id;
        return el;
      },
    });
    expect(parent.children.length).toBe(1);
  });

  it("calls onRemove for orphans", () => {
    expect.assertions(1);
    const parent = document.createElement("div");
    const removed: string[] = [];
    const spec = {
      key: (i: { id: string }) => i.id,
      mount: (i: { id: string }) => {
        const el = document.createElement("span");
        el.textContent = i.id;
        return el;
      },
      onRemove: (_el: HTMLElement, key: string) => {
        removed.push(key);
      },
    };
    reconcile(parent, [{ id: "a" }, { id: "b" }], spec);
    reconcile(parent, [{ id: "b" }], spec);
    expect(removed).toEqual(["a"]);
  });

  it("reorders without remounting", () => {
    expect.assertions(2);
    const parent = document.createElement("div");
    const spec = {
      key: (i: { id: string }) => i.id,
      mount: (i: { id: string }) => {
        const el = document.createElement("div");
        el.textContent = i.id;
        return el;
      },
    };
    reconcile(parent, [{ id: "a" }, { id: "b" }, { id: "c" }], spec);
    const origB = parent.children[1]!;
    reconcile(parent, [{ id: "c" }, { id: "b" }, { id: "a" }], spec);
    expect(parent.children[1]).toBe(origB); // same DOM node
    expect(parent.children[0]!.textContent).toBe("c");
  });

  it("calls update on existing items", () => {
    expect.assertions(1);
    const parent = document.createElement("div");
    const updated: string[] = [];
    const spec = {
      key: (i: { id: string; v: number }) => i.id,
      mount: (i: { id: string; v: number }) => {
        const el = document.createElement("div");
        el.textContent = String(i.v);
        return el;
      },
      update: (el: HTMLElement, i: { id: string; v: number }) => {
        el.textContent = String(i.v);
        updated.push(i.id);
      },
    };
    reconcile(parent, [{ id: "a", v: 1 }], spec);
    reconcile(parent, [{ id: "a", v: 2 }], spec);
    expect(updated).toEqual(["a"]);
  });
});

describe("reconcile: extended", () => {
  interface Item {
    id: string;
    label: string;
  }

  function mount(item: Item): HTMLElement {
    const li = document.createElement("li");
    li.textContent = item.label;
    return li;
  }

  function update(el: HTMLElement, item: Item): void {
    el.textContent = item.label;
  }

  const spec: ReconcileSpec<Item> = { key: (i) => i.id, mount, update };

  function rendered(parent: ParentNode): string[] {
    const out: string[] = [];
    for (let n = parent.firstChild; n !== null; n = n.nextSibling) {
      if (n.nodeType === 1) {
        out.push((n as HTMLElement).textContent ?? "");
      }
    }
    return out;
  }

  function snapshotRefs(parent: ParentNode): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (let n = parent.firstChild; n !== null; n = n.nextSibling) {
      if (n.nodeType === 1) {
        out.push(n as HTMLElement);
      }
    }
    return out;
  }

  function makeUL(): HTMLUListElement {
    return document.createElement("ul");
  }

  describe("empty cases", () => {
    it("empty parent + empty items → no-op", () => {
      const ul = makeUL();
      reconcile(ul, [], spec);
      expect(ul.children.length).toBe(0);
    });

    it("populated parent + empty items → all removed", () => {
      const ul = makeUL();
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        spec,
      );
      expect(rendered(ul)).toEqual(["A", "B"]);
      reconcile(ul, [], spec);
      expect(ul.children.length).toBe(0);
    });

    it("empty parent + items → all mounted in order", () => {
      const ul = makeUL();
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        spec,
      );
      expect(rendered(ul)).toEqual(["A", "B", "C"]);
    });
  });

  describe("identity preservation", () => {
    it("no-op call: every element kept by reference", () => {
      const ul = makeUL();
      const items: Item[] = [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ];
      reconcile(ul, items, spec);
      const before = snapshotRefs(ul);
      reconcile(ul, items, spec);
      const after = snapshotRefs(ul);
      expect(after).toEqual(before);
    });

    it("update mutates in place; identity preserved", () => {
      const ul = makeUL();
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        spec,
      );
      const [aBefore, bBefore] = snapshotRefs(ul);
      reconcile(
        ul,
        [
          { id: "a", label: "A!" },
          { id: "b", label: "B!" },
        ],
        spec,
      );
      const [aAfter, bAfter] = snapshotRefs(ul);
      expect(aAfter).toBe(aBefore);
      expect(bAfter).toBe(bBefore);
      expect(rendered(ul)).toEqual(["A!", "B!"]);
    });

    it("reorder: identity preserved across moves", () => {
      const ul = makeUL();
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        spec,
      );
      const refs = new Map<string, HTMLElement>();
      for (const el of snapshotRefs(ul)) {
        refs.set(el.getAttribute(KEY_ATTR) ?? "", el);
      }
      reconcile(
        ul,
        [
          { id: "c", label: "C" },
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        spec,
      );
      expect(rendered(ul)).toEqual(["C", "A", "B"]);
      for (const el of snapshotRefs(ul)) {
        const k = el.getAttribute(KEY_ATTR) ?? "";
        expect(el).toBe(refs.get(k));
      }
    });
  });

  describe("insert / remove / mixed", () => {
    it("appends new items at end", () => {
      const ul = makeUL();
      reconcile(ul, [{ id: "a", label: "A" }], spec);
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        spec,
      );
      expect(rendered(ul)).toEqual(["A", "B", "C"]);
    });

    it("prepends new items at front", () => {
      const ul = makeUL();
      reconcile(ul, [{ id: "z", label: "Z" }], spec);
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "z", label: "Z" },
        ],
        spec,
      );
      expect(rendered(ul)).toEqual(["A", "B", "Z"]);
    });

    it("inserts in the middle", () => {
      const ul = makeUL();
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "c", label: "C" },
        ],
        spec,
      );
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        spec,
      );
      expect(rendered(ul)).toEqual(["A", "B", "C"]);
    });

    it("removes from the middle", () => {
      const ul = makeUL();
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        spec,
      );
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "c", label: "C" },
        ],
        spec,
      );
      expect(rendered(ul)).toEqual(["A", "C"]);
    });

    it("reverse order", () => {
      const ul = makeUL();
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        spec,
      );
      reconcile(
        ul,
        [
          { id: "c", label: "C" },
          { id: "b", label: "B" },
          { id: "a", label: "A" },
        ],
        spec,
      );
      expect(rendered(ul)).toEqual(["C", "B", "A"]);
    });

    it("mixed: insert + remove + update + reorder", () => {
      const ul = makeUL();
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        spec,
      );
      reconcile(
        ul,
        [
          { id: "d", label: "D" },
          { id: "b", label: "B!" },
          { id: "a", label: "A" },
        ],
        spec,
      );
      expect(rendered(ul)).toEqual(["D", "B!", "A"]);
    });
  });

  describe("update optionality", () => {
    it("omitting update leaves existing rows unchanged", () => {
      const ul = makeUL();
      const noUpdateSpec: ReconcileSpec<Item> = { key: (i) => i.id, mount };
      reconcile(ul, [{ id: "a", label: "A" }], noUpdateSpec);
      reconcile(ul, [{ id: "a", label: "A — but ignored" }], noUpdateSpec);
      expect(rendered(ul)).toEqual(["A"]);
    });

    it("update is called only on existing items, not on freshly-mounted ones", () => {
      const ul = makeUL();
      let updateCalls = 0;
      const countingSpec: ReconcileSpec<Item> = {
        key: (i) => i.id,
        mount,
        update: (el, item) => {
          updateCalls++;
          update(el, item);
        },
      };
      reconcile(ul, [{ id: "a", label: "A" }], countingSpec);
      expect(updateCalls).toBe(0);
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        countingSpec,
      );
      expect(updateCalls).toBe(1);
    });
  });

  describe("non-keyed siblings preserved", () => {
    it("ignores children without data-reconcile-key", () => {
      const ul = makeUL();
      const header = document.createElement("li");
      header.className = "header";
      header.textContent = "HEADER";
      ul.appendChild(header);

      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        spec,
      );
      expect(rendered(ul)).toEqual(["HEADER", "A", "B"]);
      expect(ul.querySelector(".header")).toBe(header);

      reconcile(ul, [{ id: "b", label: "B" }], spec);
      expect(rendered(ul)).toEqual(["HEADER", "B"]);
      expect(ul.querySelector(".header")).toBe(header);
    });
  });

  describe("signal integration", () => {
    it("effect + reconcile patches DOM on every signal mutation", () => {
      const ul = makeUL();
      const items = signal<readonly Item[]>([]);
      const stop = effect(() => {
        reconcile(ul, items.value, spec);
      });

      items.value = [{ id: "a", label: "A" }];
      expect(rendered(ul)).toEqual(["A"]);

      items.value = [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ];
      expect(rendered(ul)).toEqual(["A", "B"]);

      const aBefore = ul.children[0];
      items.value = [
        { id: "b", label: "B" },
        { id: "a", label: "A!" },
      ];
      expect(rendered(ul)).toEqual(["B", "A!"]);
      expect(ul.children[1]).toBe(aBefore);

      items.value = [];
      expect(ul.children.length).toBe(0);

      stop();
    });
  });

  describe("idempotency", () => {
    it("calling twice with the same input is a no-op the second time", () => {
      const ul = makeUL();
      const items: Item[] = [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ];
      reconcile(ul, items, spec);
      const before = snapshotRefs(ul);
      reconcile(ul, items, spec);
      const after = snapshotRefs(ul);
      expect(after).toEqual(before);
      expect(rendered(ul)).toEqual(["A", "B", "C"]);
    });
  });

  describe("data-reconcile-key tagging", () => {
    it("mounted elements receive the key as data-reconcile-key", () => {
      const ul = makeUL();
      reconcile(ul, [{ id: "alpha", label: "A" }], spec);
      expect(ul.children[0]!.getAttribute(KEY_ATTR)).toBe("alpha");
    });

    it("subsequent mounts with the same key reuse the existing element", () => {
      const ul = makeUL();
      reconcile(ul, [{ id: "x", label: "X" }], spec);
      const first = ul.children[0];
      reconcile(ul, [{ id: "x", label: "X2" }], spec);
      expect(ul.children[0]).toBe(first);
      expect(first?.textContent).toBe("X2");
    });
  });

  describe("onRemove hook", () => {
    it("fires for each orphaned element with element + key", () => {
      const ul = makeUL();
      const removed: string[] = [];
      const teardownSpec: ReconcileSpec<Item> = {
        key: (i) => i.id,
        mount,
        update,
        onRemove: (_el, key) => {
          removed.push(key);
        },
      };
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        teardownSpec,
      );
      reconcile(ul, [{ id: "b", label: "B" }], teardownSpec);
      expect(removed.sort()).toEqual(["a", "c"]);
    });

    it("does not fire when an element is kept (just moved or updated)", () => {
      const ul = makeUL();
      const removed: string[] = [];
      const teardownSpec: ReconcileSpec<Item> = {
        key: (i) => i.id,
        mount,
        update,
        onRemove: (_, key) => {
          removed.push(key);
        },
      };
      reconcile(
        ul,
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        teardownSpec,
      );
      reconcile(
        ul,
        [
          { id: "b", label: "B!" },
          { id: "a", label: "A!" },
        ],
        teardownSpec,
      );
      expect(removed).toEqual([]);
    });
  });

  describe("nested usage", () => {
    it("inner reconcile inside mount/update produces correctly-keyed sublists", () => {
      interface Section {
        id: string;
        rows: Item[];
      }
      const root = document.createElement("div");

      const renderRow: ReconcileSpec<Item> = {
        key: (i) => i.id,
        mount: (i) => {
          const li = document.createElement("li");
          li.textContent = i.label;
          return li;
        },
        update: (el, i) => {
          el.textContent = i.label;
        },
      };

      const renderSection: ReconcileSpec<Section> = {
        key: (s) => s.id,
        mount: (s) => {
          const sec = document.createElement("section");
          const ul = document.createElement("ul");
          sec.appendChild(ul);
          reconcile(ul, s.rows, renderRow);
          return sec;
        },
        update: (sec, s) => {
          const ul = sec.querySelector("ul");
          if (ul !== null) {
            reconcile(ul, s.rows, renderRow);
          }
        },
      };

      reconcile(
        root,
        [
          {
            id: "s1",
            rows: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
          { id: "s2", rows: [{ id: "c", label: "C" }] },
        ],
        renderSection,
      );

      const sec1 = root.children[0]!;
      expect(rendered(sec1.querySelector("ul")!)).toEqual(["A", "B"]);
      expect(rendered(root.children[1]!.querySelector("ul")!)).toEqual(["C"]);

      const sec1Before = sec1;
      reconcile(
        root,
        [
          { id: "s1", rows: [{ id: "a", label: "A!" }] },
          {
            id: "s2",
            rows: [
              { id: "c", label: "C" },
              { id: "d", label: "D" },
            ],
          },
        ],
        renderSection,
      );

      expect(root.children[0]).toBe(sec1Before);
      expect(rendered(root.children[0]!.querySelector("ul")!)).toEqual(["A!"]);
      expect(rendered(root.children[1]!.querySelector("ul")!)).toEqual(["C", "D"]);
    });
  });
});

describe("reconcile: edge cases", () => {
  it("duplicate keys: both elements mount (second key collides as new)", () => {
    const parent = document.createElement("div");
    reconcile(
      parent,
      [
        { id: "a", v: 1 },
        { id: "a", v: 2 },
      ],
      {
        key: (i) => i.id,
        mount: (i) => {
          const el = document.createElement("span");
          el.textContent = String(i.v);
          return el;
        },
      },
    );
    expect(parent.children.length).toBe(2);
  });
});

describe("reconcile: large scale", () => {
  it("1000 keyed nodes: full reverse preserves identity", () => {
    const parent = document.createElement("div");
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: `k${i}`, label: `L${i}` }));
    const spec = {
      key: (i: { id: string; label: string }) => i.id,
      mount: (i: { id: string; label: string }) => {
        const el = document.createElement("span");
        el.textContent = i.label;
        return el;
      },
      update: (el: HTMLElement, i: { id: string; label: string }) => {
        el.textContent = i.label;
      },
    };

    reconcile(parent, items, spec);
    expect(parent.children.length).toBe(1000);

    const firstEl = parent.children[0]!;
    const lastEl = parent.children[999]!;

    const reversed = [...items].reverse();
    reconcile(parent, reversed, spec);
    expect(parent.children.length).toBe(1000);
    expect(parent.children[0]).toBe(lastEl);
    expect(parent.children[999]).toBe(firstEl);
  });

  it("1000 nodes: remove every other, then re-add", () => {
    const parent = document.createElement("div");
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: `k${i}`, label: `L${i}` }));
    const removed: string[] = [];
    const spec = {
      key: (i: { id: string; label: string }) => i.id,
      mount: (i: { id: string; label: string }) => {
        const el = document.createElement("span");
        el.textContent = i.label;
        return el;
      },
      update: (el: HTMLElement, i: { id: string; label: string }) => {
        el.textContent = i.label;
      },
      onRemove: (_el: HTMLElement, key: string) => {
        removed.push(key);
      },
    };

    reconcile(parent, items, spec);

    const evens = items.filter((_, i) => i % 2 === 0);
    reconcile(parent, evens, spec);
    expect(parent.children.length).toBe(500);
    expect(removed.length).toBe(500);

    removed.length = 0;
    reconcile(parent, items, spec);
    expect(parent.children.length).toBe(1000);
    expect(removed.length).toBe(0);
  });

  it("shuffle 1000 nodes preserves identity", () => {
    const parent = document.createElement("div");
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: `k${i}`, label: `L${i}` }));
    const spec = {
      key: (i: { id: string; label: string }) => i.id,
      mount: (i: { id: string; label: string }) => {
        const el = document.createElement("span");
        el.textContent = i.label;
        return el;
      },
      update: (el: HTMLElement, i: { id: string; label: string }) => {
        el.textContent = i.label;
      },
    };

    reconcile(parent, items, spec);
    const refMap = new Map<string, Element>();
    for (const el of Array.from(parent.children)) {
      refMap.set(el.getAttribute("data-reconcile-key")!, el);
    }

    // Deterministic shuffle (linear-congruential, fixed seed) so a failure reproduces.
    const shuffled = [...items];
    let seed = 12345;
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    reconcile(parent, shuffled, spec);
    expect(parent.children.length).toBe(1000);

    for (const el of Array.from(parent.children)) {
      const key = el.getAttribute("data-reconcile-key")!;
      expect(el).toBe(refMap.get(key));
    }
  });
});

describe("reconcile: randomized insert/remove/reorder", () => {
  function makeSpec() {
    return {
      key: (i: { id: string }) => i.id,
      mount: (i: { id: string; v: number }) => {
        const el = document.createElement("div");
        el.textContent = String(i.v);
        return el;
      },
      update: (el: HTMLElement, i: { id: string; v: number }) => {
        el.textContent = String(i.v);
      },
      onRemove: vi.fn(),
    };
  }

  it("50 seeded iterations keep DOM order in sync with the model", () => {
    const parent = document.createElement("div");
    const spec = makeSpec();
    const items: { id: string; v: number }[] = [];
    let nextId = 0;
    let seed = 42;
    // Deterministic linear-congruential RNG so a failure reproduces.
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let iter = 0; iter < 50; iter++) {
      const action = rng();
      if (action < 0.3 && items.length > 0) {
        const idx = Math.floor(rng() * items.length);
        items.splice(idx, 1);
      } else if (action < 0.6) {
        const idx = Math.floor(rng() * (items.length + 1));
        items.splice(idx, 0, { id: `id${nextId++}`, v: iter });
      } else if (items.length > 1) {
        const i = Math.floor(rng() * items.length);
        let j = Math.floor(rng() * items.length);
        if (j === i) {
          j = (j + 1) % items.length;
        }
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      reconcile(parent, items, spec);
      expect(parent.children.length).toBe(items.length);
      for (let k = 0; k < items.length; k++) {
        expect(parent.children[k]!.getAttribute("data-reconcile-key")).toBe(items[k]!.id);
      }
    }
  });
});

describe("reconcile: a throwing lifecycle callback propagates", () => {
  it("key throw propagates to the caller", () => {
    const parent = document.createElement("div");
    expect(() => {
      reconcile(parent, [{ id: 1 }], {
        key: () => {
          throw new Error("key-throw");
        },
        mount: (item) => {
          const el = document.createElement("div");
          el.textContent = String(item);
          return el;
        },
      });
    }).toThrow("key-throw");
  });

  it("mount throw propagates to the caller", () => {
    const parent = document.createElement("div");
    expect(() => {
      reconcile(parent, [{ id: 1 }], {
        key: (item) => String(item.id),
        mount: () => {
          throw new Error("mount-throw");
        },
      });
    }).toThrow("mount-throw");
  });

  it("update throw propagates to the caller", () => {
    const parent = document.createElement("div");
    const spec = {
      key: (item: { id: number; v: string }) => String(item.id),
      mount: (item: { id: number; v: string }) => {
        const el = document.createElement("div");
        el.setAttribute(KEY_ATTR, String(item.id));
        return el;
      },
      update: () => {
        throw new Error("update-throw");
      },
    };
    reconcile(parent, [{ id: 1, v: "a" }], spec);
    expect(() => {
      reconcile(parent, [{ id: 1, v: "b" }], spec);
    }).toThrow("update-throw");
  });

  it("onRemove throw propagates to the caller", () => {
    const parent = document.createElement("div");
    const spec = {
      key: (item: { id: number }) => String(item.id),
      mount: (item: { id: number }) => {
        const el = document.createElement("div");
        el.setAttribute(KEY_ATTR, String(item.id));
        return el;
      },
      onRemove: () => {
        throw new Error("onRemove-throw");
      },
    };
    reconcile(parent, [{ id: 1 }, { id: 2 }], spec);
    expect(() => {
      reconcile(parent, [{ id: 1 }], spec); // removes id=2, onRemove throws
    }).toThrow("onRemove-throw");
  });
});

describe("reconcile: in-place move guard (focus preservation)", () => {
  it("keeps focus in a row whose content updates while its position is unchanged", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const spec = {
      key: (i: { id: string; v: number }) => i.id,
      mount: (i: { id: string; v: number }) => {
        const input = document.createElement("input");
        input.value = String(i.v);
        return input;
      },
      update: (el: HTMLElement, i: { id: string; v: number }) => {
        (el as HTMLInputElement).value = String(i.v);
      },
    };
    reconcile(
      parent,
      [
        { id: "a", v: 1 },
        { id: "b", v: 2 },
      ],
      spec,
    );
    const inputA = parent.children[0] as HTMLInputElement;
    inputA.focus();
    expect(document.activeElement).toBe(inputA);
    // Content-only change, same order: row "a" must NOT be re-inserted. Re-inserting
    // an already-positioned node detaches+reattaches it, which blurs the focused input.
    reconcile(
      parent,
      [
        { id: "a", v: 9 },
        { id: "b", v: 2 },
      ],
      spec,
    );
    expect(document.activeElement).toBe(inputA);
    parent.remove();
  });
});
