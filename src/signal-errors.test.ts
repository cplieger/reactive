// Reactive signal core — exception safety on the effect side: the graph stays
// consistent when an effect body or a cleanup throws, including during batch
// flushing, dispose, and high-volume cleanup/re-entrant paths.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signal, effect, batch, computed, setEffectErrorHandler } from "./index.js";
import type { EffectErrorHandler } from "./index.js";

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
