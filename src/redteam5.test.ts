// @vitest-environment happy-dom
// RED-TEAM round-5 — final convergence attack
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  signal,
  effect,
  batch,
  computed,
  setEffectErrorHandler,
  flushSync,
  createStore,
} from "./index.js";
import type { EffectErrorHandler } from "./index.js";

// ---------------------------------------------------------------------------
// 1. Every effect in a batch has a cleanup that throws
// ---------------------------------------------------------------------------
describe("batch: cleanup throws on EVERY effect", () => {
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

  it("20 effects all with throwing cleanups still all re-execute in batch", () => {
    const s = signal(0);
    const spies = Array.from({ length: 20 }, () => vi.fn());
    for (let i = 0; i < 20; i++) {
      const spy = spies[i]!;
      effect(() => {
        spy(s.value);
        return () => {
          throw new Error(`batch-cleanup-${i}`);
        };
      });
    }
    for (const spy of spies) {
      spy.mockClear();
    }
    errors.length = 0;
    batch(() => {
      s.value = 42;
    });
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledWith(42);
    }
    expect(errors.length).toBe(20);
  });

  it("nested batch: inner and outer effects' cleanups all throw", () => {
    const a = signal(0);
    const b = signal(0);
    const log: string[] = [];
    effect(() => {
      log.push(`a:${a.value}`);
      return () => {
        throw new Error("clean-a");
      };
    });
    effect(() => {
      log.push(`b:${b.value}`);
      return () => {
        throw new Error("clean-b");
      };
    });
    log.length = 0;
    errors.length = 0;
    batch(() => {
      a.value = 1;
      batch(() => {
        b.value = 1;
      });
    });
    expect(log).toContain("a:1");
    expect(log).toContain("b:1");
    expect(errors.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Error thrown inside effectErrorHandler
// ---------------------------------------------------------------------------
describe("effectErrorHandler itself throws", () => {
  let prevHandler: EffectErrorHandler;
  beforeEach(() => {
    prevHandler = setEffectErrorHandler(() => {
      /* swallow */
    });
  });
  afterEach(() => {
    setEffectErrorHandler(prevHandler);
  });

  it("handler throw during batch doesn't prevent other effects from running", () => {
    let _handlerCalls = 0;
    setEffectErrorHandler(() => {
      _handlerCalls++;
      throw new Error("handler-explodes");
    });
    const s = signal(0);
    const spy1 = vi.fn();
    const spy2 = vi.fn();
    effect(() => {
      spy1(s.value);
      if (s.value > 0) {
        throw new Error("e1");
      }
      return undefined;
    });
    effect(() => {
      spy2(s.value);
      return undefined;
    });
    spy1.mockClear();
    spy2.mockClear();
    // The handler throwing should not make the system unusable
    try {
      batch(() => {
        s.value = 1;
      });
    } catch {
      /* swallow top-level */
    }
    // After resetting the handler, the system should work
    setEffectErrorHandler(() => {
      /* swallow */
    });
    spy1.mockClear();
    spy2.mockClear();
    s.value = 2;
    expect(spy1).toHaveBeenCalledWith(2);
    expect(spy2).toHaveBeenCalledWith(2);
  });

  it("handler throw during cleanup: effect still re-subscribes on next trigger", () => {
    setEffectErrorHandler(() => {
      throw new Error("handler-ka-boom");
    });
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return () => {
        throw new Error("cleanup!");
      };
    });
    spy.mockClear();
    try {
      s.value = 1;
    } catch {
      /* handler throws propagate */
    }
    // Reset handler and verify effect is alive
    setEffectErrorHandler(() => {
      /* swallow */
    });
    spy.mockClear();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Dispose during flush
// ---------------------------------------------------------------------------
describe("dispose during flush", () => {
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

  it("effect disposes itself during execution", () => {
    const s = signal(0);
    const log: number[] = [];
    const ref: { dispose?: () => void } = {};
    ref.dispose = effect(() => {
      const v = s.value;
      log.push(v);
      if (v === 1) {
        ref.dispose?.();
      }
      return undefined;
    });
    s.value = 1;
    s.value = 2;
    // After self-dispose at v=1, effect should not run for v=2
    expect(log).toEqual([0, 1]);
  });

  it("effect A disposes effect B during flush", () => {
    const s = signal(0);
    const logA: number[] = [];
    const logB: number[] = [];
    const refB: { dispose?: () => void } = {};
    effect(() => {
      const v = s.value;
      logA.push(v);
      if (v === 1) {
        refB.dispose?.();
      }
      return undefined;
    });
    refB.dispose = effect(() => {
      logB.push(s.value);
      return undefined;
    });
    s.value = 1;
    s.value = 2;
    // B should not run after being disposed by A during v=1 flush
    expect(logA).toContain(2);
    expect(logB).not.toContain(2);
  });

  it("dispose during flush with throwing cleanup", () => {
    const s = signal(0);
    const log: number[] = [];
    const ref: { dispose?: () => void } = {};
    ref.dispose = effect(() => {
      const v = s.value;
      log.push(v);
      if (v === 1) {
        ref.dispose?.();
      }
      return () => {
        throw new Error("self-dispose-cleanup");
      };
    });
    s.value = 1;
    // Should not crash; cleanup error goes to handler
    expect(log).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// 4. Computed whose equals throws during diamond update
// ---------------------------------------------------------------------------
describe("computed equals throws during diamond update", () => {
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

  it("equals throwing treated as changed — effect re-runs", () => {
    const s = signal(0);
    let throwOnEquals = false;
    const c = computed(() => s.value * 2, {
      equals: () => {
        if (throwOnEquals) {
          throw new Error("equals-boom");
        }
        return false; // always changed
      },
    });
    const log: number[] = [];
    effect(() => {
      try {
        log.push(c.value);
      } catch {
        /* computed may throw */
      }
      return undefined;
    });
    throwOnEquals = true;
    s.value = 1;
    // equals threw → treated as changed → effect should have re-run
    expect(log.length).toBeGreaterThan(1);
  });

  it("diamond: equals throws on one branch, effect sees correct value", () => {
    const root = signal(0);
    let _throwCount = 0;
    const left = computed(() => root.value + 1, {
      equals: () => {
        _throwCount++;
        throw new Error("left-equals");
      },
    });
    const right = computed(() => root.value + 2);
    const log: string[] = [];
    effect(() => {
      try {
        log.push(`L=${left.value},R=${right.value}`);
      } catch (e) {
        log.push(`err:${(e as Error).message}`);
      }
      return undefined;
    });
    root.value = 10;
    // The effect should have re-run. Right branch should have correct value.
    expect(log.some((s) => s.includes("R=12"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Store effect cleanup throw (verify round-4 fix)
// ---------------------------------------------------------------------------
describe("store effect cleanup throw (round-4 verification)", () => {
  it("store effect cleanup throw: effect re-subscribes to changed keys", () => {
    const store = createStore<{ x: number; y: number }>();
    store.set("x", 0);
    store.set("y", 0);
    const log: string[] = [];
    const origErr = console.error;
    console.error = vi.fn();
    store.effect(() => {
      log.push(`x=${store.get("x")},y=${store.get("y")}`);
      return () => {
        throw new Error("store-cleanup");
      };
    });
    store.set("x", 1);
    store.set("y", 2);
    console.error = origErr;
    expect(log).toContain("x=0,y=0");
    expect(log).toContain("x=1,y=0");
    expect(log).toContain("x=1,y=2");
  });

  it("store batch + cleanup throws on all effects", () => {
    const store = createStore<{ n: number }>();
    store.set("n", 0);
    const spies = Array.from({ length: 5 }, () => vi.fn());
    const origErr = console.error;
    console.error = vi.fn();
    for (const spy of spies) {
      store.effect(() => {
        spy(store.get("n"));
        return () => {
          throw new Error("store-batch-cleanup");
        };
      });
    }
    for (const spy of spies) {
      spy.mockClear();
    }
    store.batch(() => {
      store.set("n", 99);
    });
    console.error = origErr;
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledWith(99);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Deep dispose chains
// ---------------------------------------------------------------------------
describe("deep dispose chains", () => {
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

  it("effect creates child effects; disposing parent doesn't crash", () => {
    const s = signal(0);
    const childDisposers: (() => void)[] = [];
    const parentDispose = effect(() => {
      const v = s.value;
      // Create child effects each time parent runs
      const d = effect(() => {
        void s.value; // track
        return () => {
          throw new Error(`child-cleanup-${v}`);
        };
      });
      childDisposers.push(d);
      return () => {
        // Parent cleanup disposes children
        for (const cd of childDisposers) {
          cd();
        }
        childDisposers.length = 0;
      };
    });
    s.value = 1;
    s.value = 2;
    // Dispose parent — should not throw
    expect(() => parentDispose()).not.toThrow();
  });

  it("100-deep dispose chain with throwing cleanups", () => {
    const s = signal(0);
    const disposers: (() => void)[] = [];
    for (let i = 0; i < 100; i++) {
      disposers.push(
        effect(() => {
          void s.value;
          return () => {
            throw new Error(`deep-${i}`);
          };
        }),
      );
    }
    errors.length = 0;
    // Dispose all — no crashes, all errors routed to handler
    for (const d of disposers) {
      d();
    }
    expect(errors.length).toBe(100);
    // Signal should still work after mass dispose
    const spy = vi.fn();
    const d2 = effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    s.value = 999;
    expect(spy).toHaveBeenCalledWith(999);
    d2();
  });
});

// ---------------------------------------------------------------------------
// 7. Leak check after mass dispose
// ---------------------------------------------------------------------------
describe("leak check after mass dispose", () => {
  let prevHandler: EffectErrorHandler;
  beforeEach(() => {
    prevHandler = setEffectErrorHandler(() => {
      /* swallow */
    });
  });
  afterEach(() => {
    setEffectErrorHandler(prevHandler);
  });

  it("disposed effects are not triggered by signal changes", () => {
    const s = signal(0);
    const disposers: (() => void)[] = [];
    const spies: ReturnType<typeof vi.fn>[] = [];
    for (let i = 0; i < 50; i++) {
      const spy = vi.fn();
      spies.push(spy);
      disposers.push(
        effect(() => {
          spy(s.value);
          return () => {
            throw new Error(`leak-cleanup-${i}`);
          };
        }),
      );
    }
    // Dispose all
    for (const d of disposers) {
      d();
    }
    // Clear spies
    for (const spy of spies) {
      spy.mockClear();
    }
    // Change signal — no disposed effects should fire
    s.value = 100;
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("store: disposed effects don't leak subscriptions", () => {
    const store = createStore<{ k: number }>();
    store.set("k", 0);
    const disposers: (() => void)[] = [];
    const spies: ReturnType<typeof vi.fn>[] = [];
    const origErr = console.error;
    console.error = vi.fn();
    for (let i = 0; i < 30; i++) {
      const spy = vi.fn();
      spies.push(spy);
      disposers.push(
        store.effect(() => {
          spy(store.get("k"));
          return () => {
            throw new Error(`store-leak-${i}`);
          };
        }),
      );
    }
    for (const d of disposers) {
      d();
    }
    for (const spy of spies) {
      spy.mockClear();
    }
    store.set("k", 999);
    console.error = origErr;
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("computed with disposed subscribers doesn't accumulate dead refs", () => {
    const s = signal(0);
    const c = computed(() => s.value * 3);
    const disposers: (() => void)[] = [];
    for (let i = 0; i < 50; i++) {
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
    // After disposing, computed should still work correctly
    s.value = 7;
    expect(c.value).toBe(21);
    // New effect on computed should work fine
    const spy = vi.fn();
    const d = effect(() => {
      spy(c.value);
      return undefined;
    });
    spy.mockClear();
    s.value = 8;
    expect(spy).toHaveBeenCalledWith(24);
    d();
  });
});

// ---------------------------------------------------------------------------
// 8. Dispose re-entrancy guard (round-4 fix verification)
// ---------------------------------------------------------------------------
describe("dispose re-entrancy guard", () => {
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

  it("calling dispose multiple times is safe", () => {
    const s = signal(0);
    const spy = vi.fn();
    const dispose = effect(() => {
      spy(s.value);
      return () => {
        throw new Error("multi-dispose");
      };
    });
    dispose();
    dispose();
    dispose();
    // Only one cleanup error, not three
    expect(errors.length).toBe(1);
  });

  it("dispose inside effect body (re-entrancy) is safe", () => {
    const s = signal(0);
    const ref: { dispose?: () => void } = {};
    const log: number[] = [];
    ref.dispose = effect(() => {
      const v = s.value;
      log.push(v);
      if (v === 5) {
        ref.dispose?.();
      }
      return undefined;
    });
    s.value = 5;
    s.value = 6;
    expect(log).toEqual([0, 5]);
  });
});

// ---------------------------------------------------------------------------
// 9. flushSync interaction with error paths
// ---------------------------------------------------------------------------
describe("flushSync with errors", () => {
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

  it("flushSync after batch with throwing effects", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return () => {
        throw new Error("flush-cleanup");
      };
    });
    spy.mockClear();
    batch(() => {
      s.value = 1;
      // flushSync inside batch is a no-op
      flushSync();
      expect(spy).not.toHaveBeenCalled();
    });
    // After batch, effect should have run
    expect(spy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// 10. Stress: rapid signal changes with computed + effect + cleanup throws
// ---------------------------------------------------------------------------
describe("stress: rapid changes with computed + effect + cleanup throws", () => {
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

  it("1000 rapid writes with cleanup-throwing effect", () => {
    const s = signal(0);
    let lastSeen = -1;
    effect(() => {
      lastSeen = s.value;
      return () => {
        throw new Error("rapid-cleanup");
      };
    });
    errors.length = 0;
    for (let i = 1; i <= 1000; i++) {
      s.value = i;
    }
    expect(lastSeen).toBe(1000);
    expect(errors.length).toBe(1000);
  });

  it("1000 rapid writes in batch: single flush", () => {
    const s = signal(0);
    let lastSeen = -1;
    let runCount = 0;
    effect(() => {
      lastSeen = s.value;
      runCount++;
      return () => {
        throw new Error("batch-rapid-cleanup");
      };
    });
    runCount = 0;
    errors.length = 0;
    batch(() => {
      for (let i = 1; i <= 1000; i++) {
        s.value = i;
      }
    });
    expect(lastSeen).toBe(1000);
    // Should only run once in batch (single flush)
    expect(runCount).toBe(1);
    expect(errors.length).toBe(1); // one cleanup from the initial run
  });
});
