// Reactive signal core: signal / effect / batch / computed / untracked /
// subscribe / on / type guards / equality semantics.
import { describe, it, expect, vi } from "vitest";
import {
  signal,
  effect,
  batch,
  computed,
  untracked,
  subscribe,
  isSignal,
  isComputed,
  setEffectErrorHandler,
  on,
} from "./index.js";
import type { ReadonlySignal } from "./index.js";

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
    effect(() => {
      results.push(s.value);
    });
    batch(() => {
      s.value = 42;
    });
    // Effect should have already run synchronously
    expect(results).toEqual([0, 42]);
  });
});

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

  it("chains computed signals", () => {
    expect.assertions(1);
    const a = signal(1);
    const b = computed(() => a.value * 2);
    const c = computed(() => b.value + 10);
    expect(c.value).toBe(12);
  });
});

describe("computed: diamond / glitch-freedom", () => {
  it("does not notify downstream when computed value is unchanged", () => {
    const a = signal(1);
    const isPositive = computed(() => a.value > 0);
    const spy = vi.fn();
    effect(() => {
      spy(isPositive.value);
    });
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
    effect(() => {
      spy(combined.value);
    });
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
    effect(() => {
      spy(sum.value);
    });
    spy.mockClear();
    batch(() => {
      a.value = 1;
      b.value = 1;
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("deep chain: single propagation through 10-level computed chain", () => {
    const s = signal(0);
    const chain: ReturnType<typeof computed<number>>[] = [];
    let prev: { readonly value: number } = s;
    for (let i = 0; i < 10; i++) {
      const src = prev;
      const c = computed(() => src.value + 1);
      chain.push(c);
      prev = c;
    }
    const spy = vi.fn();
    effect(() => {
      spy(prev.value);
    });
    expect(spy).toHaveBeenCalledWith(10);
    spy.mockClear();
    s.value = 1;
    // Effect fires exactly once with correct end value
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(11);
  });

  it("wide fan-out: one signal → 50 effects, each fires once", () => {
    const s = signal(0);
    const spies: ReturnType<typeof vi.fn>[] = [];
    for (let i = 0; i < 50; i++) {
      const spy = vi.fn();
      spies.push(spy);
      effect(() => {
        spy(s.value);
      });
    }
    for (const spy of spies) {
      spy.mockClear();
    }
    s.value = 1;
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(1);
    }
  });

  it("diamond with conditional dep: no glitch when dep is dropped", () => {
    const a = signal(1);
    const cond = signal(true);
    const b = computed(() => a.value * 2);
    const c = computed(() => (cond.value ? b.value : 0));
    const spy = vi.fn();
    effect(() => {
      spy(c.value);
    });
    expect(spy).toHaveBeenLastCalledWith(2);
    spy.mockClear();
    // Drop dep on b
    cond.value = false;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(0);
    spy.mockClear();
    // Changing a should NOT trigger c (b is no longer a dep)
    a.value = 100;
    expect(spy).not.toHaveBeenCalled();
  });

  it("multi-diamond: two shared sources converging", () => {
    const x = signal(1);
    const y = signal(2);
    const a = computed(() => x.value + y.value); // 3
    const b = computed(() => x.value * y.value); // 2
    const c = computed(() => a.value + b.value); // 5
    const spy = vi.fn();
    effect(() => {
      spy(c.value);
    });
    expect(spy).toHaveBeenLastCalledWith(5);
    spy.mockClear();
    batch(() => {
      x.value = 3;
      y.value = 4;
    });
    // a=7, b=12, c=19 — effect fires once
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(19);
  });

  it("wide diamond: many computeds from same source converge once", () => {
    const src = signal(0);
    const branches = Array.from({ length: 10 }, (_, i) => computed(() => src.value + i));
    const sum = computed(() => branches.reduce((acc, b) => acc + b.value, 0));
    const spy = vi.fn();
    effect(() => {
      spy(sum.value);
      return undefined;
    });
    spy.mockClear();
    src.value = 1;
    expect(spy).toHaveBeenCalledTimes(1);
    // sum = (1+0)+(1+1)+...+(1+9) = 10 + 45 = 55
    expect(spy).toHaveBeenCalledWith(55);
  });
});

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

  it("a detected cycle does not leave the system broken", () => {
    // eslint-disable-next-line prefer-const
    let c2: { readonly value: number };
    const c1 = computed(() => (c2 as { readonly value: number }).value + 1);
    c2 = computed(() => c1.value + 1);
    expect(() => c1.value).toThrow("Cycle detected");
    // An unrelated signal/effect must still work after the cycle throw.
    const s = signal(42);
    const spy = vi.fn();
    const prev = setEffectErrorHandler(() => {
      /* swallow */
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

describe("computed: error caching", () => {
  it("caches thrown error and rethrows on subsequent reads", () => {
    let count = 0;
    const c = computed(() => {
      count++;
      throw new Error("fail");
    });
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
    const prev = setEffectErrorHandler((e) => {
      errors.push(e);
    });
    effect(() => {
      void c.value;
    });
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("boom");
    setEffectErrorHandler(prev);
  });
});

describe("computed: setter throws", () => {
  it("throws when setting .value on computed", () => {
    const c = computed(() => 42);
    expect(() => {
      (c as { value: number }).value = 99;
    }).toThrow("Cannot set a computed signal");
  });
});

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

  it("restores context on throw", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      try {
        untracked(() => {
          throw new Error("x");
        });
      } catch {
        // swallow
      }
      spy(s.value); // This should track s
    });
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledWith(1);
  });

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
    effect(() => {
      spy(c.value);
      return undefined;
    });
    expect(spy).toHaveBeenCalledWith(3);
    spy.mockClear();
    b.value = 99; // not tracked by computed
    expect(spy).not.toHaveBeenCalled();
    a.value = 10;
    expect(spy).toHaveBeenCalledWith(109); // 10 + 99
  });
});

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

  it("runs cb untracked: other signals read inside cb are not dependencies", () => {
    // Upstream preactjs/signals#188 semantics, harvested by the 2026-07 drift
    // audit: pre-fix, `other.value` read inside cb subscribed the effect to
    // `other`, so writing `other` re-fired the subscription.
    const s = signal(1);
    const other = signal(10);
    const seen: number[] = [];
    subscribe(s, (v) => {
      seen.push(v + other.value);
    });
    expect(seen).toEqual([11]);
    other.value = 100; // must NOT re-fire the subscription
    expect(seen).toEqual([11]);
    s.value = 2; // still fires on the subscribed signal (reads fresh `other`)
    expect(seen).toEqual([11, 102]);
  });
});

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

describe("custom equality comparator", () => {
  it("signal with custom equals suppresses notification", () => {
    const s = signal({ x: 1, y: 2 }, { equals: (a, b) => a.x === b.x });
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
    spy.mockClear();
    s.value = { x: 1, y: 99 }; // same x, different y — should NOT notify
    expect(spy).not.toHaveBeenCalled();
  });

  it("signal with custom equals allows notification when not equal", () => {
    const s = signal({ x: 1 }, { equals: (a, b) => a.x === b.x });
    const spy = vi.fn();
    effect(() => {
      spy(s.value.x);
    });
    spy.mockClear();
    s.value = { x: 2 };
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("signal with equals: false always notifies", () => {
    const s = signal(1, { equals: false });
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
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
    effect(() => {
      spy(c.value.rounded);
    });
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
    effect(() => {
      spy(c.value);
    });
    spy.mockClear();
    s.value = 2; // still true, but equals:false → notify
    expect(spy).toHaveBeenCalled();
  });
});

describe("on", () => {
  it("tracks only explicit deps, not body reads", () => {
    const a = signal(1);
    const b = signal(10);
    const spy = vi.fn();
    effect(
      on(
        () => a.value,
        (v) => {
          spy(v, b.value);
          return undefined;
        },
      ),
    );
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
    effect(
      on([() => a.value, () => b.value], (vals) => {
        spy(vals);
        return undefined;
      }),
    );
    expect(spy).toHaveBeenCalledWith([1, 2]);
    spy.mockClear();
    a.value = 10;
    expect(spy).toHaveBeenCalledWith([10, 2]);
  });

  it("defer option skips first execution", () => {
    const a = signal(1);
    const spy = vi.fn();
    effect(
      on(
        () => a.value,
        (v) => {
          spy(v);
          return undefined;
        },
        { defer: true },
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    a.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("provides prev value and prev result", () => {
    const s = signal(1);
    const results: unknown[] = [];
    effect(
      on(
        () => s.value,
        (val, prev, prevResult) => {
          results.push({ val, prev, prevResult });
          return () => {
            /* cleanup */
          };
        },
      ),
    );
    s.value = 2;
    s.value = 3;
    expect(results).toEqual([
      { val: 1, prev: undefined, prevResult: undefined },
      { val: 2, prev: 1, prevResult: expect.any(Function) },
      { val: 3, prev: 2, prevResult: expect.any(Function) },
    ]);
  });

  it("non-defer return type is U; defer form widens to U | undefined (type-level)", () => {
    // Non-deferred single-accessor: accessor return is U (number), not U | undefined.
    const nonDefer = on(
      () => 1,
      (v) => v * 2,
    );
    const r1: number = nonDefer();
    expect(r1).toBe(2);

    // Array form is likewise non-undefined and correlates value to unknown[].
    const arr = on([() => 1, () => 2], (vals) => vals.length);
    const r2: number = arr();
    expect(r2).toBe(2);

    // Deferred form widens to U | undefined: the assignment to `number` must fail.
    const deferred = on(
      () => 1,
      (v) => v * 2,
      { defer: true },
    );
    // @ts-expect-error defer form returns U | undefined, not assignable to number
    const r3: number = deferred();
    expect(r3).toBeUndefined();
  });

  it("empty array deps: runs once and never re-triggers", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(
      on([] as (() => unknown)[], (vals) => {
        // Read s inside body (not tracked, because on() runs fn untracked)
        spy(vals, s.value);
        return undefined;
      }),
    );
    expect(spy).toHaveBeenCalledWith([], 0);
    spy.mockClear();
    s.value = 1;
    expect(spy).not.toHaveBeenCalled();
  });

  it("single dep returning undefined fires with undefined", () => {
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
