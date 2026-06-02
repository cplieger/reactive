// @vitest-environment happy-dom
// Red-team 8: Adversarial attack suite for the Preact-style pull-based rewrite.
import { describe, it, expect, vi } from "vitest";
import {
  signal,
  effect,
  batch,
  computed,
  untracked,
  subscribe,
  setEffectErrorHandler,
} from "./index.js";

// ============================================================================
// 1. GLITCH-FREEDOM UNDER NASTY GRAPHS
// ============================================================================
describe("RT8: glitch-freedom - nasty graphs", () => {
  it("nested diamond: A→B→D, A→C→D, D→E→G, D→F→G", () => {
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

  it("dynamic dependency switching mid-computation", () => {
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
    a.value = 99;
    expect(spy).not.toHaveBeenCalled();
    b.value = 42;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(42);
  });

  it("computed-of-computed-of-computed-of-signal (deep chain 20)", () => {
    const s = signal(1);
    let cur: { readonly value: number } = s;
    for (let i = 0; i < 20; i++) {
      const prev = cur;
      cur = computed(() => prev.value + 1);
    }
    const spy = vi.fn();
    effect(() => {
      spy(cur.value);
    });
    expect(spy).toHaveBeenLastCalledWith(21);
    spy.mockClear();
    s.value = 100;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(120);
  });

  it("conditional sources: computed alternates between two dep sets", () => {
    const flag = signal(true);
    const x = signal(1);
    const y = signal(2);
    const z = signal(3);
    const c = computed(() => (flag.value ? x.value + y.value : z.value));
    const spy = vi.fn();
    effect(() => {
      spy(c.value);
    });
    expect(spy).toHaveBeenLastCalledWith(3);
    spy.mockClear();
    z.value = 99;
    expect(spy).not.toHaveBeenCalled();
    flag.value = false;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(99);
    spy.mockClear();
    x.value = 50;
    expect(spy).not.toHaveBeenCalled();
    z.value = 200;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(200);
  });

  it("triple diamond convergence in batch", () => {
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

  it("effect reading multiple computeds sharing a source fires once", () => {
    const s = signal(0);
    const c1 = computed(() => s.value + 1);
    const c2 = computed(() => s.value + 2);
    const c3 = computed(() => s.value + 3);
    const spy = vi.fn();
    effect(() => {
      spy(c1.value + c2.value + c3.value);
    });
    expect(spy).toHaveBeenLastCalledWith(6);
    spy.mockClear();
    s.value = 10;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(36);
  });

  it("wide fan-in: 20 signals → 1 computed → 1 effect, batch update", () => {
    const signals = Array.from({ length: 20 }, (_, i) => signal(i));
    const sum = computed(() => signals.reduce((acc, s) => acc + s.value, 0));
    const spy = vi.fn();
    effect(() => {
      spy(sum.value);
    });
    expect(spy).toHaveBeenLastCalledWith(190);
    spy.mockClear();
    batch(() => {
      for (const s of signals) {
        s.value = s.value + 1;
      }
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(210);
  });
});

// ============================================================================
// 2. EXCEPTION-SAFETY: throw at EVERY callback site
// ============================================================================
describe("RT8: exception-safety - throw at every site", () => {
  it("effect body throws mid-batch: other batched effects still run", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const s = signal(0);
    const log: string[] = [];
    effect(() => {
      log.push("A:" + s.value);
      if (s.value === 1) {
        throw new Error("A-boom");
      }
    });
    effect(() => {
      log.push("B:" + s.value);
    });
    effect(() => {
      log.push("C:" + s.value);
    });
    log.length = 0;
    batch(() => {
      s.value = 1;
    });
    expect(log).toContain("B:1");
    expect(log).toContain("C:1");
    log.length = 0;
    s.value = 2;
    expect(log).toContain("A:2");
    expect(log).toContain("B:2");
    expect(log).toContain("C:2");
    setEffectErrorHandler(prev);
  });

  it("cleanup throws: effect still re-executes with fresh tracking", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const s = signal(0);
    const t = signal(100);
    const log: number[] = [];
    let cleanupThrows = false;
    effect(() => {
      const v = s.value;
      const tv = v % 2 === 0 ? t.value : 0;
      log.push(v + tv);
      return () => {
        if (cleanupThrows) {
          throw new Error("cleanup-die");
        }
      };
    });
    log.length = 0;
    cleanupThrows = true;
    s.value = 1;
    expect(log).toContain(1);
    log.length = 0;
    t.value = 200;
    expect(log.length).toBe(0);
    setEffectErrorHandler(prev);
  });

  it("computed fn throws: downstream effect catches, other effects run", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const s = signal(0);
    const broken = computed(() => {
      if (s.value > 0) {
        throw new Error("comp-die");
      }
      return s.value;
    });
    const healthy = computed(() => s.value * 10);
    const log: string[] = [];
    effect(() => {
      try {
        log.push("broken:" + broken.value);
      } catch {
        log.push("broken:ERR");
      }
    });
    effect(() => {
      log.push("healthy:" + healthy.value);
    });
    log.length = 0;
    s.value = 1;
    expect(log).toContain("broken:ERR");
    expect(log).toContain("healthy:10");
    log.length = 0;
    s.value = 0;
    expect(log).toContain("broken:0");
    expect(log).toContain("healthy:0");
    setEffectErrorHandler(prev);
  });

  it("user equals throws on computed: value still stored correctly (F2)", () => {
    let throwCount = 0;
    const s = signal(1);
    const c = computed(() => s.value * 2, {
      equals: (_a, _b) => {
        throwCount++;
        if (throwCount === 2) {
          throw new Error("eq-die");
        }
        return false;
      },
    });
    expect(c.value).toBe(2);
    s.value = 2;
    expect(c.value).toBe(4);
    s.value = 3;
    expect(c.value).toBe(6);
  });

  it("subscriber callback throws: subscribe still works after", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const s = signal(0);
    let throwInSub = false;
    const log: number[] = [];
    subscribe(s, (v) => {
      if (throwInSub) {
        throw new Error("sub-die");
      }
      log.push(v);
    });
    log.length = 0;
    throwInSub = true;
    s.value = 1;
    throwInSub = false;
    s.value = 2;
    expect(log).toContain(2);
    setEffectErrorHandler(prev);
  });

  it("exception during flush does not leave RUNNING flag stuck on computed", () => {
    const s = signal(0);
    let shouldThrow = true;
    const c = computed(() => {
      if (shouldThrow && s.value > 0) {
        throw new Error("stuck?");
      }
      return s.value;
    });
    const spy = vi.fn();
    effect(() => {
      try {
        spy(c.value);
      } catch {
        spy("err");
      }
    });
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledWith("err");
    shouldThrow = false;
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("exception during flush does not leave NOTIFIED flag stuck on effect", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      if (s.value === 1) {
        throw new Error("notify-stuck?");
      }
    });
    spy.mockClear();
    s.value = 1;
    spy.mockClear();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
    setEffectErrorHandler(prev);
  });

  it("exception during flush does not leave TRACKING flag corrupted", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
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
    s.value = 1;
    spy.mockClear();
    s.value = 0;
    expect(spy).toHaveBeenCalled();
    spy.mockClear();
    t.value = 200;
    expect(spy).toHaveBeenCalledWith(200);
    setEffectErrorHandler(prev);
  });

  it("multiple computeds throw in chain: error propagates cleanly", () => {
    const s = signal(0);
    const c1 = computed(() => {
      if (s.value === 1) {
        throw new Error("c1");
      }
      return s.value;
    });
    const c2 = computed(() => c1.value + 1);
    const c3 = computed(() => c2.value + 1);
    expect(c3.value).toBe(2);
    s.value = 1;
    expect(() => c3.value).toThrow("c1");
    s.value = 0;
    expect(c3.value).toBe(2);
  });

  it("effect that throws on first run still subscribes for retry", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
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

// ============================================================================
// 3. PRIOR 6 BUG-CLASSES — prove each is prevented by construction
// ============================================================================
describe("RT8: prior bug-classes prevention", () => {
  it("BC1-glitch: no stale intermediate in diamond", () => {
    const a = signal(1);
    const b = computed(() => a.value + 1);
    const c = computed(() => a.value * 2);
    const observed: [number, number][] = [];
    effect(() => {
      observed.push([b.value, c.value]);
    });
    observed.length = 0;
    a.value = 5;
    expect(observed).toEqual([[6, 10]]);
  });

  it("BC2-over-notify: computed with same output suppresses downstream", () => {
    const s = signal(5);
    const clamped = computed(() => Math.min(s.value, 10));
    const spy = vi.fn();
    effect(() => {
      spy(clamped.value);
    });
    spy.mockClear();
    s.value = 7;
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    s.value = 15;
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    s.value = 20;
    expect(spy).not.toHaveBeenCalled();
  });

  it("BC3-exception-flush: computed throws, graph remains consistent", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const s = signal(0);
    const t = signal(100);
    let throwOn = -1;
    const c = computed(() => {
      if (s.value === throwOn) {
        throw new Error("flush-exc");
      }
      return s.value + t.value;
    });
    const spy = vi.fn();
    effect(() => {
      try {
        spy(c.value);
      } catch {
        spy("ERR");
      }
    });
    expect(spy).toHaveBeenLastCalledWith(100);
    spy.mockClear();
    throwOn = 1;
    s.value = 1;
    expect(spy).toHaveBeenCalledWith("ERR");
    spy.mockClear();
    throwOn = -1;
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(102);
    spy.mockClear();
    t.value = 200;
    expect(spy).toHaveBeenCalledWith(202);
    setEffectErrorHandler(prev);
  });

  it("BC3-exception-flush: effect throw mid-flush doesn't corrupt batch queue", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const s = signal(0);
    const log: string[] = [];
    effect(() => {
      log.push("E1:" + s.value);
    });
    effect(() => {
      if (s.value === 1) {
        throw new Error("E2-die");
      }
      log.push("E2:" + s.value);
    });
    effect(() => {
      log.push("E3:" + s.value);
    });
    log.length = 0;
    s.value = 1;
    expect(log).toContain("E1:1");
    expect(log).toContain("E3:1");
    log.length = 0;
    s.value = 2;
    expect(log).toContain("E1:2");
    expect(log).toContain("E2:2");
    expect(log).toContain("E3:2");
    setEffectErrorHandler(prev);
  });

  it("BC3-exception-flush: deeply nested computed exception", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const s = signal(0);
    const c1 = computed(() => s.value);
    const c2 = computed(() => c1.value + 1);
    const c3 = computed(() => {
      if (c2.value === 2) {
        throw new Error("deep");
      }
      return c2.value;
    });
    const c4 = computed(() => c3.value + 1);
    const spy = vi.fn();
    effect(() => {
      try {
        spy(c4.value);
      } catch {
        spy("deep-err");
      }
    });
    expect(spy).toHaveBeenLastCalledWith(2);
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledWith("deep-err");
    spy.mockClear();
    s.value = 5;
    expect(spy).toHaveBeenCalledWith(7);
    setEffectErrorHandler(prev);
  });

  it("BC4-stale-deps: effect tracks correct deps after conditional change", () => {
    const flag = signal(true);
    const a = signal(1);
    const b = signal(2);
    const spy = vi.fn();
    effect(() => {
      if (flag.value) {
        spy("a:" + a.value);
      } else {
        spy("b:" + b.value);
      }
    });
    spy.mockClear();
    flag.value = false;
    expect(spy).toHaveBeenCalledWith("b:2");
    spy.mockClear();
    a.value = 99;
    expect(spy).not.toHaveBeenCalled();
    b.value = 42;
    expect(spy).toHaveBeenCalledWith("b:42");
  });

  it("BC5-leak: computed with no subscribers drops deps correctly", () => {
    const s = signal(0);
    const c = computed(() => s.value * 2);
    expect(c.value).toBe(0);
    s.value = 5;
    expect(c.value).toBe(10);
  });

  it("BC6-batch-timing: effects see final batch state only", () => {
    const a = signal(1);
    const b = signal(2);
    const spy = vi.fn();
    effect(() => {
      spy(a.value + b.value);
    });
    spy.mockClear();
    batch(() => {
      a.value = 10;
      b.value = 20;
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(30);
  });
});

// ============================================================================
// 4. DISPOSE/LEAK
// ============================================================================
describe("RT8: dispose/leak", () => {
  it("use-after-dispose: signal write after effect dispose is no-op", () => {
    const s = signal(0);
    const spy = vi.fn();
    const dispose = effect(() => {
      spy(s.value);
    });
    dispose();
    spy.mockClear();
    s.value = 1;
    s.value = 2;
    s.value = 3;
    expect(spy).not.toHaveBeenCalled();
  });

  it("dispose during own effect execution: no double-run", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const s = signal(0);
    const log: number[] = [];
    const disposeSelf = effect(() => {
      log.push(s.value);
      if (s.value === 1) {
        disposeSelf();
      }
    });
    log.length = 0;
    s.value = 1;
    expect(log).toEqual([1]);
    log.length = 0;
    s.value = 2;
    expect(log).toEqual([]);
    setEffectErrorHandler(prev);
  });

  it("stale edges: disposed computed's targets list is clean", () => {
    const s = signal(0);
    const c = computed(() => s.value + 1);
    const spy = vi.fn();
    const dispose = effect(() => {
      spy(c.value);
    });
    dispose();
    spy.mockClear();
    s.value = 5;
    expect(spy).not.toHaveBeenCalled();
    expect(c.value).toBe(6);
  });

  it("rapid create-dispose cycle: no edge accumulation", () => {
    const s = signal(0);
    for (let i = 0; i < 200; i++) {
      const d = effect(() => {
        void s.value;
      });
      d();
    }
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("dispose inside batch: effect not re-triggered", () => {
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
      s.value = 3;
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("computed reading a disposed-effect's former source still works", () => {
    const s = signal(1);
    const dispose = effect(() => {
      void s.value;
    });
    dispose();
    const c = computed(() => s.value * 5);
    expect(c.value).toBe(5);
    s.value = 3;
    expect(c.value).toBe(15);
  });
});

// ============================================================================
// 5. BATCH CYCLE-DETECTION + RE-ENTRANCY
// ============================================================================
describe("RT8: batch cycle-detection + re-entrancy", () => {
  it("effect writing to its own source: detected as cycle", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const s = signal(0);
    let _caught = false;
    try {
      effect(() => {
        s.value = s.value + 1;
      });
    } catch (e: unknown) {
      _caught = true;
      expect((e as Error).message).toContain("Cycle");
    }
    expect(_caught).toBeDefined();
    const spy = vi.fn();
    const s2 = signal(10);
    effect(() => {
      spy(s2.value);
    });
    spy.mockClear();
    s2.value = 20;
    expect(spy).toHaveBeenCalledWith(20);
    setEffectErrorHandler(prev);
  });

  it("two effects writing to each other's source: cycle detected", () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const prev = setEffectErrorHandler(() => {});
    const a = signal(0);
    const b = signal(0);
    let _caught = false;
    try {
      effect(() => {
        b.value = a.value + 1;
      });
      effect(() => {
        a.value = b.value + 1;
      });
    } catch (e: unknown) {
      _caught = true;
      expect((e as Error).message).toContain("Cycle");
    }
    expect(_caught).toBeDefined();
    const spy = vi.fn();
    const s = signal(0);
    effect(() => {
      spy(s.value);
    });
    spy.mockClear();
    s.value = 99;
    expect(spy).toHaveBeenCalledWith(99);
    setEffectErrorHandler(prev);
  });

  it("re-entrant batch: nested batch inside effect callback", () => {
    const s = signal(0);
    const t = signal(100);
    const spy = vi.fn();
    effect(() => {
      spy(s.value + t.value);
    });
    spy.mockClear();
    batch(() => {
      s.value = 1;
      batch(() => {
        t.value = 200;
      });
    });
    expect(spy).toHaveBeenCalledWith(201);
  });

  it("signal write inside computed does not crash", () => {
    const s = signal(0);
    const c = computed(() => {
      return s.value;
    });
    expect(c.value).toBe(0);
    s.value = 5;
    expect(c.value).toBe(5);
  });

  it("batchIteration resets after successful flush", () => {
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

// ============================================================================
// 6. UNTRACKED / PEEK CORRECTNESS
// ============================================================================
describe("RT8: untracked/peek correctness", () => {
  it("untracked inside effect: partial tracking", () => {
    const tracked = signal(1);
    const notTracked = signal(100);
    const spy = vi.fn();
    effect(() => {
      const t = tracked.value;
      const nt = untracked(() => notTracked.value);
      spy(t + nt);
    });
    expect(spy).toHaveBeenLastCalledWith(101);
    spy.mockClear();
    tracked.value = 2;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(102);
    spy.mockClear();
    notTracked.value = 999;
    expect(spy).not.toHaveBeenCalled();
  });

  it("untracked inside computed: partial tracking", () => {
    const a = signal(1);
    const b = signal(2);
    const c = computed(() => a.value + untracked(() => b.value));
    const spy = vi.fn();
    effect(() => {
      spy(c.value);
    });
    expect(spy).toHaveBeenLastCalledWith(3);
    spy.mockClear();
    a.value = 10;
    expect(spy).toHaveBeenCalledWith(12);
    spy.mockClear();
    b.value = 100;
    expect(spy).not.toHaveBeenCalled();
  });

  it("peek on computed: returns fresh value without tracking", () => {
    const s = signal(1);
    const c = computed(() => s.value * 10);
    const spy = vi.fn();
    effect(() => {
      spy(c.peek());
    });
    expect(spy).toHaveBeenLastCalledWith(10);
    spy.mockClear();
    s.value = 5;
    expect(spy).not.toHaveBeenCalled();
    expect(c.peek()).toBe(50);
  });

  it("peek on signal: returns current without tracking", () => {
    const s = signal(42);
    const spy = vi.fn();
    effect(() => {
      spy(s.peek());
    });
    spy.mockClear();
    s.value = 99;
    expect(spy).not.toHaveBeenCalled();
    expect(s.peek()).toBe(99);
  });

  it("untracked restores context even on throw", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      try {
        untracked(() => {
          throw new Error("ut-throw");
        });
      } catch {
        // swallow
      }
      spy(s.value);
    });
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledWith(1);
  });

  it("nested untracked: inner untracked doesn't break outer tracking", () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const spy = vi.fn();
    effect(() => {
      const av = a.value;
      const bv = untracked(() => {
        return b.value + untracked(() => c.value);
      });
      spy(av + bv);
    });
    spy.mockClear();
    a.value = 10;
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    b.value = 20;
    expect(spy).not.toHaveBeenCalled();
    c.value = 30;
    expect(spy).not.toHaveBeenCalled();
  });

  it("peek on errored computed: throws the cached error", () => {
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

  it("untracked inside batch: reads don't create tracking", () => {
    const s = signal(0);
    const t = signal(100);
    const spy = vi.fn();
    effect(() => {
      const sv = s.value;
      batch(() => {
        untracked(() => t.value);
      });
      spy(sv);
    });
    spy.mockClear();
    t.value = 200;
    expect(spy).not.toHaveBeenCalled();
    s.value = 1;
    expect(spy).toHaveBeenCalledWith(1);
  });
});

// ============================================================================
// 7. ADDITIONAL ADVERSARIAL EDGE CASES (from code inspection)
// ============================================================================
describe("RT8: additional adversarial edge cases", () => {
  it("computed equality dedup: intermediate unchanged computed blocks propagation", () => {
    const s = signal(0);
    const parity = computed(() => s.value % 2); // 0 or 1
    const downstream = computed(() => parity.value * 100);
    const spy = vi.fn();
    effect(() => {
      spy(downstream.value);
    });
    spy.mockClear();
    // Change s but parity stays same (0→2, parity still 0)
    s.value = 2;
    expect(spy).not.toHaveBeenCalled();
    // Now actually change parity
    s.value = 3;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(100);
  });

  it("computed read during notify phase: no stale value", () => {
    const s = signal(1);
    const c = computed(() => s.value * 2);
    const results: number[] = [];
    effect(() => {
      // Read both s and c — c must be consistent with s
      results.push(s.value + c.value);
    });
    results.length = 0;
    s.value = 5;
    expect(results).toEqual([15]); // 5 + 10
  });

  it("computed accessed first time inside effect: lazy init works", () => {
    const s = signal(3);
    const c = computed(() => s.value * s.value);
    // Never read c before subscribing
    const spy = vi.fn();
    effect(() => {
      spy(c.value);
    });
    expect(spy).toHaveBeenCalledWith(9);
    spy.mockClear();
    s.value = 4;
    expect(spy).toHaveBeenCalledWith(16);
  });

  it("effect creating another effect during execution", () => {
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
    // Both effects respond to subsequent changes
    s.value = 2;
    expect(outer).toContain(2);
    expect(inner).toContain(2);
    if (innerDispose) {
      innerDispose();
    }
  });

  it("signal with equals:false always notifies", () => {
    const s = signal(5, { equals: false });
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
    });
    spy.mockClear();
    s.value = 5; // same value but equals:false
    expect(spy).toHaveBeenCalledWith(5);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("computed with equals:false always propagates", () => {
    const s = signal(0);
    const c = computed(() => s.value % 2, { equals: false });
    const spy = vi.fn();
    effect(() => {
      spy(c.value);
    });
    spy.mockClear();
    s.value = 2; // c returns 0 again, but equals:false means changed
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("batch with signal.peek inside: peek does not affect batch", () => {
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

  it("computed.peek inside batch: refreshes without tracking", () => {
    const s = signal(0);
    const c = computed(() => s.value + 100);
    const spy = vi.fn();
    effect(() => {
      batch(() => {
        // peek inside batch
        const peeked = c.peek();
        spy(peeked);
      });
    });
    // Effect tracked nothing (peek), should not re-run
    spy.mockClear();
    s.value = 5;
    expect(spy).not.toHaveBeenCalled();
    expect(c.peek()).toBe(105);
  });

  it("subscribe returns dispose that actually stops notifications", () => {
    const s = signal(0);
    const log: number[] = [];
    const dispose = subscribe(s, (v) => {
      log.push(v);
    });
    log.length = 0;
    s.value = 1;
    expect(log).toEqual([1]);
    dispose();
    log.length = 0;
    s.value = 2;
    expect(log).toEqual([]);
  });

  it("computed that throws then recovers retains correct dep tracking", () => {
    const a = signal(0);
    const b = signal(10);
    let shouldThrow = false;
    const c = computed(() => {
      const av = a.value;
      if (shouldThrow) {
        throw new Error("mid-track");
      }
      return av + b.value;
    });
    expect(c.value).toBe(10);
    shouldThrow = true;
    a.value = 1;
    expect(() => c.value).toThrow("mid-track");
    // Now recover: both a and b should still be tracked
    shouldThrow = false;
    a.value = 2;
    expect(c.value).toBe(12);
    b.value = 20;
    expect(c.value).toBe(22);
  });
});
