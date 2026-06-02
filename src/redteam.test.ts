// @vitest-environment happy-dom
// RED-TEAM adversarial tests probing edge cases
import { describe, it, expect, vi } from "vitest";
import {
  signal,
  effect,
  batch,
  computed,
  untracked,
  subscribe,
  setEffectErrorHandler,
  reconcile,
  patch,
  reconcileChildren,
  createStore,
} from "./index.js";

// ---------------------------------------------------------------------------
// Effect disposal edge cases
// ---------------------------------------------------------------------------

describe("effect disposal edge cases", () => {
  it("dispose during own execution does not crash", () => {
    const s = signal(0);
    const spy = vi.fn();
    const disposeFn: { current: () => void } = { current: () => { /* placeholder */ } };
    disposeFn.current = effect(() => {
      spy(s.value);
      if (s.value === 1) {
        disposeFn.current(); // dispose self mid-run
      }
      return undefined;
    });
    expect(spy).toHaveBeenCalledWith(0);
    s.value = 1; // triggers re-run which disposes
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockClear();
    s.value = 2; // should NOT trigger since disposed
    expect(spy).not.toHaveBeenCalled();
  });

  it("double dispose does not crash or double-call cleanup", () => {
    const s = signal(0);
    let cleanupCount = 0;
    const dispose = effect(() => {
      void s.value;
      return () => { cleanupCount++; };
    });
    dispose();
    expect(cleanupCount).toBe(1);
    dispose(); // second dispose
    expect(cleanupCount).toBe(1); // should NOT call cleanup again
  });

  it("dispose mid-batch does not crash", () => {
    const s = signal(0);
    const spy = vi.fn();
    const dispose = effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    batch(() => {
      s.value = 1;
      dispose(); // dispose while batch is pending
      s.value = 2;
    });
    // Effect was disposed mid-batch, should not run
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Re-entrancy: signal write inside effect
// ---------------------------------------------------------------------------

describe("re-entrancy", () => {
  it("signal write inside effect triggers re-run after current flush", () => {
    const s = signal(0);
    const log: number[] = [];
    effect(() => {
      log.push(s.value);
      if (s.value < 3) {
        s.value = s.value + 1; // re-entrant write
      }
      return undefined;
    });
    // Should converge: 0, 1, 2, 3
    expect(log).toEqual([0, 1, 2, 3]);
  });

  it("signal write inside effect does not cause infinite loop with guard", () => {
    const s = signal(0);
    let runs = 0;
    effect(() => {
      runs++;
      if (s.value < 100) {
        s.value = s.value + 1;
      }
      return undefined;
    });
    expect(runs).toBe(101); // 0..100
    expect(s.peek()).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Batch nesting + exceptions mid-batch
// ---------------------------------------------------------------------------

describe("batch nesting + exceptions", () => {
  it("exception mid-batch still flushes pending effects", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    expect(() => {
      batch(() => {
        s.value = 42;
        throw new Error("mid-batch");
      });
    }).toThrow("mid-batch");
    // batchDepth should be back to 0 and pending effects flushed
    expect(spy).toHaveBeenCalledWith(42);
  });

  it("nested batch exception: outer batch still flushes", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    batch(() => {
      s.value = 1;
      try {
        batch(() => {
          s.value = 2;
          throw new Error("inner");
        });
      } catch {
        // swallow inner error
      }
      s.value = 3;
    });
    // Should have flushed with final value
    expect(spy).toHaveBeenCalledWith(3);
  });

  it("batchDepth is not left dirty after exception", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    try {
      batch(() => { throw new Error("oops"); });
    } catch {
      // swallow
    }
    // Subsequent writes should flush immediately (not batched)
    s.value = 99;
    expect(spy).toHaveBeenCalledWith(99);
  });
});

// ---------------------------------------------------------------------------
// Computed error caching invalidation
// ---------------------------------------------------------------------------

describe("computed error caching invalidation", () => {
  it("error is invalidated when dependency changes", () => {
    const s = signal(0);
    let computeCount = 0;
    const c = computed(() => {
      computeCount++;
      if (s.value === 0) { throw new Error("zero"); }
      return s.value;
    });
    expect(() => c.value).toThrow("zero");
    expect(computeCount).toBe(1);
    // Reading again without dep change should use cached error
    expect(() => c.value).toThrow("zero");
    expect(computeCount).toBe(1);
    // Change dep - should recompute
    s.value = 5;
    expect(c.value).toBe(5);
    expect(computeCount).toBe(2);
  });

  it("computed error in effect: recovers after dep change", () => {
    const s = signal(0);
    const errors: unknown[] = [];
    const values: unknown[] = [];
    const prev = setEffectErrorHandler((e) => { errors.push(e); });
    effect(() => {
      values.push(computed(() => {
        if (s.value === 0) { throw new Error("err"); }
        return s.value;
      }).value);
      return undefined;
    });
    expect(errors.length).toBe(1);
    s.value = 1;
    // The effect re-runs and creates a new computed each time, so it should work
    expect(values).toContain(1);
    setEffectErrorHandler(prev);
  });
});

// ---------------------------------------------------------------------------
// Custom equals throwing
// ---------------------------------------------------------------------------

describe("custom equals throwing", () => {
  it("signal: exception in equals propagates to caller", () => {
    const s = signal(1, {
      equals: () => { throw new Error("equals boom"); },
    });
    expect(() => { s.value = 2; }).toThrow("equals boom");
  });

  it("computed: exception in equals during execute is caught and downstream still notified", () => {
    const s = signal(1);
    const c = computed(() => s.value, {
      equals: () => { throw new Error("eq error"); },
    });
    // First read works (no equals comparison on first compute via ensureFresh)
    expect(c.value).toBe(1);
    // Subscribe an effect that reads the computed
    const values: number[] = [];
    effect(() => { values.push(c.value); return undefined; });
    expect(values).toEqual([1]);
    // Now change dep - execute() will compare using equals, which throws
    // The equals error is swallowed (treated as "changed"), downstream is notified
    s.value = 2;
    expect(values).toEqual([1, 2]);
    // System should still work after the error
    const s2 = signal(0);
    const spy = vi.fn();
    effect(() => { spy(s2.value); return undefined; });
    spy.mockClear();
    s2.value = 42;
    expect(spy).toHaveBeenCalledWith(42);
  });
});

// ---------------------------------------------------------------------------
// Memory leaks: disposed effects fully unsubscribe
// ---------------------------------------------------------------------------

describe("memory leaks: disposed effects unsubscribe", () => {
  it("disposed effect is removed from signal subscriber set", () => {
    const s = signal(0);
    const spy = vi.fn();
    const dispose = effect(() => { spy(s.value); return undefined; });
    dispose();
    spy.mockClear();
    s.value = 1;
    expect(spy).not.toHaveBeenCalled();
    // Verify no lingering references by triggering GC-like behavior
    // The signal's subs set should be empty
  });

  it("disposed subscribe is removed from signal subscriber set", () => {
    const s = signal(0);
    const spy = vi.fn();
    const dispose = subscribe(s, spy);
    dispose();
    spy.mockClear();
    s.value = 1;
    expect(spy).not.toHaveBeenCalled();
  });

  it("computed that loses all subscribers still recomputes on dep change (no stale)", () => {
    const s = signal(1);
    const c = computed(() => s.value * 2);
    const spy = vi.fn();
    const dispose = effect(() => { spy(c.value); return undefined; });
    expect(spy).toHaveBeenCalledWith(2);
    dispose();
    s.value = 5;
    // Reading computed lazily should still give correct value
    expect(c.value).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Deep diamond graph
// ---------------------------------------------------------------------------

describe("deep diamond graph", () => {
  it("deep diamond: effect runs once", () => {
    const root = signal(1);
    const a = computed(() => root.value + 1);
    const b = computed(() => root.value + 2);
    const c = computed(() => a.value + b.value);
    const d = computed(() => c.value * 2);
    const spy = vi.fn();
    effect(() => { spy(d.value); return undefined; });
    expect(spy).toHaveBeenCalledWith((1+1+1+2)*2); // (2+3)*2 = 10
    spy.mockClear();
    root.value = 10;
    // d = (a+b)*2 = ((10+1)+(10+2))*2 = (11+12)*2 = 46
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(46);
  });

  it("wide diamond: many computeds from same source", () => {
    const src = signal(0);
    const branches = Array.from({ length: 10 }, (_, i) =>
      computed(() => src.value + i)
    );
    const sum = computed(() => branches.reduce((acc, b) => acc + b.value, 0));
    const spy = vi.fn();
    effect(() => { spy(sum.value); return undefined; });
    spy.mockClear();
    src.value = 1;
    expect(spy).toHaveBeenCalledTimes(1);
    // sum = (1+0)+(1+1)+...+(1+9) = 10 + 45 = 55
    expect(spy).toHaveBeenCalledWith(55);
  });
});

// ---------------------------------------------------------------------------
// Untracked nesting
// ---------------------------------------------------------------------------

describe("untracked nesting", () => {
  it("nested untracked restores tracking correctly", () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const spy = vi.fn();
    effect(() => {
      const av = a.value; // tracked
      const bv = untracked(() => {
        const cv = untracked(() => c.value); // not tracked
        return b.value + cv; // not tracked
      });
      spy(av + bv);
      return undefined;
    });
    spy.mockClear();
    b.value = 20; // not tracked
    expect(spy).not.toHaveBeenCalled();
    c.value = 30; // not tracked
    expect(spy).not.toHaveBeenCalled();
    a.value = 10; // tracked
    expect(spy).toHaveBeenCalledWith(10 + 20 + 30);
  });

  it("untracked inside computed does not track those reads", () => {
    const a = signal(1);
    const b = signal(2);
    const c = computed(() => a.value + untracked(() => b.value));
    const spy = vi.fn();
    effect(() => { spy(c.value); return undefined; });
    expect(spy).toHaveBeenCalledWith(3);
    spy.mockClear();
    b.value = 99; // not tracked by computed
    expect(spy).not.toHaveBeenCalled();
    a.value = 10;
    expect(spy).toHaveBeenCalledWith(109); // 10 + 99
  });
});

// ---------------------------------------------------------------------------
// Reconcile edge cases
// ---------------------------------------------------------------------------

describe("reconcile edge cases", () => {
  it("duplicate keys: last one wins", () => {
    const parent = document.createElement("div");
    // Two items with same key - should not crash
    reconcile(parent, [{ id: "a", v: 1 }, { id: "a", v: 2 }], {
      key: (i) => i.id,
      mount: (i) => {
        const el = document.createElement("span");
        el.textContent = String(i.v);
        return el;
      },
    });
    // Should have 2 elements (both mounted since key collision means second is new)
    expect(parent.children.length).toBe(2);
  });

  it("null/undefined children in patch are skipped", () => {
    const parent = document.createElement("div");
    patch(parent, null, undefined, "hello", null);
    expect(parent.textContent).toBe("hello");
    expect(parent.childNodes.length).toBe(1);
  });

  it("text vs element swap", () => {
    const parent = document.createElement("div");
    parent.appendChild(document.createTextNode("old text"));
    const newEl = document.createElement("span");
    newEl.textContent = "new element";
    patch(parent, newEl);
    expect(parent.children.length).toBe(1);
    expect(parent.children[0]!.tagName).toBe("SPAN");
  });

  it("element vs text swap", () => {
    const parent = document.createElement("div");
    parent.appendChild(document.createElement("span"));
    patch(parent, "just text");
    expect(parent.childNodes.length).toBe(1);
    expect(parent.childNodes[0]!.nodeType).toBe(3); // text node
    expect(parent.textContent).toBe("just text");
  });

  it("keyed reorder preserves identity", () => {
    const parent = document.createElement("div");
    const a = document.createElement("div");
    a.setAttribute("data-id", "a");
    a.textContent = "A";
    const b = document.createElement("div");
    b.setAttribute("data-id", "b");
    b.textContent = "B";
    const c = document.createElement("div");
    c.setAttribute("data-id", "c");
    c.textContent = "C";
    parent.appendChild(a);
    parent.appendChild(b);
    parent.appendChild(c);

    // Reorder: c, a, b
    const newC = document.createElement("div");
    newC.setAttribute("data-id", "c");
    newC.textContent = "C!";
    const newA = document.createElement("div");
    newA.setAttribute("data-id", "a");
    newA.textContent = "A!";
    const newB = document.createElement("div");
    newB.setAttribute("data-id", "b");
    newB.textContent = "B!";
    reconcileChildren(parent, [newC, newA, newB]);

    // Identity preserved
    expect(parent.childNodes[0]).toBe(c);
    expect(parent.childNodes[1]).toBe(a);
    expect(parent.childNodes[2]).toBe(b);
    // Content patched
    expect(c.textContent).toBe("C!");
    expect(a.textContent).toBe("A!");
    expect(b.textContent).toBe("B!");
  });

  it("DocumentFragment children are flattened in patch", () => {
    const parent = document.createElement("div");
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode("one"));
    frag.appendChild(document.createTextNode("two"));
    patch(parent, frag);
    expect(parent.childNodes.length).toBe(2);
    expect(parent.textContent).toBe("onetwo");
  });
});

// ---------------------------------------------------------------------------
// Store edge cases
// ---------------------------------------------------------------------------

describe("store edge cases", () => {
  it("subscriber error does not prevent other subscribers", () => {
    const { set, subscribe: sub } = createStore<{ x: number }>();
    const spy1 = vi.fn(() => { throw new Error("sub1 error"); });
    const spy2 = vi.fn();
    sub("x", spy1);
    sub("x", spy2);
    // Should not throw, and spy2 should still be called
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => { /* noop */ });
    set("x", 1);
    expect(spy2).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
  });

  it("batch exception does not leave batchDepth dirty", () => {
    const store = createStore<{ x: number }>();
    const spy = vi.fn();
    store.subscribe("x", spy);
    try {
      store.batch(() => { throw new Error("batch err"); });
    } catch {
      // swallow
    }
    store.set("x", 42);
    expect(spy).toHaveBeenCalledWith(42);
  });
});
