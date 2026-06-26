// Reactive signal core — exception safety: the graph stays consistent when an
// effect body, cleanup, computed fn, equals comparator, or error handler throws.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signal, effect, batch, computed, subscribe, setEffectErrorHandler } from "./index.js";
import type { EffectErrorHandler } from "./index.js";

// Captures effect errors for the duration of `fn`, restoring the previous
// handler afterwards. Pass the captured-errors array to the body.
function withHandler(fn: (errors: unknown[]) => void): void {
  const errors: unknown[] = [];
  const prev = setEffectErrorHandler((e) => {
    errors.push(e);
  });
  try {
    fn(errors);
  } finally {
    setEffectErrorHandler(prev);
  }
}

describe("batch exception handling", () => {
  it("exception mid-batch still flushes pending effects", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    expect(() => {
      batch(() => {
        s.value = 42;
        throw new Error("mid-batch");
      });
    }).toThrow("mid-batch");
    // batch depth back to 0 and pending effects flushed
    expect(spy).toHaveBeenCalledWith(42);
  });

  it("nested batch exception: outer batch still flushes", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
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

  it("batch depth is not left dirty after exception", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    try {
      batch(() => {
        throw new Error("oops");
      });
    } catch {
      // swallow
    }
    // Subsequent writes should flush immediately (not batched)
    s.value = 99;
    expect(spy).toHaveBeenCalledWith(99);
  });
});

describe("custom equals throwing", () => {
  it("signal: exception in equals propagates to caller", () => {
    const s = signal(1, {
      equals: () => {
        throw new Error("equals boom");
      },
    });
    expect(() => {
      s.value = 2;
    }).toThrow("equals boom");
  });

  it("computed: exception in equals is treated as changed and downstream still notified", () => {
    const s = signal(1);
    const c = computed(() => s.value, {
      equals: () => {
        throw new Error("eq error");
      },
    });
    // First read works (no prior value to compare against)
    expect(c.value).toBe(1);
    // Subscribe an effect that reads the computed
    const values: number[] = [];
    effect(() => {
      values.push(c.value);
      return undefined;
    });
    expect(values).toEqual([1]);
    // Now change dep — the refresh compares using equals, which throws.
    // The equals error is swallowed (treated as "changed"), downstream is notified.
    s.value = 2;
    expect(values).toEqual([1, 2]);
    // System should still work after the error
    const s2 = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s2.value);
      return undefined;
    });
    spy.mockClear();
    s2.value = 42;
    expect(spy).toHaveBeenCalledWith(42);
  });
});

describe("exception unwinding leaves no stuck state", () => {
  let prevHandler: EffectErrorHandler;
  beforeEach(() => {
    prevHandler = setEffectErrorHandler(() => {
      /* swallow */
    });
  });
  afterEach(() => {
    setEffectErrorHandler(prevHandler);
  });

  it("recovers after an effect throws during flush", () => {
    const s = signal(0);
    let threw = false;
    effect(() => {
      if (s.value === 1 && !threw) {
        threw = true;
        throw new Error("effect boom");
      }
      return undefined;
    });
    s.value = 1; // triggers throw during the flush
    // System should still work — the flush state must have unwound cleanly.
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("nested batch throwing at every level still resets and flushes", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();

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

    // Batch depth must be 0 — subsequent writes flush immediately.
    spy.mockClear();
    s.value = 99;
    expect(spy).toHaveBeenCalledWith(99);
  });

  it("signal equals-throw does not corrupt later flushes", () => {
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

describe("exception in effect body during batch", () => {
  let prevHandler: EffectErrorHandler;
  beforeEach(() => {
    prevHandler = setEffectErrorHandler(() => {
      /* swallow */
    });
  });
  afterEach(() => {
    setEffectErrorHandler(prevHandler);
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

describe("computed chain with throwing equals", () => {
  it("computed → computed → signal: inner equals throws, outer still updates", () => {
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
    // The inner refresh swallows the equals throw and treats it as changed,
    // so outer still updates.
    expect(spy).toHaveBeenCalledWith(14); // 2*2+10
  });

  it("deeply chained computeds with a middle one throwing equals", () => {
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

  it("effect recovers after the computed it reads stops throwing", () => {
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

describe("subscribe callback throwing", () => {
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

  it("exception in a subscribe callback is routed to the error handler", () => {
    const s = signal(0);
    subscribe(s, (v) => {
      if (v === 1) {
        throw new Error("subscribe boom");
      }
    });
    s.value = 1;
    expect(errors.some((e) => (e as Error).message === "subscribe boom")).toBe(true);
  });
});

describe("cleanup and body both throw in one run", () => {
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

  it("both errors route to the handler and the effect re-subscribes", () => {
    const s = signal(0);
    const values: number[] = [];
    effect(() => {
      const v = s.value;
      values.push(v);
      if (v === 1) {
        throw new Error("body-throw-1");
      }
      return () => {
        throw new Error("cleanup-throw");
      };
    });
    s.value = 1; // cleanup throws, then body throws
    expect(errors.some((e) => (e as Error).message === "cleanup-throw")).toBe(true);
    expect(errors.some((e) => (e as Error).message === "body-throw-1")).toBe(true);
    // Effect should still re-execute on the next change
    errors.length = 0;
    s.value = 2;
    expect(values).toContain(2);
  });
});

describe("many cleanups throwing in one flush", () => {
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

  it("10 effects with throwing cleanups all re-execute", () => {
    const s = signal(0);
    const spies = Array.from({ length: 10 }, () => vi.fn());
    for (let i = 0; i < 10; i++) {
      const spy = spies[i]!;
      effect(() => {
        spy(s.value);
        return () => {
          throw new Error(`cleanup-${i}`);
        };
      });
    }
    for (const spy of spies) {
      spy.mockClear();
    }
    s.value = 1;
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledWith(1);
    }
    expect(errors.length).toBe(10); // 10 cleanup errors
  });

  it("batched: multiple effects' cleanups throw and all still flush", () => {
    const s = signal(0);
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      effect(() => {
        results.push(s.value);
        return () => {
          throw new Error(`batch-cleanup-${i}`);
        };
      });
    }
    results.length = 0;
    errors.length = 0;
    batch(() => {
      s.value = 99;
    });
    expect(results.filter((v) => v === 99).length).toBe(5);
    expect(errors.length).toBe(5);
  });
});

describe("dispose when cleanup throws", () => {
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

  it("dispose routes the cleanup error to the handler and does not propagate", () => {
    const s = signal(0);
    const dispose = effect(() => {
      void s.value;
      return () => {
        throw new Error("dispose-cleanup-throw");
      };
    });
    expect(() => dispose()).not.toThrow();
    expect(errors.some((e) => (e as Error).message === "dispose-cleanup-throw")).toBe(true);
  });
});

describe("error handler itself throws", () => {
  let prevHandler: EffectErrorHandler;
  beforeEach(() => {
    prevHandler = setEffectErrorHandler(() => {
      /* swallow */
    });
  });
  afterEach(() => {
    setEffectErrorHandler(prevHandler);
  });

  it("system remains usable after the error handler throws on a body error", () => {
    setEffectErrorHandler(() => {
      throw new Error("handler-throws");
    });
    const s = signal(0);
    effect(() => {
      if (s.value === 1) {
        throw new Error("trigger");
      }
      return undefined;
    });
    try {
      s.value = 1; // handler is invoked and itself throws
    } catch {
      /* expected */
    }
    // Reset handler and verify the system still works.
    setEffectErrorHandler(() => {
      /* swallow */
    });
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("next effects still run after the handler throws during a cleanup", () => {
    setEffectErrorHandler(() => {
      throw new Error("handler-boom");
    });
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      void s.value;
      return () => {
        throw new Error("cleanup!");
      };
    });
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    try {
      s.value = 1;
    } catch {
      /* may propagate */
    }
    setEffectErrorHandler(() => {
      /* swallow */
    });
    spy.mockClear();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });
});

describe("high-volume and re-entrant exception paths", () => {
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

  it("self-dispose during flush with a throwing cleanup does not crash", () => {
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
    expect(log).toEqual([0, 1]);
  });

  it("diamond: one branch's equals throws, the other branch still resolves", () => {
    const root = signal(0);
    const left = computed(() => root.value + 1, {
      equals: () => {
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
    expect(log.some((entry) => entry.includes("R=12"))).toBe(true);
  });

  it("disposing a parent effect that created children does not crash", () => {
    const s = signal(0);
    const childDisposers: (() => void)[] = [];
    const parentDispose = effect(() => {
      const v = s.value;
      const d = effect(() => {
        void s.value; // track
        return () => {
          throw new Error(`child-cleanup-${v}`);
        };
      });
      childDisposers.push(d);
      return () => {
        for (const cd of childDisposers) {
          cd();
        }
        childDisposers.length = 0;
      };
    });
    s.value = 1;
    s.value = 2;
    expect(() => parentDispose()).not.toThrow();
  });

  it("100-deep dispose chain with throwing cleanups routes every error", () => {
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

  it("multiple dispose calls invoke a throwing cleanup exactly once", () => {
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
    expect(errors.length).toBe(1); // one cleanup error, not three
  });

  it("1000 rapid writes with a throwing cleanup stay consistent", () => {
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

  it("1000 rapid writes inside a batch flush once", () => {
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
    expect(runCount).toBe(1); // single flush
    expect(errors.length).toBe(1); // one cleanup from the initial run
  });
});

describe("re-entrant error handler", () => {
  it("handler writing to another signal lets the downstream effect run after the flush", () => {
    const s = signal(0);
    const s2 = signal("init");
    const prev = setEffectErrorHandler(() => {
      s2.value = "from-handler";
    });
    const log: string[] = [];
    effect(() => {
      log.push(`s2=${s2.value}`);
      return undefined;
    });
    effect(() => {
      if (s.value > 0) {
        throw new Error("boom");
      }
      return undefined;
    });
    log.length = 0;
    s.value = 1;
    setEffectErrorHandler(prev);
    expect(log).toContain("s2=from-handler");
  });

  it("handler writing during a batch still flushes downstream effects at batch end", () => {
    const s = signal(0);
    const s2 = signal(0);
    const prev = setEffectErrorHandler(() => {
      s2.value = 42;
    });
    const spy = vi.fn();
    effect(() => {
      spy(s2.value);
      return undefined;
    });
    effect(() => {
      if (s.value > 0) {
        throw new Error("x");
      }
      return undefined;
    });
    spy.mockClear();
    batch(() => {
      s.value = 1;
    });
    setEffectErrorHandler(prev);
    expect(spy).toHaveBeenCalledWith(42);
  });

  it("handler disposing the throwing effect leaves no zombie", () => {
    const s = signal(0);
    // eslint-disable-next-line prefer-const
    let dispose: (() => void) | undefined;
    const spy = vi.fn();
    const prev = setEffectErrorHandler(() => {
      dispose?.();
    });
    dispose = effect(() => {
      spy(s.value);
      if (s.value > 0) {
        throw new Error("self-destruct");
      }
      return undefined;
    });
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockClear();
    s.value = 2;
    expect(spy).not.toHaveBeenCalled();
    setEffectErrorHandler(prev);
  });

  it("handler disposing a different effect during the flush stops that effect", () => {
    const s = signal(0);
    // eslint-disable-next-line prefer-const
    let disposeB: (() => void) | undefined;
    const spyA = vi.fn();
    const spyB = vi.fn();
    const prev = setEffectErrorHandler(() => {
      disposeB?.();
    });
    effect(() => {
      spyA(s.value);
      if (s.value > 0) {
        throw new Error("A-throws");
      }
      return undefined;
    });
    disposeB = effect(() => {
      spyB(s.value);
      return undefined;
    });
    spyA.mockClear();
    spyB.mockClear();
    s.value = 1;
    spyA.mockClear();
    spyB.mockClear();
    s.value = 2;
    expect(spyA).toHaveBeenCalledWith(2);
    expect(spyB).not.toHaveBeenCalled();
    setEffectErrorHandler(prev);
  });
});

describe("throwing equals and computeds", () => {
  it("signal equals throw propagates, leaves the value unchanged, and recovers", () => {
    const s = signal(0, {
      equals: (_a, b) => {
        if (b === 5) {
          throw new Error("equals-boom");
        }
        return _a === b;
      },
    });
    const spy = vi.fn();
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    expect(() => {
      s.value = 5;
    }).toThrow("equals-boom");
    expect(s.peek()).toBe(0); // write did not partially apply
    expect(spy).not.toHaveBeenCalled();
    s.value = 3;
    expect(spy).toHaveBeenCalledWith(3);
    expect(s.peek()).toBe(3);
    setEffectErrorHandler(prev);
  });

  it("diamond with two throwing computeds: effect sees both errors, then recovers", () => {
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    const root = signal(0);
    const left = computed(() => {
      if (root.value > 0) {
        throw new Error("left-boom");
      }
      return root.value;
    });
    const right = computed(() => {
      if (root.value > 0) {
        throw new Error("right-boom");
      }
      return root.value;
    });
    const log: string[] = [];
    effect(() => {
      const errs: string[] = [];
      try {
        void left.value;
      } catch (e) {
        errs.push((e as Error).message);
      }
      try {
        void right.value;
      } catch (e) {
        errs.push((e as Error).message);
      }
      log.push(errs.join(",") || "ok");
      return undefined;
    });
    log.length = 0;
    root.value = 1;
    expect(log.some((entry) => entry.includes("left-boom") && entry.includes("right-boom"))).toBe(
      true,
    );
    log.length = 0;
    root.value = -1;
    expect(log.some((entry) => entry === "ok")).toBe(true);
    setEffectErrorHandler(prev);
  });
});

describe("recovery after throwing flushes", () => {
  it("rapid alternating throw / no-throw writes converge to the last value", () => {
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    const s = signal(0);
    let lastSeen = -1;
    effect(() => {
      lastSeen = s.value;
      if (s.value % 2 === 1) {
        throw new Error("odd");
      }
      return undefined;
    });
    for (let i = 1; i <= 100; i++) {
      s.value = i;
    }
    expect(lastSeen).toBe(100);
    setEffectErrorHandler(prev);
  });

  it("effect A writes a signal whose effect B throws; A still re-subscribes", () => {
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    const s1 = signal(0);
    const s2 = signal(0);
    const spyA = vi.fn();
    effect(() => {
      spyA(s1.value);
      s2.value = s1.value * 10;
      return undefined;
    });
    effect(() => {
      if (s2.value > 0) {
        throw new Error("B-throws");
      }
      return undefined;
    });
    spyA.mockClear();
    s1.value = 1;
    spyA.mockClear();
    s1.value = 2;
    expect(spyA).toHaveBeenCalledWith(2);
    setEffectErrorHandler(prev);
  });
});

describe("pathological graphs with throwing callbacks", () => {
  it("diamond: one branch's effect throws, the join effect still subscribes", () => {
    withHandler((errors) => {
      const root = signal(0);
      const left = computed(() => root.value + 1);
      const right = computed(() => root.value + 2);
      const log: string[] = [];
      effect(() => {
        if (left.value > 1) {
          throw new Error("L-boom");
        }
        return undefined;
      });
      effect(() => {
        log.push(`${left.value}+${right.value}`);
        return undefined;
      });
      log.length = 0;
      errors.length = 0;
      root.value = 1;
      expect(errors.length).toBe(1);
      expect(log).toContain("2+3");
      log.length = 0;
      root.value = 2;
      expect(log).toContain("3+4");
    });
  });

  it("diamond: a throwing computed branch is caught in the join, which still resolves", () => {
    withHandler(() => {
      const root = signal(0);
      const cL = computed(() => {
        if (root.value > 0) {
          throw new Error("cL");
        }
        return root.value;
      });
      const cR = computed(() => root.value * 10);
      const join = computed(() => {
        let l: number;
        try {
          l = cL.value;
        } catch {
          l = -1;
        }
        return l + cR.value;
      });
      const log: number[] = [];
      effect(() => {
        log.push(join.value);
        return undefined;
      });
      log.length = 0;
      root.value = 1;
      expect(log).toContain(-1 + 10); // 9
      log.length = 0;
      root.value = -1;
      expect(log).toContain(-1 + -10); // -11
    });
  });

  it("computed throwing mid-tracking keeps its deps so it can retry and recover", () => {
    withHandler(() => {
      const a = signal(1);
      const b = signal(2);
      let shouldThrow = false;
      const c = computed(() => {
        const av = a.value; // subscribes to a
        if (shouldThrow) {
          throw new Error("mid-track");
        }
        return av + b.value; // subscribes to b only if no throw
      });
      const spy = vi.fn();
      effect(() => {
        try {
          spy(c.value);
        } catch {
          spy("err");
        }
        return undefined;
      });
      expect(spy).toHaveBeenCalledWith(3);
      shouldThrow = true;
      spy.mockClear();
      a.value = 10; // recompute throws mid-track
      expect(spy).toHaveBeenCalledWith("err");
      // The computed kept its old deps (a, b), so once it stops throwing a
      // later change to b triggers a recompute and the effect sees the value.
      shouldThrow = false;
      spy.mockClear();
      b.value = 20;
      expect(spy).toHaveBeenCalledWith(30); // a=10, b=20
    });
  });

  it("batch with 3 computeds where the middle throws: the others still propagate", () => {
    withHandler(() => {
      const s = signal(0);
      const c1 = computed(() => s.value + 1);
      const c2 = computed(() => {
        if (s.value > 0) {
          throw new Error("c2-batch");
        }
        return s.value + 2;
      });
      const c3 = computed(() => s.value + 3);
      const log1: number[] = [];
      const log2: string[] = [];
      const log3: number[] = [];
      effect(() => {
        log1.push(c1.value);
        return undefined;
      });
      effect(() => {
        try {
          log2.push(`v=${c2.value}`);
        } catch {
          log2.push("err");
        }
        return undefined;
      });
      effect(() => {
        log3.push(c3.value);
        return undefined;
      });
      log1.length = 0;
      log2.length = 0;
      log3.length = 0;
      batch(() => {
        s.value = 5;
      });
      expect(log1).toContain(6);
      expect(log2).toContain("err");
      expect(log3).toContain(8);
    });
  });
});

describe("signal equals throw inside a nested batch", () => {
  it("restores batch state so the next write flushes immediately", () => {
    const s = signal(0, {
      equals: (_a, b) => {
        if (b === 100) {
          throw new Error("deep-eq");
        }
        return _a === b;
      },
    });
    const spy = vi.fn();
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    expect(() => {
      batch(() =>
        batch(() =>
          batch(() => {
            s.value = 100;
          }),
        ),
      );
    }).toThrow("deep-eq");
    spy.mockClear();
    s.value = 7;
    expect(spy).toHaveBeenCalledWith(7);
    setEffectErrorHandler(prev);
  });
});

describe("bounded re-dispatch from the error handler", () => {
  it("a handler that writes back to the signal terminates (no infinite loop)", () => {
    const s = signal(0);
    let writeCount = 0;
    const prev = setEffectErrorHandler(() => {
      // Write back to the signal, but only a few times.
      if (writeCount < 5) {
        writeCount++;
        s.value = s.peek() + 1;
      }
    });
    effect(() => {
      if (s.value > 0 && s.value < 10) {
        throw new Error("loop-test");
      }
      return undefined;
    });
    s.value = 1;
    expect(writeCount).toBe(5);
    expect(s.peek()).toBe(6); // 1 + 5 increments
    setEffectErrorHandler(prev);
  });
});

describe("recovery preserves tracking and subscription", () => {
  it("an effect that throws still tracks its other dependencies afterward", () => {
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    const s = signal(0);
    const t = signal(100);
    const spy = vi.fn();
    effect(() => {
      const sv = s.value;
      if (sv === 1) {
        throw new Error("track-corrupt?");
      }
      spy(sv + t.value);
    });
    spy.mockClear();
    s.value = 1; // throws
    spy.mockClear();
    s.value = 0; // recovers
    expect(spy).toHaveBeenCalled();
    spy.mockClear();
    t.value = 200; // the other dependency is still tracked
    expect(spy).toHaveBeenCalledWith(200);
    setEffectErrorHandler(prev);
  });

  it("an effect that throws on its first run still subscribes for retry", () => {
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    const s = signal(1);
    const spy = vi.fn();
    effect(() => {
      if (s.value === 1) {
        throw new Error("first-run-die");
      }
      spy(s.value);
    });
    expect(spy).not.toHaveBeenCalled();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
    setEffectErrorHandler(prev);
  });
});

describe("exception safety", () => {
  it("effect body throw: other effects still run, later flush works", () => {
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    const s = signal(0);
    const spy1 = vi.fn();
    const spy2 = vi.fn();
    effect(() => {
      if (s.value > 0) {
        throw new Error("boom");
      }
      spy1(s.value);
    });
    effect(() => {
      spy2(s.value);
    });
    spy1.mockClear();
    spy2.mockClear();
    s.value = 1;
    // spy1 threw, but spy2 should still fire
    expect(spy2).toHaveBeenCalledWith(1);
    // Now recover
    s.value = 0;
    expect(spy1).toHaveBeenCalledWith(0);
    setEffectErrorHandler(prev);
  });

  it("cleanup throw: effect still re-runs, no stuck flags", () => {
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    const s = signal(0);
    const spy = vi.fn();
    let throwInCleanup = false;
    effect(() => {
      spy(s.value);
      return () => {
        if (throwInCleanup) {
          throw new Error("cleanup-boom");
        }
      };
    });
    spy.mockClear();
    throwInCleanup = true;
    s.value = 1;
    // Effect still runs despite cleanup throw
    expect(spy).toHaveBeenCalledWith(1);
    throwInCleanup = false;
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
    setEffectErrorHandler(prev);
  });

  it("user equals throw: successful value still stored, not poisoned as an error", () => {
    let throwInEquals = false;
    const s = signal(0);
    const c = computed(() => s.value * 2, {
      equals: (_a, _b) => {
        if (throwInEquals) {
          throw new Error("eq-boom");
        }
        return false; // always changed
      },
    });
    expect(c.value).toBe(0);
    throwInEquals = true;
    s.value = 5;
    // Despite equals throwing, the value should be the new successful computation
    expect(c.value).toBe(10);
    throwInEquals = false;
    s.value = 6;
    expect(c.value).toBe(12);
  });

  it("multiple effects throw mid-flush: all execute, system stable after", () => {
    const errors: unknown[] = [];
    const prev = setEffectErrorHandler((e) => {
      errors.push(e);
    });
    const s = signal(0);
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      effect(() => {
        if (s.value > 0 && idx % 2 === 0) {
          throw new Error(`err-${idx}`);
        }
        results.push(s.value + idx);
      });
    }
    results.length = 0;
    s.value = 1;
    // Odd-indexed effects should have run successfully
    expect(results).toContain(2); // idx=1: 1+1
    expect(results).toContain(4); // idx=3: 1+3
    // System still works
    s.value = 0;
    expect(results).toContain(0);
    setEffectErrorHandler(prev);
  });

  it("exception in computed does not prevent other downstream effects from running", () => {
    const prev = setEffectErrorHandler(() => {
      /* swallow */
    });
    const s = signal(1);
    let throwInC = false;
    const c = computed(() => {
      if (throwInC) {
        throw new Error("c-err");
      }
      return s.value;
    });
    const spy = vi.fn();
    // Effect that reads c (will catch error)
    effect(() => {
      try {
        spy(c.value);
      } catch {
        spy("error");
      }
    });
    // Another independent effect
    const spy2 = vi.fn();
    effect(() => {
      spy2(s.value);
    });
    spy.mockClear();
    spy2.mockClear();
    throwInC = true;
    s.value = 2;
    expect(spy).toHaveBeenCalledWith("error");
    expect(spy2).toHaveBeenCalledWith(2);
    setEffectErrorHandler(prev);
  });
});
