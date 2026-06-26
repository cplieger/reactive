// Reactive signal core — exception safety on the routing/recovery side: the
// graph stays consistent when the error handler, a subscribe callback, or a
// pathological throwing graph misbehaves, and recovers afterward.
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
