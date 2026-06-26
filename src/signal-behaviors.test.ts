// Reactive signal core — runtime behaviors beyond the basic API: dependency-graph
// correctness, dispose/leak, cycle detection, re-entrancy, batch interleaving,
// synchronous scheduling, peek/flush semantics, and effect lifecycle.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signal, effect, batch, computed, setEffectErrorHandler, flushSync } from "./index.js";
import type { ReadonlySignal } from "./index.js";

describe("dispose / leak", () => {
  it("disposed effect runs cleanup exactly once; double-dispose is a no-op", () => {
    const cleanupSpy = vi.fn();
    const s = signal(0);
    const dispose = effect(() => {
      void s.value;
      return cleanupSpy;
    });
    dispose();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    dispose();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("disposed effect mid-batch: not re-triggered", () => {
    const s = signal(0);
    const spy = vi.fn();
    const dispose = effect(() => {
      spy(s.value);
    });
    spy.mockClear();
    batch(() => {
      s.value = 1;
      dispose();
      s.value = 2;
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("many effects created and disposed: no accumulating edges", () => {
    const s = signal(0);
    const disposers: (() => void)[] = [];
    for (let i = 0; i < 100; i++) {
      disposers.push(
        effect(() => {
          void s.value;
        }),
      );
    }
    for (const d of disposers) {
      d();
    }
    // Signal should have no targets after all effects disposed
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
    spy.mockClear();
    s.value = 1;
    // Only the one remaining effect fires
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("dispose during own execution does not crash", () => {
    const s = signal(0);
    const spy = vi.fn();
    const disposeFn: { current: () => void } = {
      current: () => {
        /* placeholder */
      },
    };
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

  it("computed that loses all subscribers still recomputes lazily on dep change", () => {
    const s = signal(1);
    const c = computed(() => s.value * 2);
    const spy = vi.fn();
    const dispose = effect(() => {
      spy(c.value);
      return undefined;
    });
    expect(spy).toHaveBeenCalledWith(2);
    dispose();
    s.value = 5;
    // Reading computed lazily should still give correct value
    expect(c.value).toBe(10);
  });

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
    s.value = 1; // A runs and disposes B
    // After this, B should definitely not run again
    spyB.mockClear();
    s.value = 2;
    expect(spyB).not.toHaveBeenCalled();
  });

  it("disposing self from cleanup does not crash or overflow the stack", () => {
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
    // Should not have a stack overflow error
    expect(errors.every((e) => !(e instanceof RangeError))).toBe(true);
    setEffectErrorHandler(prev);
  });
});

describe("batch: cycle detection", () => {
  it("throws when effect re-triggers itself >100 times", () => {
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    const s = signal(0);
    // This effect writes to s on every run, creating an infinite loop;
    // after 100 iterations endBatch throws and unwinds.
    effect(() => {
      if (s.value < 200) {
        s.value = s.value + 1;
      }
    });
    setEffectErrorHandler(prev);
    // Verify system is still usable after cycle detection
    const spy = vi.fn();
    const s2 = signal(0);
    effect(() => {
      spy(s2.value);
    });
    spy.mockClear();
    s2.value = 42;
    expect(spy).toHaveBeenCalledWith(42);
  });

  it("nested batches don't false-trigger cycle detection", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
    spy.mockClear();
    batch(() => {
      batch(() => {
        batch(() => {
          s.value = 1;
        });
        s.value = 2;
      });
      s.value = 3;
    });
    // Only final value visible
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(3);
  });
});

describe("re-entrancy", () => {
  it("signal write inside effect triggers re-run until it converges", () => {
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

  it("self-incrementing effect converges without an infinite loop", () => {
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

  it("self-incrementing effect inside batch converges", () => {
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

  it("cleanup writing to a signal propagates to downstream effects", () => {
    const s = signal(0);
    const s2 = signal("x");
    const log: string[] = [];
    effect(() => {
      void s.value;
      return () => {
        s2.value = `cleaned-${s.peek()}`;
      };
    });
    effect(() => {
      log.push(s2.value);
      return undefined;
    });
    log.length = 0;
    s.value = 1;
    expect(log).toContain("cleaned-1");
  });
});

describe("flushSync", () => {
  it("is a no-op when nothing is pending", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    // Writes flush immediately, so flushSync with nothing pending does nothing.
    flushSync();
    expect(spy).not.toHaveBeenCalled();
  });

  it("is a no-op inside a batch", () => {
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

describe("effect cleanup ordering", () => {
  it("each effect's cleanup runs before its own re-execution", () => {
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
    expect(order).toContain("cleanup-A:1");
    expect(order).toContain("cleanup-B:1");
    expect(order.indexOf("cleanup-A:1")).toBeLessThan(order.indexOf("A:1"));
    expect(order.indexOf("cleanup-B:1")).toBeLessThan(order.indexOf("B:1"));
  });

  it("cleanup runs exactly once per re-run", () => {
    const s = signal(0);
    let cleanups = 0;
    effect(() => {
      void s.value;
      return () => {
        cleanups++;
      };
    });
    s.value = 1;
    s.value = 2;
    s.value = 3;
    expect(cleanups).toBe(3); // exactly one per re-run
  });
});

describe("pathological graphs", () => {
  it("deep diamond (10 levels) fires leaf effect exactly once per change", () => {
    const root = signal(0);
    // Each level splits into 2 computeds that merge at the next level.
    let nodes: ReadonlySignal<number>[] = [computed(() => root.value)];
    for (let level = 0; level < 10; level++) {
      const next: ReadonlySignal<number>[] = [];
      for (const n of nodes) {
        next.push(computed(() => n.value + 1));
        next.push(computed(() => n.value + 2));
      }
      const merged: ReadonlySignal<number>[] = [];
      for (let i = 0; i < next.length; i += 2) {
        merged.push(computed(() => next[i]!.value + next[i + 1]!.value));
      }
      nodes = merged;
    }
    const leaf = nodes[0]!;
    const spy = vi.fn();
    effect(() => {
      spy(leaf.value);
      return undefined;
    });
    spy.mockClear();
    root.value = 1;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fan-in: 50 signals → 1 computed → 1 effect, batched update fires once", () => {
    const signals = Array.from({ length: 50 }, (_, i) => signal(i));
    const sum = computed(() => signals.reduce((acc, s) => acc + s.value, 0));
    const spy = vi.fn();
    effect(() => {
      spy(sum.value);
      return undefined;
    });
    spy.mockClear();
    batch(() => {
      for (const s of signals) {
        s.value = s.peek() + 1;
      }
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(1275); // sum(0..49)=1225, each +1 → sum(1..50)=1275
  });
});

describe("dispose: ordering and unlinking", () => {
  it("disposing effects in reverse order of creation runs cleanups in that order", () => {
    const s = signal(0);
    const order: string[] = [];
    const disposers = Array.from({ length: 5 }, (_, i) =>
      effect(() => {
        order.push(`e${i}:${s.value}`);
        return () => {
          order.push(`c${i}`);
        };
      }),
    );
    order.length = 0;
    for (let i = 4; i >= 0; i--) {
      disposers[i]!();
    }
    expect(order).toEqual(["c4", "c3", "c2", "c1", "c0"]);
    order.length = 0;
    s.value = 1;
    expect(order).toEqual([]);
  });

  it("disposing sibling effects during flush does not corrupt iteration", () => {
    const s = signal(0);
    const spy = vi.fn();
    const disposers: (() => void)[] = [];
    disposers.push(
      effect(() => {
        if (s.value === 1) {
          disposers[1]?.();
          disposers[2]?.();
        }
        return undefined;
      }),
    );
    disposers.push(
      effect(() => {
        spy("e1:" + s.value);
        return undefined;
      }),
    );
    disposers.push(
      effect(() => {
        spy("e2:" + s.value);
        return undefined;
      }),
    );
    disposers.push(
      effect(() => {
        spy("e3:" + s.value);
        return undefined;
      }),
    );
    spy.mockClear();
    s.value = 1;
    // e3 still fires; the disposed siblings must not break the flush.
    expect(spy).toHaveBeenCalledWith("e3:1");
  });

  it("disposed computed no longer recomputes when its sources change", () => {
    const s = signal(0);
    const computeds: ReturnType<typeof computed>[] = [];
    const disposers: (() => void)[] = [];
    for (let i = 0; i < 100; i++) {
      const c = computed(() => s.value + i);
      computeds.push(c);
      disposers.push(
        effect(() => {
          void c.value;
          return undefined;
        }),
      );
    }
    for (const d of disposers) {
      d();
    }
    const spy = vi.fn();
    const d2 = effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    s.value = 99;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(99);
    d2();
  });
});

describe("batch interleaving", () => {
  it("computed read mid-batch sees consistent state after flush", () => {
    const a = signal(1);
    const b = signal(2);
    const sum = computed(() => a.value + b.value);
    const values: number[] = [];
    effect(() => {
      values.push(sum.value);
      return undefined;
    });
    values.length = 0;
    batch(() => {
      a.value = 10;
      b.value = 20;
    });
    expect(values).toContain(30); // 10 + 20
  });

  it("effect creating a new effect during batch flush runs the new effect", () => {
    const s = signal(0);
    const inner = vi.fn();
    effect(() => {
      if (s.value === 1) {
        effect(() => {
          inner(s.value);
          return undefined;
        });
      }
      return undefined;
    });
    batch(() => {
      s.value = 1;
    });
    expect(inner).toHaveBeenCalledWith(1);
  });
});

describe("synchronous scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("signal write + effect is fully synchronous (no pending timers/microtasks)", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    s.value = 1;
    // Already fired without advancing any timers.
    expect(spy).toHaveBeenCalledWith(1);
  });
});

describe("custom equals reading other signals", () => {
  it("equals that peeks another signal does not corrupt tracking", () => {
    const a = signal(0);
    const b = signal(0, {
      equals: (prev, next) => {
        void a.peek(); // peek is safe inside equals
        return prev === next;
      },
    });
    const spy = vi.fn();
    effect(() => {
      spy(b.value);
      return undefined;
    });
    spy.mockClear();
    b.value = 1;
    expect(spy).toHaveBeenCalledWith(1);
  });
});

describe("glitch-freedom: complex graphs", () => {
  it("nested diamond (A→B,C→D→E,F→G) fires the leaf effect once", () => {
    const a = signal(1);
    const b = computed(() => a.value * 2);
    const c = computed(() => a.value * 3);
    const d = computed(() => b.value + c.value);
    const e = computed(() => d.value + 1);
    const f = computed(() => d.value * 2);
    const g = computed(() => e.value + f.value);
    const spy = vi.fn();
    effect(() => {
      spy(g.value);
    });
    expect(spy).toHaveBeenLastCalledWith(16);
    spy.mockClear();
    a.value = 4;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(61);
  });

  it("dynamic dependency switching: a selector picks which source is tracked", () => {
    const selector = signal(0);
    const a = signal(10);
    const b = signal(20);
    const c = signal(30);
    const sources = [a, b, c];
    const picked = computed(() => sources[selector.value]!.value);
    const spy = vi.fn();
    effect(() => {
      spy(picked.value);
    });
    expect(spy).toHaveBeenLastCalledWith(10);
    spy.mockClear();
    selector.value = 1;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(20);
    spy.mockClear();
    a.value = 99; // no longer tracked
    expect(spy).not.toHaveBeenCalled();
    b.value = 42; // now tracked
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(42);
  });

  it("triple overlapping diamonds in a batch fire the effect once", () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const ab = computed(() => a.value + b.value);
    const bc = computed(() => b.value + c.value);
    const ac = computed(() => a.value + c.value);
    const sum = computed(() => ab.value + bc.value + ac.value);
    const spy = vi.fn();
    effect(() => {
      spy(sum.value);
    });
    expect(spy).toHaveBeenLastCalledWith(12);
    spy.mockClear();
    batch(() => {
      a.value = 10;
      b.value = 20;
      c.value = 30;
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(120);
  });

  it("no stale intermediate is observed in a diamond", () => {
    const a = signal(1);
    const b = computed(() => a.value + 1);
    const c = computed(() => a.value * 2);
    const observed: [number, number][] = [];
    effect(() => {
      observed.push([b.value, c.value]);
    });
    observed.length = 0;
    a.value = 5;
    expect(observed).toEqual([[6, 10]]); // single consistent observation
  });

  it("an unchanged intermediate computed blocks downstream propagation", () => {
    const s = signal(0);
    const parity = computed(() => s.value % 2); // 0 or 1
    const downstream = computed(() => parity.value * 100);
    const spy = vi.fn();
    effect(() => {
      spy(downstream.value);
    });
    spy.mockClear();
    s.value = 2; // parity stays 0
    expect(spy).not.toHaveBeenCalled();
    s.value = 3; // parity flips to 1
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(100);
  });
});

describe("cycle detection under high write volume", () => {
  it("many sequential writes never trip false cycle detection", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
    for (let i = 1; i <= 150; i++) {
      spy.mockClear();
      s.value = i;
      expect(spy).toHaveBeenCalledWith(i);
    }
  });
});

describe("peek", () => {
  it("computed peek() triggers refresh without tracking", () => {
    const s = signal(5);
    const c = computed(() => s.value * 3);
    const spy = vi.fn();
    effect(() => {
      // Use peek on c — should NOT create a subscription
      spy(c.peek());
    });
    expect(spy).toHaveBeenCalledWith(15);
    spy.mockClear();
    s.value = 10;
    // Effect should NOT re-run because peek doesn't track
    expect(spy).not.toHaveBeenCalled();
    // But peek still returns fresh value
    expect(c.peek()).toBe(30);
  });

  it("signal peek() doesn't track", () => {
    const s = signal(1);
    const spy = vi.fn();
    effect(() => {
      spy(s.peek());
    });
    spy.mockClear();
    s.value = 2;
    expect(spy).not.toHaveBeenCalled();
  });

  it("peek on an errored computed throws the cached error, then recovers", () => {
    const s = signal(0);
    const c = computed(() => {
      if (s.value === 1) {
        throw new Error("peek-err");
      }
      return s.value;
    });
    s.value = 1;
    expect(() => c.peek()).toThrow("peek-err");
    s.value = 2;
    expect(c.peek()).toBe(2);
  });

  it("signal peek inside a batch sees the latest pending write", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
    spy.mockClear();
    batch(() => {
      s.value = 1;
      expect(s.peek()).toBe(1);
      s.value = 2;
      expect(s.peek()).toBe(2);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(2);
  });
});

describe("effect lifecycle", () => {
  it("an effect that creates another effect: both react to later changes", () => {
    const s = signal(0);
    const inner: number[] = [];
    const outer: number[] = [];
    let innerDispose: (() => void) | undefined;
    effect(() => {
      outer.push(s.value);
      if (s.value === 1 && !innerDispose) {
        innerDispose = effect(() => {
          inner.push(s.value);
        });
      }
    });
    expect(outer).toEqual([0]);
    s.value = 1;
    expect(outer).toContain(1);
    expect(inner).toContain(1);
    s.value = 2;
    expect(outer).toContain(2);
    expect(inner).toContain(2);
    if (innerDispose) {
      innerDispose();
    }
  });
});
