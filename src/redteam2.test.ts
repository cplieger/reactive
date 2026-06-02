// @vitest-environment happy-dom
// RED-TEAM round-2 adversarial tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  signal,
  effect,
  batch,
  computed,
  on,
  setEffectErrorHandler,
  flushSync,
  createStore,
  reconcile,
} from "./index.js";
import type { EffectErrorHandler } from "./index.js";

// ---------------------------------------------------------------------------
// Verify round-1 fixes: drainPending try/finally + equals-throw
// ---------------------------------------------------------------------------

describe("round-1 fix verification: drainPending invariants", () => {
  let prevHandler: EffectErrorHandler;
  beforeEach(() => {
    prevHandler = setEffectErrorHandler(() => {
      /* swallow */
    });
  });
  afterEach(() => {
    setEffectErrorHandler(prevHandler);
  });

  it("flushing flag resets after effect throws", () => {
    const s = signal(0);
    let threw = false;
    effect(() => {
      if (s.value === 1 && !threw) {
        threw = true;
        throw new Error("effect boom");
      }
      return undefined;
    });
    s.value = 1; // triggers throw inside drainPending
    // System should still work - flushing must be false
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("batchDepth resets after nested batch throws at each level", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();

    // Nested throws at each level
    try {
      batch(() => {
        s.value = 1;
        try {
          batch(() => {
            s.value = 2;
            try {
              batch(() => {
                s.value = 3;
                throw new Error("level 3");
              });
            } catch {
              /* swallow */
            }
            throw new Error("level 2");
          });
        } catch {
          /* swallow */
        }
        throw new Error("level 1");
      });
    } catch {
      /* swallow */
    }

    // batchDepth must be 0 - subsequent writes flush immediately
    spy.mockClear();
    s.value = 99;
    expect(spy).toHaveBeenCalledWith(99);
  });

  it("equals-throw in signal does not corrupt flushing state", () => {
    const s = signal(1, {
      equals: (_prev, next) => {
        if (next === 42) {
          throw new Error("equals boom");
        }
        return false; // always notify
      },
    });
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();

    expect(() => {
      s.value = 42;
    }).toThrow("equals boom");

    // System should still work
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// Exception in effect body (not equals)
// ---------------------------------------------------------------------------

describe("exception in effect body", () => {
  let prevHandler: EffectErrorHandler;
  const errors: unknown[] = [];
  beforeEach(() => {
    errors.length = 0;
    prevHandler = setEffectErrorHandler((e) => {
      errors.push(e);
    });
  });
  afterEach(() => {
    setEffectErrorHandler(prevHandler);
  });

  it("effect error does not prevent other pending effects from running", () => {
    const s = signal(0);
    const spy1 = vi.fn();
    const spy2 = vi.fn();

    // Effect 1 throws
    effect(() => {
      if (s.value === 1) {
        throw new Error("e1 boom");
      }
      spy1(s.value);
      return undefined;
    });
    // Effect 2 should still run
    effect(() => {
      spy2(s.value);
      return undefined;
    });

    spy1.mockClear();
    spy2.mockClear();
    s.value = 1;
    expect(spy2).toHaveBeenCalledWith(1);
    expect(errors.length).toBe(1);
  });

  it("effect error during batch does not prevent flush of remaining effects", () => {
    const a = signal(0);
    const b = signal(0);
    const spy = vi.fn();

    effect(() => {
      if (a.value === 1) {
        throw new Error("a boom");
      }
      return undefined;
    });
    effect(() => {
      spy(b.value);
      return undefined;
    });

    spy.mockClear();
    batch(() => {
      a.value = 1;
      b.value = 1;
    });
    expect(spy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Effect that writes the signal it reads (self-trigger loop bound)
// ---------------------------------------------------------------------------

describe("self-trigger loop bound", () => {
  it("effect writing its own signal converges (bounded iterations)", () => {
    const s = signal(0);
    let runs = 0;
    effect(() => {
      runs++;
      if (s.value < 100) {
        s.value = s.value + 1;
      }
      return undefined;
    });
    // Should converge at 100, not infinite loop
    expect(runs).toBe(101);
    expect(s.peek()).toBe(100);
  });

  it("effect writing its own signal in batch converges", () => {
    const s = signal(0);
    let runs = 0;
    effect(() => {
      runs++;
      const v = s.value;
      if (v < 50) {
        batch(() => {
          s.value = v + 1;
        });
      }
      return undefined;
    });
    expect(runs).toBe(51);
    expect(s.peek()).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Computed depending on computed depending on signal with throwing equals
// ---------------------------------------------------------------------------

describe("computed chain with throwing equals", () => {
  it("computed → computed → signal, inner equals throws", () => {
    const s = signal(1);
    let throwOnEquals = false;
    const inner = computed(() => s.value * 2, {
      equals: () => {
        if (throwOnEquals) {
          throw new Error("inner eq boom");
        }
        return false; // always changed
      },
    });
    const outer = computed(() => inner.value + 10);
    const spy = vi.fn();
    effect(() => {
      spy(outer.value);
      return undefined;
    });
    expect(spy).toHaveBeenCalledWith(12); // 1*2+10

    spy.mockClear();
    throwOnEquals = true;
    s.value = 2;
    // inner.execute() catches the equals throw and treats as changed
    // outer should still update
    expect(spy).toHaveBeenCalledWith(14); // 2*2+10
  });

  it("deeply chained computeds with middle one throwing equals", () => {
    const s = signal(1);
    const c1 = computed(() => s.value);
    const c2 = computed(() => c1.value * 2, {
      equals: () => {
        throw new Error("c2 eq");
      },
    });
    const c3 = computed(() => c2.value + 100);
    const spy = vi.fn();
    effect(() => {
      spy(c3.value);
      return undefined;
    });
    expect(spy).toHaveBeenCalledWith(102); // 1*2+100

    spy.mockClear();
    s.value = 5;
    expect(spy).toHaveBeenCalledWith(110); // 5*2+100
  });
});

// ---------------------------------------------------------------------------
// dispose() called from inside another effect
// ---------------------------------------------------------------------------

describe("dispose from inside another effect", () => {
  it("disposing effect B from inside effect A does not crash", () => {
    const s = signal(0);
    const spyB = vi.fn();
    const disposeB = effect(() => {
      spyB(s.value);
      return undefined;
    });

    effect(() => {
      if (s.value === 1) {
        disposeB(); // dispose B from inside A's execution
      }
      return undefined;
    });

    spyB.mockClear();
    s.value = 1; // A runs and disposes B; B should not run after disposal
    // B might have already run for value=1 before A disposes it (order-dependent)
    // But after this, B should definitely not run again
    spyB.mockClear();
    s.value = 2;
    expect(spyB).not.toHaveBeenCalled();
  });

  it("disposing self from cleanup does not crash or overflow stack", () => {
    const s = signal(0);
    let disposeRef: (() => void) | null = null;
    const errors: unknown[] = [];
    const prev = setEffectErrorHandler((e) => {
      errors.push(e);
    });
    disposeRef = effect(() => {
      void s.value;
      return () => {
        // cleanup tries to dispose self (already being disposed)
        if (disposeRef) {
          disposeRef();
        }
      };
    });
    // Trigger re-run (which calls cleanup which calls dispose)
    s.value = 1;
    // Should not have stack overflow error
    expect(errors.every((e) => !(e instanceof RangeError))).toBe(true);
    setEffectErrorHandler(prev);
  });
});

// ---------------------------------------------------------------------------
// on() with empty deps
// ---------------------------------------------------------------------------

describe("on() with empty deps", () => {
  it("on() with empty array deps runs once and never re-triggers", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(
      on([] as (() => unknown)[], (vals) => {
        // Read s inside body (should not be tracked due to untracked in on())
        spy(vals, s.value);
        return undefined;
      }),
    );
    expect(spy).toHaveBeenCalledWith([], 0);
    spy.mockClear();
    s.value = 1;
    expect(spy).not.toHaveBeenCalled();
  });

  it("on() with single dep returning undefined", () => {
    const s = signal<undefined>(undefined);
    const spy = vi.fn();
    effect(
      on(
        () => s.value,
        (v) => {
          spy(v);
          return undefined;
        },
      ),
    );
    expect(spy).toHaveBeenCalledWith(undefined);
  });
});

// ---------------------------------------------------------------------------
// Store deep nesting
// ---------------------------------------------------------------------------

describe("store deep nesting", () => {
  it("deeply nested batch (10 levels) still flushes correctly", () => {
    const store = createStore<{ x: number }>();
    const spy = vi.fn();
    store.subscribe("x", spy);

    const nest = (depth: number, fn: () => void): void => {
      if (depth === 0) {
        fn();
        return;
      }
      store.batch(() => nest(depth - 1, fn));
    };

    nest(10, () => {
      store.set("x", 42);
    });
    expect(spy).toHaveBeenCalledWith(42);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("store effect with many keys tracked", () => {
    const store = createStore<Record<string, number>>();
    for (let i = 0; i < 100; i++) {
      store.set(`k${i}` as never, i as never);
    }
    const spy = vi.fn();
    store.effect(() => {
      let sum = 0;
      for (let i = 0; i < 100; i++) {
        sum += store.get(`k${i}` as never) as number;
      }
      spy(sum);
      return undefined;
    });
    expect(spy).toHaveBeenCalledWith(4950); // sum 0..99
    spy.mockClear();
    store.set("k0" as never, 100 as never);
    expect(spy).toHaveBeenCalledWith(5050); // 4950 - 0 + 100
  });
});

// ---------------------------------------------------------------------------
// Reconcile with thousands of keyed nodes / moved + removed combos
// ---------------------------------------------------------------------------

describe("reconcile: large scale", () => {
  it("1000 keyed nodes: full reverse", () => {
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

    // Capture references
    const firstEl = parent.children[0]!;
    const lastEl = parent.children[999]!;

    // Full reverse
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

    // Remove every other
    const evens = items.filter((_, i) => i % 2 === 0);
    reconcile(parent, evens, spec);
    expect(parent.children.length).toBe(500);
    expect(removed.length).toBe(500);

    // Re-add all
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

    // Deterministic shuffle (Fisher-Yates with fixed seed)
    const shuffled = [...items];
    let seed = 12345;
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    reconcile(parent, shuffled, spec);
    expect(parent.children.length).toBe(1000);

    // Verify identity preservation
    for (const el of Array.from(parent.children)) {
      const key = el.getAttribute("data-reconcile-key")!;
      expect(el).toBe(refMap.get(key));
    }
  });
});

// ---------------------------------------------------------------------------
// Store: dispose from cleanup does not overflow
// ---------------------------------------------------------------------------

describe("store: dispose from cleanup", () => {
  it("store effect dispose called from cleanup does not overflow", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    let disposeRef: (() => void) | null = null;
    disposeRef = store.effect(() => {
      void store.get("x");
      return () => {
        if (disposeRef) {
          disposeRef();
        }
      };
    });
    // Trigger re-run which calls cleanup which calls dispose
    expect(() => {
      store.set("x", 1);
    }).not.toThrow();
  });

  it("store effect double dispose is no-op", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    let cleanupCount = 0;
    const dispose = store.effect(() => {
      void store.get("x");
      return () => {
        cleanupCount++;
      };
    });
    dispose();
    expect(cleanupCount).toBe(1);
    dispose();
    expect(cleanupCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// flushSync edge cases
// ---------------------------------------------------------------------------

describe("flushSync", () => {
  it("flushSync outside batch drains pending", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    // Normally writes flush immediately, but let's verify flushSync is a no-op
    // when nothing is pending
    flushSync();
    expect(spy).not.toHaveBeenCalled();
  });

  it("flushSync inside batch is a no-op", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    batch(() => {
      s.value = 1;
      flushSync(); // should be no-op inside batch
      expect(spy).not.toHaveBeenCalled();
    });
    expect(spy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Computed: dirty flag after disposal of downstream effect
// ---------------------------------------------------------------------------

describe("computed: lazy after effect disposal", () => {
  it("computed stays fresh after all effect subscribers are disposed", () => {
    const s = signal(1);
    const c = computed(() => s.value * 10);
    const spy = vi.fn();
    const dispose = effect(() => {
      spy(c.value);
      return undefined;
    });
    expect(spy).toHaveBeenCalledWith(10);
    dispose();
    s.value = 5;
    // Computed should still give correct value when read lazily
    expect(c.value).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Signal: peek() does not track
// ---------------------------------------------------------------------------

describe("signal peek", () => {
  it("peek inside effect does not create subscription", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.peek());
      return undefined;
    });
    expect(spy).toHaveBeenCalledWith(0);
    spy.mockClear();
    s.value = 1;
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Effect cleanup ordering with multiple effects
// ---------------------------------------------------------------------------

describe("effect cleanup ordering", () => {
  it("cleanup of effect A runs before effect A re-executes, not before B", () => {
    const s = signal(0);
    const order: string[] = [];
    effect(() => {
      order.push(`A:${s.value}`);
      return () => {
        order.push(`cleanup-A:${s.value}`);
      };
    });
    effect(() => {
      order.push(`B:${s.value}`);
      return () => {
        order.push(`cleanup-B:${s.value}`);
      };
    });
    order.length = 0;
    s.value = 1;
    // Each effect's cleanup runs before its own re-execution
    expect(order).toContain("cleanup-A:1");
    expect(order).toContain("cleanup-B:1");
    expect(order.indexOf("cleanup-A:1")).toBeLessThan(order.indexOf("A:1"));
    expect(order.indexOf("cleanup-B:1")).toBeLessThan(order.indexOf("B:1"));
  });
});

// ---------------------------------------------------------------------------
// Computed: error recovery in effect
// ---------------------------------------------------------------------------

describe("computed error recovery in effect", () => {
  let prevHandler: EffectErrorHandler;
  const errors: unknown[] = [];
  beforeEach(() => {
    errors.length = 0;
    prevHandler = setEffectErrorHandler((e) => {
      errors.push(e);
    });
  });
  afterEach(() => {
    setEffectErrorHandler(prevHandler);
  });

  it("effect recovers after computed stops throwing", () => {
    const s = signal(0);
    const c = computed(() => {
      if (s.value === 0) {
        throw new Error("zero");
      }
      return s.value * 2;
    });
    const values: number[] = [];
    effect(() => {
      values.push(c.value);
      return undefined;
    });
    // First run throws
    expect(errors.length).toBe(1);
    expect(values).toEqual([]);

    // Fix the signal
    s.value = 5;
    expect(values).toEqual([10]);
  });
});
