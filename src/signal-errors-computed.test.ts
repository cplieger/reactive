// Reactive signal core — exception safety on the derivation side: the graph
// stays consistent when a computed fn or a custom equals comparator throws.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signal, effect, batch, computed, setEffectErrorHandler } from "./index.js";
import type { EffectErrorHandler, ReadonlySignal } from "./index.js";

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

describe("computed: cycle detection", () => {
  it("reading a computed that reads itself throws Cycle detected", () => {
    const c: ReadonlySignal<number> = computed(() => c.value + 1);
    expect(() => c.value).toThrow("Cycle detected");
  });

  it("peek on a self-referential computed also throws Cycle detected", () => {
    const c: ReadonlySignal<number> = computed(() => c.value + 1);
    expect(() => c.peek()).toThrow("Cycle detected");
  });

  it("an indirect cycle a -> b -> a throws Cycle detected", () => {
    const a: ReadonlySignal<number> = computed(() => b.value + 1);
    const b: ReadonlySignal<number> = computed(() => a.value + 1);
    expect(() => a.value).toThrow("Cycle detected");
  });

  it("the graph remains usable after a cycle is hit", () => {
    const c: ReadonlySignal<number> = computed(() => c.value + 1);
    expect(() => c.value).toThrow("Cycle detected");
    const s = signal(2);
    const ok = computed(() => s.value * 10);
    expect(ok.value).toBe(20);
    s.value = 3;
    expect(ok.value).toBe(30);
  });
});
