// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import {
  signal,
  effect,
  batch,
  computed,
  createStore,
  reconcile,
  KEY_ATTR,
  patch,
  trackHandler,
  untracked,
  subscribe,
  isSignal,
  isComputed,
  setEffectErrorHandler,
  on,
} from "./index.js";
import type { ReconcileSpec, ReadonlySignal } from "./index.js";

// ---------------------------------------------------------------------------
// signal + effect + batch
// ---------------------------------------------------------------------------

describe("signal", () => {
  it("reads and writes value", () => {
    expect.assertions(2);
    const s = signal(0);
    expect(s.value).toBe(0);
    s.value = 5;
    expect(s.peek()).toBe(5);
  });

  it("no-op on same value (Object.is)", () => {
    expect.assertions(1);
    const s = signal(1);
    const spy = vi.fn();
    effect(() => {
      void s.value;
      spy();
    });
    spy.mockClear();
    s.value = 1;
    expect(spy).not.toHaveBeenCalled();
  });

  it("NaN equality", () => {
    expect.assertions(1);
    const s = signal(NaN);
    const spy = vi.fn();
    effect(() => {
      void s.value;
      spy();
    });
    spy.mockClear();
    s.value = NaN;
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("effect", () => {
  it("runs immediately on creation", () => {
    expect.assertions(1);
    const spy = vi.fn();
    effect(() => {
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-runs when dependency changes", () => {
    expect.assertions(2);
    const s = signal("a");
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
    expect(spy).toHaveBeenCalledWith("a");
    s.value = "b";
    expect(spy).toHaveBeenCalledWith("b");
  });

  it("tracks dynamic deps", () => {
    expect.assertions(1);
    const cond = signal(true);
    const a = signal(1);
    const b = signal(2);
    const spy = vi.fn();
    effect(() => {
      spy(cond.value ? a.value : b.value);
    });
    spy.mockClear();
    // b is not tracked when cond=true
    b.value = 99;
    expect(spy).not.toHaveBeenCalled();
  });

  it("cleanup runs before re-execution", () => {
    expect.assertions(2);
    const s = signal(0);
    const order: string[] = [];
    effect(() => {
      const v = s.value;
      order.push(`run:${v}`);
      return () => {
        order.push(`cleanup:${v}`);
      };
    });
    s.value = 1;
    expect(order).toEqual(["run:0", "cleanup:0", "run:1"]);
    expect(order.length).toBe(3);
  });

  it("disposal stops re-runs and calls cleanup", () => {
    expect.assertions(2);
    const s = signal(0);
    let cleaned = false;
    const dispose = effect(() => {
      void s.value;
      return () => {
        cleaned = true;
      };
    });
    dispose();
    expect(cleaned).toBe(true);
    s.value = 1;
    // Should not have re-run (no error, no extra call)
    expect(cleaned).toBe(true);
  });

  it("does not leak stale subscriptions on re-run", () => {
    expect.assertions(1);
    const a = signal(1);
    const b = signal(2);
    const cond = signal(true);
    const spy = vi.fn();
    effect(() => {
      spy(cond.value ? a.value : b.value);
    });
    // Switch to b
    cond.value = false;
    spy.mockClear();
    // a should no longer trigger
    a.value = 99;
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("batch", () => {
  it("coalesces multiple signal writes", () => {
    expect.assertions(2);
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
    spy.mockClear();
    batch(() => {
      s.value = 1;
      s.value = 2;
      s.value = 3;
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(3);
  });

  it("nested batch flushes only after outermost", () => {
    expect.assertions(2);
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
    spy.mockClear();
    batch(() => {
      batch(() => {
        s.value = 1;
      });
      // Still inside outer batch — effect should not have run
      expect(spy).not.toHaveBeenCalled();
    });
    // batch flushes synchronously at end of outermost batch
    expect(spy).toHaveBeenCalledWith(1);
  });

  it("flushes synchronously (no MessageChannel)", () => {
    expect.assertions(1);
    const s = signal(0);
    const results: number[] = [];
    effect(() => { results.push(s.value); });
    batch(() => { s.value = 42; });
    // Effect should have already run synchronously
    expect(results).toEqual([0, 42]);
  });
});

// ---------------------------------------------------------------------------
// createStore
// ---------------------------------------------------------------------------

describe("createStore", () => {
  it("get/set round-trip", () => {
    expect.assertions(1);
    const { get, set } = createStore<{ x: number }>();
    set("x", 42);
    expect(get("x")).toBe(42);
  });

  it("subscribe fires on change", () => {
    expect.assertions(2);
    const { set, subscribe } = createStore<{ v: string }>();
    const spy = vi.fn();
    subscribe("v", spy);
    set("v", "hello");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("hello");
  });

  it("subscribe does not fire on same value", () => {
    expect.assertions(1);
    const { set, subscribe } = createStore<{ v: string }>();
    set("v", "same");
    const spy = vi.fn();
    subscribe("v", spy);
    set("v", "same");
    expect(spy).not.toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", () => {
    expect.assertions(1);
    const { set, subscribe } = createStore<{ v: number }>();
    const spy = vi.fn();
    const unsub = subscribe("v", spy);
    set("v", 1);
    unsub();
    set("v", 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("batch coalesces", () => {
    expect.assertions(2);
    const store = createStore<{ a: number; b: number }>();
    const spyA = vi.fn();
    const spyB = vi.fn();
    store.subscribe("a", spyA);
    store.subscribe("b", spyB);
    store.batch(() => {
      store.set("a", 1);
      store.set("b", 2);
      store.set("a", 10);
    });
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyA).toHaveBeenCalledWith(10);
  });

  it("effect auto-tracks keys", () => {
    expect.assertions(2);
    const { get, set, effect: eff } = createStore<{ x: number; y: number }>();
    set("x", 0);
    set("y", 0);
    const spy = vi.fn();
    eff(() => {
      spy(get("x"));
    });
    spy.mockClear();
    set("x", 1);
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockClear();
    // y not tracked
    set("y", 1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("effect cleanup runs on re-execution", () => {
    expect.assertions(1);
    const { get, set, effect: eff } = createStore<{ n: number }>();
    set("n", 0);
    const order: string[] = [];
    eff(() => {
      const v = get("n");
      order.push(`run:${v}`);
      return () => {
        order.push(`cleanup:${v}`);
      };
    });
    set("n", 1);
    expect(order).toEqual(["run:0", "cleanup:0", "run:1"]);
  });

  it("effect disposal", () => {
    expect.assertions(1);
    const { get, set, effect: eff } = createStore<{ n: number }>();
    set("n", 0);
    const spy = vi.fn();
    const dispose = eff(() => {
      spy(get("n"));
    });
    spy.mockClear();
    dispose();
    set("n", 1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("computed updates output key", () => {
    expect.assertions(2);
    const { get, set, computed: comp } = createStore<{ a: number; b: number; sum: number }>();
    set("a", 1);
    set("b", 2);
    comp("sum", () => get("a") + get("b"));
    expect(get("sum")).toBe(3);
    set("a", 10);
    expect(get("sum")).toBe(12);
  });

  it("computed disposal stops updates", () => {
    expect.assertions(2);
    const { get, set, computed: comp } = createStore<{ x: number; out: number }>();
    set("x", 1);
    const dispose = comp("out", () => get("x") * 2);
    expect(get("out")).toBe(2);
    dispose();
    set("x", 5);
    expect(get("out")).toBe(2);
  });

  it("dynamic deps in effect", () => {
    expect.assertions(1);
    const { get, set, effect: eff } = createStore<{ cond: boolean; a: number; b: number }>();
    set("cond", true);
    set("a", 1);
    set("b", 2);
    const spy = vi.fn();
    eff(() => {
      spy(get("cond") ? get("a") : get("b"));
    });
    spy.mockClear();
    set("cond", false); // now tracks b, not a
    spy.mockClear();
    set("a", 99); // should NOT trigger
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reconcile (keyed-list)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// patch (tree-diff)
// ---------------------------------------------------------------------------

describe("patch", () => {
  it("patches text content", () => {
    expect.assertions(1);
    const parent = document.createElement("div");
    parent.appendChild(document.createTextNode("old"));
    patch(parent, "new");
    expect(parent.textContent).toBe("new");
  });

  it("patches attributes", () => {
    expect.assertions(2);
    const parent = document.createElement("div");
    const child = document.createElement("span");
    child.setAttribute("class", "a");
    parent.appendChild(child);
    const newChild = document.createElement("span");
    newChild.setAttribute("class", "b");
    patch(parent, newChild);
    expect(parent.children[0]!.getAttribute("class")).toBe("b");
    expect(parent.children.length).toBe(1);
  });

  it("adds and removes children", () => {
    expect.assertions(2);
    const parent = document.createElement("div");
    patch(parent, document.createElement("p"), document.createElement("p"));
    expect(parent.children.length).toBe(2);
    patch(parent, document.createElement("p"));
    expect(parent.children.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computed (derived signal)
// ---------------------------------------------------------------------------

describe("computed", () => {
  it("returns derived value", () => {
    expect.assertions(1);
    const a = signal(2);
    const b = signal(3);
    const sum = computed(() => a.value + b.value);
    expect(sum.value).toBe(5);
  });

  it("updates when dependency changes", () => {
    expect.assertions(2);
    const s = signal(1);
    const doubled = computed(() => s.value * 2);
    expect(doubled.value).toBe(2);
    s.value = 5;
    expect(doubled.value).toBe(10);
  });

  it("lazy evaluation (fn not called until .value read)", () => {
    expect.assertions(2);
    const spy = vi.fn(() => 42);
    const c = computed(spy);
    expect(spy).not.toHaveBeenCalled();
    expect(c.value).toBe(42);
  });

  it("caches value (fn not called on repeated reads)", () => {
    expect.assertions(2);
    const s = signal(1);
    const spy = vi.fn(() => s.value * 2);
    const c = computed(spy);
    void c.value;
    void c.value;
    void c.value;
    expect(spy).toHaveBeenCalledTimes(1);
    s.value = 2;
    void c.value;
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("works with effects (effect re-runs when computed changes)", () => {
    expect.assertions(2);
    const s = signal(1);
    const doubled = computed(() => s.value * 2);
    const spy = vi.fn();
    effect(() => {
      spy(doubled.value);
    });
    expect(spy).toHaveBeenCalledWith(2);
    s.value = 3;
    expect(spy).toHaveBeenCalledWith(6);
  });

  it("peek() returns value without tracking", () => {
    expect.assertions(2);
    const s = signal(10);
    const c = computed(() => s.value + 1);
    const spy = vi.fn();
    effect(() => {
      spy(c.peek());
    });
    expect(spy).toHaveBeenCalledWith(11);
    spy.mockClear();
    s.value = 20;
    // effect should NOT re-run because peek() doesn't track
    expect(spy).not.toHaveBeenCalled();
  });

  it("chains computed signals", () => {
    expect.assertions(1);
    const a = signal(1);
    const b = computed(() => a.value * 2);
    const c = computed(() => b.value + 10);
    expect(c.value).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// patchAttrs handler reconciliation (trackHandler)
// ---------------------------------------------------------------------------

describe("patchAttrs handler reconciliation", () => {
  it("removes stale handlers on patch", () => {
    expect.assertions(1);
    const parent = document.createElement("div");
    const oldEl = document.createElement("button");
    const handler = vi.fn();
    (oldEl as unknown as Record<string, unknown>)["onclick"] = handler;
    trackHandler(oldEl, "onclick");
    parent.appendChild(oldEl);

    const newEl = document.createElement("button");
    // no handler registered on newEl
    patch(parent, newEl);

    expect((parent.children[0] as unknown as Record<string, unknown>)["onclick"]).toBeNull();
  });

  it("copies new handlers on patch", () => {
    expect.assertions(1);
    const parent = document.createElement("div");
    const oldEl = document.createElement("button");
    parent.appendChild(oldEl);

    const newEl = document.createElement("button");
    const handler = vi.fn();
    (newEl as unknown as Record<string, unknown>)["onmouseover"] = handler;
    trackHandler(newEl, "onmouseover");

    patch(parent, newEl);

    expect((parent.children[0] as unknown as Record<string, unknown>)["onmouseover"]).toBe(
      handler,
    );
  });

  it("updates handler reference on patch", () => {
    expect.assertions(2);
    const parent = document.createElement("div");
    const oldEl = document.createElement("button");
    const oldHandler = vi.fn();
    (oldEl as unknown as Record<string, unknown>)["onclick"] = oldHandler;
    trackHandler(oldEl, "onclick");
    parent.appendChild(oldEl);

    const newEl = document.createElement("button");
    const newHandler = vi.fn();
    (newEl as unknown as Record<string, unknown>)["onclick"] = newHandler;
    trackHandler(newEl, "onclick");

    patch(parent, newEl);

    const result = (parent.children[0] as unknown as Record<string, unknown>)["onclick"];
    expect(result).toBe(newHandler);
    expect(result).not.toBe(oldHandler);
  });
});

// ---------------------------------------------------------------------------
// reconcile: extended tests (ported from vibekit/static-src/reconcile.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Computed: diamond problem / glitch-freedom (GZ-1)
// ---------------------------------------------------------------------------

describe("computed: diamond / glitch-freedom", () => {
  it("does not notify downstream when computed value is unchanged", () => {
    const a = signal(1);
    const isPositive = computed(() => a.value > 0);
    const spy = vi.fn();
    effect(() => { spy(isPositive.value); });
    spy.mockClear();
    a.value = 2; // still > 0, isPositive still true
    expect(spy).not.toHaveBeenCalled();
  });

  it("diamond graph: effect runs once per batch", () => {
    const src = signal(1);
    const left = computed(() => src.value * 2);
    const right = computed(() => src.value * 3);
    const combined = computed(() => left.value + right.value);
    const spy = vi.fn();
    effect(() => { spy(combined.value); });
    expect(spy).toHaveBeenCalledWith(5); // 2+3
    spy.mockClear();
    src.value = 2;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(10); // 4+6
  });

  it("diamond with batch: single effect execution", () => {
    const a = signal(0);
    const b = signal(0);
    const sum = computed(() => a.value + b.value);
    const spy = vi.fn();
    effect(() => { spy(sum.value); });
    spy.mockClear();
    batch(() => { a.value = 1; b.value = 1; });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// Computed: cycle detection (GZ-4)
// ---------------------------------------------------------------------------

describe("computed: cycle detection", () => {
  it("throws on self-referencing computed", () => {
    const c: ReadonlySignal<number> = computed(() => c.value + 1);
    expect(() => c.value).toThrow("Cycle detected");
  });

  it("throws on indirect cycle", () => {
    const a: ReadonlySignal<number> = computed(() => b.value + 1);
    const b: ReadonlySignal<number> = computed(() => a.value + 1);
    expect(() => a.value).toThrow("Cycle detected");
  });
});

// ---------------------------------------------------------------------------
// Computed: error caching (Gap #12)
// ---------------------------------------------------------------------------

describe("computed: error caching", () => {
  it("caches thrown error and rethrows on subsequent reads", () => {
    let count = 0;
    const c = computed(() => { count++; throw new Error("fail"); });
    expect(() => c.value).toThrow("fail");
    expect(() => c.value).toThrow("fail");
    expect(count).toBe(1); // fn only called once
  });

  it("recovers when deps change and fn succeeds", () => {
    const s = signal(0);
    const c = computed(() => {
      if (s.value === 0) {
        throw new Error("zero");
      }
      return s.value * 2;
    });
    expect(() => c.value).toThrow("zero");
    s.value = 5;
    expect(c.value).toBe(10);
  });

  it("error in computed propagates to effect via effectErrorHandler", () => {
    const s = signal(0);
    const c = computed(() => {
      if (s.value === 0) {
        throw new Error("boom");
      }
      return s.value;
    });
    const errors: unknown[] = [];
    const prev = setEffectErrorHandler((e) => { errors.push(e); });
    effect(() => { void c.value; });
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("boom");
    setEffectErrorHandler(prev);
  });
});

// ---------------------------------------------------------------------------
// Computed: setter throws (Gap #7)
// ---------------------------------------------------------------------------

describe("computed: setter throws", () => {
  it("throws when setting .value on computed", () => {
    const c = computed(() => 42);
    expect(() => { (c as { value: number }).value = 99; }).toThrow("Cannot set a computed signal");
  });
});

// ---------------------------------------------------------------------------
// untracked (Gap #1)
// ---------------------------------------------------------------------------

describe("untracked", () => {
  it("reads signal without subscribing", () => {
    const s = signal(1);
    const spy = vi.fn();
    effect(() => {
      spy(untracked(() => s.value));
    });
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockClear();
    s.value = 2;
    expect(spy).not.toHaveBeenCalled();
  });

  it("can be nested with tracked reads", () => {
    const a = signal(1);
    const b = signal(2);
    const spy = vi.fn();
    effect(() => {
      const av = a.value; // tracked
      const bv = untracked(() => b.value); // not tracked
      spy(av + bv);
    });
    spy.mockClear();
    b.value = 99;
    expect(spy).not.toHaveBeenCalled();
    a.value = 10;
    expect(spy).toHaveBeenCalledWith(109); // 10 + 99
  });
});

// ---------------------------------------------------------------------------
// subscribe utility (Gap #6)
// ---------------------------------------------------------------------------

describe("subscribe", () => {
  it("calls cb immediately with current value", () => {
    const s = signal(42);
    const spy = vi.fn();
    subscribe(s, spy);
    expect(spy).toHaveBeenCalledWith(42);
  });

  it("calls cb on subsequent changes", () => {
    const s = signal(0);
    const spy = vi.fn();
    subscribe(s, spy);
    spy.mockClear();
    s.value = 1;
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(1);
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("returns dispose function", () => {
    const s = signal(0);
    const spy = vi.fn();
    const dispose = subscribe(s, spy);
    spy.mockClear();
    dispose();
    s.value = 99;
    expect(spy).not.toHaveBeenCalled();
  });

  it("works with computed signals", () => {
    const s = signal(3);
    const c = computed(() => s.value * 2);
    const spy = vi.fn();
    subscribe(c, spy);
    expect(spy).toHaveBeenCalledWith(6);
    spy.mockClear();
    s.value = 5;
    expect(spy).toHaveBeenCalledWith(10);
  });
});

// ---------------------------------------------------------------------------
// isSignal / isComputed (Gap #15)
// ---------------------------------------------------------------------------

describe("isSignal / isComputed", () => {
  it("isSignal returns true for signals", () => {
    expect(isSignal(signal(1))).toBe(true);
  });

  it("isSignal returns false for computed", () => {
    expect(isSignal(computed(() => 1))).toBe(false);
  });

  it("isSignal returns false for plain objects", () => {
    expect(isSignal({ value: 1 })).toBe(false);
    expect(isSignal(null)).toBe(false);
    expect(isSignal(42)).toBe(false);
  });

  it("isComputed returns true for computed", () => {
    expect(isComputed(computed(() => 1))).toBe(true);
  });

  it("isComputed returns false for signals", () => {
    expect(isComputed(signal(1))).toBe(false);
  });

  it("isComputed returns false for plain objects", () => {
    expect(isComputed({ value: 1 })).toBe(false);
    expect(isComputed(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Store: Object.is equality (GZ-5)
// ---------------------------------------------------------------------------

describe("store: Object.is equality", () => {
  it("NaN does not trigger spurious notifications", () => {
    const { set, subscribe: sub } = createStore<{ x: number }>();
    set("x", NaN);
    const spy = vi.fn();
    sub("x", spy);
    set("x", NaN);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Custom equality comparator (signal + computed)
// ---------------------------------------------------------------------------

describe("custom equality comparator", () => {
  it("signal with custom equals suppresses notification", () => {
    const s = signal({ x: 1, y: 2 }, { equals: (a, b) => a.x === b.x });
    const spy = vi.fn();
    effect(() => { spy(s.value); });
    spy.mockClear();
    s.value = { x: 1, y: 99 }; // same x, different y — should NOT notify
    expect(spy).not.toHaveBeenCalled();
  });

  it("signal with custom equals allows notification when not equal", () => {
    const s = signal({ x: 1 }, { equals: (a, b) => a.x === b.x });
    const spy = vi.fn();
    effect(() => { spy(s.value.x); });
    spy.mockClear();
    s.value = { x: 2 };
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("signal with equals: false always notifies", () => {
    const s = signal(1, { equals: false });
    const spy = vi.fn();
    effect(() => { spy(s.value); });
    spy.mockClear();
    s.value = 1; // same value but equals:false → notify
    expect(spy).toHaveBeenCalledWith(1);
  });

  it("computed with custom equals suppresses downstream", () => {
    const s = signal(1);
    const c = computed(() => ({ val: s.value, rounded: Math.floor(s.value) }), {
      equals: (a, b) => a.rounded === b.rounded,
    });
    const spy = vi.fn();
    effect(() => { spy(c.value.rounded); });
    spy.mockClear();
    s.value = 1.5; // rounded still 1
    expect(spy).not.toHaveBeenCalled();
    s.value = 2.1; // rounded now 2
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("computed with equals: false always notifies", () => {
    const s = signal(1);
    const c = computed(() => s.value > 0, { equals: false });
    const spy = vi.fn();
    effect(() => { spy(c.value); });
    spy.mockClear();
    s.value = 2; // still true, but equals:false → notify
    expect(spy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// on() explicit dependency helper
// ---------------------------------------------------------------------------

describe("on", () => {
  it("tracks only explicit deps, not body reads", () => {
    const a = signal(1);
    const b = signal(10);
    const spy = vi.fn();
    effect(on(() => a.value, (v) => { spy(v, b.value); return undefined; }));
    expect(spy).toHaveBeenCalledWith(1, 10);
    spy.mockClear();
    b.value = 20; // not tracked
    expect(spy).not.toHaveBeenCalled();
    a.value = 2; // tracked
    expect(spy).toHaveBeenCalledWith(2, 20);
  });

  it("supports array of deps", () => {
    const a = signal(1);
    const b = signal(2);
    const spy = vi.fn();
    effect(on([() => a.value, () => b.value], (vals) => { spy(vals); return undefined; }));
    expect(spy).toHaveBeenCalledWith([1, 2]);
    spy.mockClear();
    a.value = 10;
    expect(spy).toHaveBeenCalledWith([10, 2]);
  });

  it("defer option skips first execution", () => {
    const a = signal(1);
    const spy = vi.fn();
    effect(on(() => a.value, (v) => { spy(v); return undefined; }, { defer: true }));
    expect(spy).not.toHaveBeenCalled();
    a.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("provides prev value and prev result", () => {
    const s = signal(1);
    const results: unknown[] = [];
    effect(on(() => s.value, (val, prev, prevResult) => {
      results.push({ val, prev, prevResult });
      return undefined;
    }));
    s.value = 2;
    s.value = 3;
    expect(results).toEqual([
      { val: 1, prev: undefined, prevResult: undefined },
      { val: 2, prev: 1, prevResult: undefined },
      { val: 3, prev: 2, prevResult: undefined },
    ]);
  });
});
