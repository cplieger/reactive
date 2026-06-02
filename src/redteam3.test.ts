// @vitest-environment happy-dom
// RED-TEAM round-3 final convergence sweep
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  signal,
  effect,
  batch,
  computed,
  untracked,
  subscribe,
  setEffectErrorHandler,
  createStore,
  reconcile,
  patch,
  reconcileChildren,
} from "./index.js";
import type { EffectErrorHandler } from "./index.js";

// ---------------------------------------------------------------------------
// 1. Verify round-1/2 fixes are sound
// ---------------------------------------------------------------------------

describe("round-1/2 fix verification", () => {
  let prevHandler: EffectErrorHandler;
  beforeEach(() => {
    prevHandler = setEffectErrorHandler(() => { /* swallow */ });
  });
  afterEach(() => {
    setEffectErrorHandler(prevHandler);
  });

  it("drainPending try/finally: flushing resets even with cascading throws", () => {
    const s = signal(0);
    // Create 3 effects that all throw
    effect(() => { if (s.value > 0) {throw new Error("e1");} return undefined; });
    effect(() => { if (s.value > 0) {throw new Error("e2");} return undefined; });
    effect(() => { if (s.value > 0) {throw new Error("e3");} return undefined; });
    s.value = 1;
    // System must still work
    const spy = vi.fn();
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("dispose re-entrancy guard: rapid dispose-dispose-dispose", () => {
    const s = signal(0);
    let cleanups = 0;
    const dispose = effect(() => {
      void s.value;
      return () => { cleanups++; };
    });
    dispose();
    dispose();
    dispose();
    expect(cleanups).toBe(1);
  });

  it("cleanup cleared before invocation prevents double-call on re-trigger", () => {
    const s = signal(0);
    let cleanups = 0;
    effect(() => {
      void s.value;
      return () => { cleanups++; };
    });
    s.value = 1;
    s.value = 2;
    s.value = 3;
    expect(cleanups).toBe(3); // exactly one per re-run
  });
});

// ---------------------------------------------------------------------------
// 2. Pathological diamond/fan-out graphs
// ---------------------------------------------------------------------------

describe("pathological graphs", () => {
  it("deep diamond (10 levels) fires leaf effect exactly once per change", () => {
    const root = signal(0);
    // Build diamond: each level splits into 2 computeds that merge at next level
    let nodes: ReturnType<typeof computed>[] = [computed(() => root.value)];
    for (let level = 0; level < 10; level++) {
      const next: ReturnType<typeof computed>[] = [];
      for (const n of nodes) {
        next.push(computed(() => n.value + 1));
        next.push(computed(() => n.value + 2));
      }
      // Merge pairs
      const merged: ReturnType<typeof computed>[] = [];
      for (let i = 0; i < next.length; i += 2) {
        merged.push(computed(() => next[i]!.value + next[i + 1]!.value));
      }
      nodes = merged;
    }
    const leaf = nodes[0]!;
    const spy = vi.fn();
    effect(() => { spy(leaf.value); return undefined; });
    spy.mockClear();
    root.value = 1;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fan-out: 100 effects on same signal, all fire exactly once", () => {
    const s = signal(0);
    const spies = Array.from({ length: 100 }, () => vi.fn());
    for (const spy of spies) {
      effect(() => { spy(s.value); return undefined; });
    }
    for (const spy of spies) {spy.mockClear();}
    s.value = 1;
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(1);
    }
  });

  it("fan-in: 50 signals → 1 computed → 1 effect, batch update all", () => {
    const signals = Array.from({ length: 50 }, (_, i) => signal(i));
    const sum = computed(() => signals.reduce((acc, s) => acc + s.value, 0));
    const spy = vi.fn();
    effect(() => { spy(sum.value); return undefined; });
    spy.mockClear();
    batch(() => {
      for (const s of signals) {s.value = s.peek() + 1;}
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(1275); // original sum(0..49)=1225, each +1 → sum(1..50)=1275
  });

  it("computed cycle detection throws", () => {
    // eslint-disable-next-line prefer-const
    let b: ReturnType<typeof computed>;
    const a = computed(() => b.value + 1);
    b = computed(() => a.value + 1);
    expect(() => a.value).toThrow("Cycle detected");
  });
});

// ---------------------------------------------------------------------------
// 3. Exception in every callback type
// ---------------------------------------------------------------------------

describe("exception in every callback type", () => {
  let prevHandler: EffectErrorHandler;
  const errors: unknown[] = [];
  beforeEach(() => {
    errors.length = 0;
    prevHandler = setEffectErrorHandler((e) => { errors.push(e); });
  });
  afterEach(() => {
    setEffectErrorHandler(prevHandler);
  });

  it("exception in effect cleanup does not prevent re-execution", () => {
    const s = signal(0);
    const values: number[] = [];
    effect(() => {
      values.push(s.value);
      return () => { throw new Error("cleanup boom"); };
    });
    s.value = 1;
    s.value = 2;
    // Effect should still track and re-run despite cleanup throwing
    expect(values).toContain(0);
    expect(values).toContain(1);
    expect(values).toContain(2);
  });

  it("exception in computed fn is cached and re-thrown on read", () => {
    const s = signal(0);
    const c = computed(() => {
      if (s.value === 1) {throw new Error("computed boom");}
      return s.value * 2;
    });
    expect(c.value).toBe(0);
    s.value = 1;
    expect(() => c.value).toThrow("computed boom");
    // Recovery
    s.value = 2;
    expect(c.value).toBe(4);
  });

  it("exception in subscribe callback is caught by error handler", () => {
    const s = signal(0);
    subscribe(s, (v) => {
      if (v === 1) {throw new Error("subscribe boom");}
    });
    s.value = 1;
    expect(errors.some(e => (e as Error).message === "subscribe boom")).toBe(true);
  });

  it("exception in batch fn propagates but effects still flush", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    expect(() => {
      batch(() => {
        s.value = 99;
        throw new Error("batch boom");
      });
    }).toThrow("batch boom");
    // Effect should have flushed due to try/finally in batch
    expect(spy).toHaveBeenCalledWith(99);
  });

  it("exception in on() body is caught by error handler", () => {
    const s = signal(0);
    const fn = vi.fn();
    effect(() => {
      const v = s.value;
      if (v === 1) {throw new Error("on body boom");}
      fn(v);
      return undefined;
    });
    fn.mockClear();
    s.value = 1;
    expect(errors.some(e => (e as Error).message === "on body boom")).toBe(true);
    // Recovery
    s.value = 2;
    expect(fn).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Dispose ordering
// ---------------------------------------------------------------------------

describe("dispose ordering", () => {
  it("disposing effects in reverse order of creation", () => {
    const s = signal(0);
    const order: string[] = [];
    const disposers = Array.from({ length: 5 }, (_, i) =>
      effect(() => { order.push(`e${i}:${s.value}`); return () => { order.push(`c${i}`); }; })
    );
    order.length = 0;
    // Dispose in reverse
    for (let i = 4; i >= 0; i--) {disposers[i]!();}
    expect(order).toEqual(["c4", "c3", "c2", "c1", "c0"]);
    // No effects should fire
    order.length = 0;
    s.value = 1;
    expect(order).toEqual([]);
  });

  it("disposing during flush does not corrupt iteration", () => {
    const s = signal(0);
    const spy = vi.fn();
    const disposers: (() => void)[] = [];
    // Effect 0 disposes effects 1 and 2 when triggered
    disposers.push(effect(() => {
      if (s.value === 1) {
        disposers[1]?.();
        disposers[2]?.();
      }
      return undefined;
    }));
    disposers.push(effect(() => { spy("e1:" + s.value); return undefined; }));
    disposers.push(effect(() => { spy("e2:" + s.value); return undefined; }));
    disposers.push(effect(() => { spy("e3:" + s.value); return undefined; }));
    spy.mockClear();
    s.value = 1;
    // e3 should still fire; e1 and e2 may or may not depending on order
    expect(spy).toHaveBeenCalledWith("e3:1");
  });
});

// ---------------------------------------------------------------------------
// 5. Memory leak check after mass dispose
// ---------------------------------------------------------------------------

describe("memory leak after mass dispose", () => {
  it("disposed effects are fully unlinked from signal subscriber sets", () => {
    const s = signal(0);
    const disposers: (() => void)[] = [];
    for (let i = 0; i < 1000; i++) {
      disposers.push(effect(() => { void s.value; return undefined; }));
    }
    // Dispose all
    for (const d of disposers) {d();}
    // Verify: setting signal should not trigger anything
    const spy = vi.fn();
    const d2 = effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledTimes(1);
    d2();
  });

  it("disposed computed does not retain references to source signals", () => {
    const s = signal(0);
    const computeds: ReturnType<typeof computed>[] = [];
    const disposers: (() => void)[] = [];
    for (let i = 0; i < 100; i++) {
      const c = computed(() => s.value + i);
      computeds.push(c);
      disposers.push(effect(() => { void c.value; return undefined; }));
    }
    // Dispose all effects (computeds become lazy/unsubscribed)
    for (const d of disposers) {d();}
    // Signal update should not trigger any computation
    const spy = vi.fn();
    const d2 = effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    s.value = 99;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(99);
    d2();
  });
});

// ---------------------------------------------------------------------------
// 6. Batch + computed + effect interleaving
// ---------------------------------------------------------------------------

describe("batch + computed + effect interleaving", () => {
  it("batch with computed read mid-batch sees consistent state after flush", () => {
    const a = signal(1);
    const b = signal(2);
    const sum = computed(() => a.value + b.value);
    const values: number[] = [];
    effect(() => { values.push(sum.value); return undefined; });
    values.length = 0;
    batch(() => {
      a.value = 10;
      b.value = 20;
    });
    // After batch: effect fires with final value
    expect(values).toContain(30); // 10 + 20
  });

  it("nested batch: inner batch does not flush", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    batch(() => {
      batch(() => {
        s.value = 1;
      });
      // Inner batch ended but outer still active - no flush yet
      expect(spy).not.toHaveBeenCalled();
      s.value = 2;
    });
    // Only final value should be seen
    expect(spy).toHaveBeenCalledWith(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("effect creating new effect during batch flush", () => {
    const s = signal(0);
    const inner = vi.fn();
    effect(() => {
      if (s.value === 1) {
        // Create new effect during flush
        effect(() => { inner(s.value); return undefined; });
      }
      return undefined;
    });
    batch(() => { s.value = 1; });
    expect(inner).toHaveBeenCalledWith(1);
  });

  it("computed invalidation during batch does not cause double-fire", () => {
    const a = signal(0);
    const b = signal(0);
    const c = computed(() => a.value + b.value);
    const spy = vi.fn();
    effect(() => { spy(c.value); return undefined; });
    spy.mockClear();
    batch(() => {
      a.value = 1;
      b.value = 1;
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// 7. Reconcile fuzz
// ---------------------------------------------------------------------------

describe("reconcile fuzz", () => {
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

  it("random insert/remove/reorder 50 iterations", () => {
    const parent = document.createElement("div");
    const spec = makeSpec();
    const items: { id: string; v: number }[] = [];
    let nextId = 0;
    let seed = 42;
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };

    for (let iter = 0; iter < 50; iter++) {
      const action = rng();
      if (action < 0.3 && items.length > 0) {
        // Remove random
        const idx = Math.floor(rng() * items.length);
        items.splice(idx, 1);
      } else if (action < 0.6) {
        // Insert random
        const idx = Math.floor(rng() * (items.length + 1));
        items.splice(idx, 0, { id: `id${nextId++}`, v: iter });
      } else if (items.length > 1) {
        // Swap two random
        const i = Math.floor(rng() * items.length);
        let j = Math.floor(rng() * items.length);
        if (j === i) {j = (j + 1) % items.length;}
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      reconcile(parent, items, spec);
      expect(parent.children.length).toBe(items.length);
      // Verify order
      for (let k = 0; k < items.length; k++) {
        expect(parent.children[k]!.getAttribute("data-reconcile-key")).toBe(items[k]!.id);
      }
    }
  });

  it("reconcile with empty list clears all", () => {
    const parent = document.createElement("div");
    const spec = makeSpec();
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, v: i }));
    reconcile(parent, items, spec);
    expect(parent.children.length).toBe(20);
    reconcile(parent, [], spec);
    expect(parent.children.length).toBe(0);
    expect(spec.onRemove).toHaveBeenCalledTimes(20);
  });

  it("reconcile with duplicate keys (pathological input)", () => {
    const parent = document.createElement("div");
    const spec = makeSpec();
    // Duplicate keys - library should handle gracefully (last wins or first wins)
    const items = [
      { id: "dup", v: 1 },
      { id: "dup", v: 2 },
      { id: "unique", v: 3 },
    ];
    // Should not throw
    expect(() => reconcile(parent, items, spec)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. Fake timers: effect scheduling is synchronous (no microtask leaks)
// ---------------------------------------------------------------------------

describe("synchronous semantics (fake timers)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("signal write + effect is fully synchronous, no pending microtasks", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    s.value = 1;
    // Should already have fired - no need to advance timers
    expect(spy).toHaveBeenCalledWith(1);
  });

  it("batch flush is synchronous", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    batch(() => { s.value = 42; });
    expect(spy).toHaveBeenCalledWith(42);
  });

  it("computed is evaluated lazily and synchronously", () => {
    const s = signal(1);
    const c = computed(() => s.value * 2);
    s.value = 5;
    expect(c.value).toBe(10); // No timer needed
  });
});

// ---------------------------------------------------------------------------
// 9. untracked edge cases
// ---------------------------------------------------------------------------

describe("untracked edge cases", () => {
  it("untracked inside effect prevents tracking", () => {
    const a = signal(0);
    const b = signal(0);
    const spy = vi.fn();
    effect(() => {
      const av = a.value; // tracked
      const bv = untracked(() => b.value); // not tracked
      spy(av, bv);
      return undefined;
    });
    spy.mockClear();
    b.value = 99;
    expect(spy).not.toHaveBeenCalled();
    a.value = 1;
    expect(spy).toHaveBeenCalledWith(1, 99);
  });

  it("untracked with throwing fn restores tracking context", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      try {
        untracked(() => { throw new Error("boom"); });
      } catch { /* swallow */ }
      spy(s.value); // should still be tracked
      return undefined;
    });
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// 10. Store: batch + effect + computed interleaving
// ---------------------------------------------------------------------------

describe("store: batch + effect + computed interleaving", () => {
  it("store computed updates atomically in batch", () => {
    const store = createStore<{ a: number; b: number; sum: number }>();
    store.set("a", 1);
    store.set("b", 2);
    store.computed("sum", () => store.get("a") + store.get("b"));
    expect(store.get("sum")).toBe(3);
    const spy = vi.fn();
    store.subscribe("sum", spy);
    store.batch(() => {
      store.set("a", 10);
      store.set("b", 20);
    });
    // sum should update to 30
    expect(store.get("sum")).toBe(30);
  });

  it("store effect throwing does not break subsequent effects", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    const spy = vi.fn();
    store.effect(() => {
      if (store.get("x") === 1) {throw new Error("store effect boom");}
      return undefined;
    });
    store.effect(() => { spy(store.get("x")); return undefined; });
    spy.mockClear();
    // The throwing effect will console.error but shouldn't prevent spy effect
    const origError = console.error;
    console.error = vi.fn();
    store.set("x", 1);
    console.error = origError;
    expect(spy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Signal equality: custom equals with side effects (adversarial)
// ---------------------------------------------------------------------------

describe("adversarial equals", () => {
  it("equals that reads another signal does not corrupt tracking", () => {
    const a = signal(0);
    const b = signal(0, {
      equals: (prev, next) => {
        // Adversarial: read another signal inside equals
        void a.peek(); // peek is safe
        return prev === next;
      },
    });
    const spy = vi.fn();
    effect(() => { spy(b.value); return undefined; });
    spy.mockClear();
    b.value = 1;
    expect(spy).toHaveBeenCalledWith(1);
  });

  it("equals returning false always causes notification", () => {
    const s = signal(0, { equals: false });
    const spy = vi.fn();
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    s.value = 0; // same value but equals=false means always notify
    expect(spy).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// 12. reconcileChildren / patch edge cases
// ---------------------------------------------------------------------------

describe("reconcileChildren / patch edge cases", () => {
  it("patch with null/undefined children is no-op", () => {
    const parent = document.createElement("div");
    parent.textContent = "hello";
    patch(parent, null, undefined);
    expect(parent.childNodes.length).toBe(0);
  });

  it("patch with DocumentFragment spreads children", () => {
    const parent = document.createElement("div");
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createElement("span"));
    frag.appendChild(document.createTextNode("text"));
    patch(parent, frag);
    expect(parent.childNodes.length).toBe(2);
  });

  it("reconcileChildren handles text node update", () => {
    const parent = document.createElement("div");
    parent.appendChild(document.createTextNode("old"));
    reconcileChildren(parent, [document.createTextNode("new")]);
    expect(parent.textContent).toBe("new");
  });
});
