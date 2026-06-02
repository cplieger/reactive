// @vitest-environment happy-dom
// RED-TEAM round-6 — convergence verification
// Attacks: re-entrant writes during throw, computed recompute exception during
// batch flush with downstream effects, multiple independent throwers in one
// flush, throw then immediate new dispatch, equals throwing in signal setter,
// dispose() in error handler, diamond with dual throwing computeds.
import { describe, it, expect, vi } from "vitest";
import { signal, effect, batch, computed, setEffectErrorHandler } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 1. Re-entrant signal write inside effectErrorHandler during flush
// ---------------------------------------------------------------------------
describe("re-entrant write inside effectErrorHandler during flush", () => {
  it("handler writes to another signal — downstream effect runs after flush", () => {
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

  it("handler writes during batch — effects flush at batch end", () => {
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
});

// ---------------------------------------------------------------------------
// 2. Exception in computed recompute during batch flush with downstream effects
// ---------------------------------------------------------------------------
describe("computed recompute throws during batch flush with downstream", () => {
  it("throwing computed doesn't prevent downstream effects from running", () => {
    withHandler((_errors) => {
      const s = signal(0);
      const bad = computed(() => {
        if (s.value > 0) {
          throw new Error("computed-recompute-boom");
        }
        return s.value;
      });
      const good = computed(() => s.value * 10);
      const logBad: string[] = [];
      const logGood: number[] = [];
      effect(() => {
        try {
          logBad.push(`v=${bad.value}`);
        } catch (_e) {
          logBad.push("err");
        }
        return undefined;
      });
      effect(() => {
        logGood.push(good.value);
        return undefined;
      });
      logBad.length = 0;
      logGood.length = 0;
      batch(() => {
        s.value = 5;
      });
      expect(logBad).toContain("err");
      expect(logGood).toContain(50);
    });
  });

  it("computed throws then recovers — effect tracks again", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
    });
    const s = signal(0);
    let shouldThrow = false;
    const c = computed(() => {
      if (shouldThrow) {
        throw new Error("temp-fail");
      }
      return s.value * 2;
    });
    const log: string[] = [];
    effect(() => {
      try {
        log.push(`v=${c.value}`);
      } catch (_e) {
        log.push("err");
      }
      return undefined;
    });
    shouldThrow = true;
    s.value = 1;
    shouldThrow = false;
    s.value = 2;
    setEffectErrorHandler(prev);
    expect(log).toContain("v=4"); // recovered
  });
});

// ---------------------------------------------------------------------------
// 3. Multiple independent throwers in one flush
// ---------------------------------------------------------------------------
describe("multiple independent throwers in one flush", () => {
  it("10 effects all throw — all are caught, system is stable after", () => {
    withHandler((errors) => {
      const s = signal(0);
      const spies: ReturnType<typeof vi.fn>[] = [];
      for (let i = 0; i < 10; i++) {
        const spy = vi.fn();
        spies.push(spy);
        effect(() => {
          spy(s.value);
          if (s.value > 0) {
            throw new Error(`multi-throw-${i}`);
          }
          return undefined;
        });
      }
      for (const spy of spies) {
        spy.mockClear();
      }
      errors.length = 0;
      s.value = 1;
      expect(errors.length).toBe(10);
      for (const spy of spies) {
        expect(spy).toHaveBeenCalledWith(1);
      }
      // System stable: all re-subscribe and can run again
      for (const spy of spies) {
        spy.mockClear();
      }
      errors.length = 0;
      s.value = 2;
      expect(errors.length).toBe(10);
      for (const spy of spies) {
        expect(spy).toHaveBeenCalledWith(2);
      }
    });
  });

  it("mix: some throw, some don't — non-throwers run correctly", () => {
    withHandler((errors) => {
      const s = signal(0);
      const goodSpy = vi.fn();
      const badSpy = vi.fn();
      effect(() => {
        badSpy(s.value);
        if (s.value > 0) {
          throw new Error("bad");
        }
        return undefined;
      });
      effect(() => {
        goodSpy(s.value);
        return undefined;
      });
      goodSpy.mockClear();
      badSpy.mockClear();
      errors.length = 0;
      s.value = 5;
      expect(goodSpy).toHaveBeenCalledWith(5);
      expect(badSpy).toHaveBeenCalledWith(5);
      expect(errors.length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Throw then immediate new dispatch
// ---------------------------------------------------------------------------
describe("throw then immediate new dispatch", () => {
  it("write after a throwing flush works correctly", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
    });
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      if (s.value === 1) {
        throw new Error("first-throw");
      }
      return undefined;
    });
    spy.mockClear();
    s.value = 1; // throws inside effect
    spy.mockClear();
    s.value = 2; // must still work
    expect(spy).toHaveBeenCalledWith(2);
    setEffectErrorHandler(prev);
  });

  it("batch, throw, then immediate non-batch write", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
    });
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      if (s.value === 10) {
        throw new Error("batch-throw");
      }
      return undefined;
    });
    spy.mockClear();
    batch(() => {
      s.value = 10;
    });
    spy.mockClear();
    s.value = 20;
    expect(spy).toHaveBeenCalledWith(20);
    setEffectErrorHandler(prev);
  });

  it("rapid alternating throw/no-throw", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
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
});

// ---------------------------------------------------------------------------
// 5. Signal equals function throwing (from user code writing to signal)
// ---------------------------------------------------------------------------
describe("signal equals function throwing", () => {
  it("equals throw propagates to caller but doesn't corrupt system", () => {
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
      // swallow
    });
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    expect(() => {
      s.value = 5;
    }).toThrow("equals-boom");
    expect(s.peek()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    s.value = 3;
    expect(spy).toHaveBeenCalledWith(3);
    expect(s.peek()).toBe(3);
    setEffectErrorHandler(prev);
  });

  it("equals throw during batch doesn't corrupt batchDepth", () => {
    const s = signal(0, {
      equals: (_a, b) => {
        if (b === 99) {
          throw new Error("eq-batch");
        }
        return false;
      },
    });
    const spy = vi.fn();
    const prev = setEffectErrorHandler(() => {
      // swallow
    });
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    expect(() =>
      batch(() => {
        s.value = 99;
      }),
    ).toThrow("eq-batch");
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledWith(1);
    setEffectErrorHandler(prev);
  });
});

// ---------------------------------------------------------------------------
// 6. Dispose inside error handler
// ---------------------------------------------------------------------------
describe("dispose inside error handler", () => {
  it("handler disposes the throwing effect — no zombie", () => {
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

  it("handler disposes another effect during flush", () => {
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

// ---------------------------------------------------------------------------
// 7. Diamond with dual throwing computeds
// ---------------------------------------------------------------------------
describe("diamond with dual throwing computeds", () => {
  it("both branches throw — effect sees errors from both", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
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
    // Recovery
    log.length = 0;
    root.value = -1;
    expect(log.some((entry) => entry === "ok")).toBe(true);
    setEffectErrorHandler(prev);
  });
});

// ---------------------------------------------------------------------------
// 8. Nested batch where inner batch callback throws
// ---------------------------------------------------------------------------
describe("nested batch inner throw", () => {
  it("inner batch throws — outer batch still flushes", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
    });
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    expect(() => {
      batch(() => {
        s.value = 10;
        batch(() => {
          throw new Error("inner-batch-throw");
        });
      });
    }).toThrow("inner-batch-throw");
    spy.mockClear();
    s.value = 20;
    expect(spy).toHaveBeenCalledWith(20);
    setEffectErrorHandler(prev);
  });

  it("outer batch throws after inner batch — batchDepth correct", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
    });
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    expect(() => {
      batch(() => {
        batch(() => {
          s.value = 5;
        });
        throw new Error("outer-throw");
      });
    }).toThrow("outer-throw");
    spy.mockClear();
    s.value = 6;
    expect(spy).toHaveBeenCalledWith(6);
    setEffectErrorHandler(prev);
  });
});

// ---------------------------------------------------------------------------
// 9. Effect body writes to signal that triggers other effects — one throws
// ---------------------------------------------------------------------------
describe("effect body writes trigger cascade with throw", () => {
  it("effect A writes to s2, effect B on s2 throws — A still re-subscribes", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
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

// ---------------------------------------------------------------------------
// 10. Verify flushing flag is never stuck (direct invariant check)
// ---------------------------------------------------------------------------
describe("flushing invariant is never stuck", () => {
  it("after many throws, flushing is false (flushSync works)", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
    });
    const s = signal(0);
    for (let i = 0; i < 50; i++) {
      effect(() => {
        if (s.value > 0) {
          throw new Error(`stuck-${i}`);
        }
        return undefined;
      });
    }
    s.value = 1;
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
    setEffectErrorHandler(prev);
  });

  it("batch with only throwing effects — batchDepth returns to 0", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
    });
    const s = signal(0);
    effect(() => {
      if (s.value > 0) {
        throw new Error("batch-stuck");
      }
      return undefined;
    });
    batch(() => {
      s.value = 1;
    });
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    s.value = 99;
    expect(spy).toHaveBeenCalledWith(99);
    setEffectErrorHandler(prev);
  });
});

// ---------------------------------------------------------------------------
// 11. Computed cycle detection doesn't corrupt state
// ---------------------------------------------------------------------------
describe("computed cycle detection", () => {
  it("cycle throws on access but doesn't leave system broken", () => {
    // eslint-disable-next-line prefer-const
    let c2: { readonly value: number };
    const c1 = computed(() => (c2 as { readonly value: number }).value + 1);
    c2 = computed(() => c1.value + 1);
    expect(() => c1.value).toThrow("Cycle detected");
    const s = signal(42);
    const spy = vi.fn();
    const prev = setEffectErrorHandler(() => {
      // swallow
    });
    const d = effect(() => {
      spy(s.value);
      return undefined;
    });
    spy.mockClear();
    s.value = 100;
    expect(spy).toHaveBeenCalledWith(100);
    d();
    setEffectErrorHandler(prev);
  });
});

// ---------------------------------------------------------------------------
// 12. Cleanup writes to signal (re-entrant during flush)
// ---------------------------------------------------------------------------
describe("cleanup writes to signal during flush", () => {
  it("cleanup writes to a signal — downstream effect picks it up", () => {
    const prev = setEffectErrorHandler(() => {
      // swallow
    });
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
    setEffectErrorHandler(prev);
  });
});
