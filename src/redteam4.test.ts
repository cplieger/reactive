// @vitest-environment happy-dom
// RED-TEAM round-4 convergence check
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  signal,
  effect,
  batch,
  computed,
  setEffectErrorHandler,
  createStore,
} from "./index.js";
import type { EffectErrorHandler } from "./index.js";

// ---------------------------------------------------------------------------
// 1. Cleanup throws AND body throws in same re-execution
// ---------------------------------------------------------------------------

describe("cleanup throw + body throw in same run", () => {
  let prevHandler: EffectErrorHandler;
  const errors: unknown[] = [];
  beforeEach(() => {
    errors.length = 0;
    prevHandler = setEffectErrorHandler((e) => { errors.push(e); });
  });
  afterEach(() => { setEffectErrorHandler(prevHandler); });

  it("both cleanup and body throw: both errors routed to handler, effect re-subscribes", () => {
    const s = signal(0);
    const values: number[] = [];
    effect(() => {
      const v = s.value;
      values.push(v);
      if (v === 1) {throw new Error("body-throw-1");}
      return () => { throw new Error("cleanup-throw"); };
    });
    // Trigger: cleanup throws then body throws
    s.value = 1;
    expect(errors.some(e => (e as Error).message === "cleanup-throw")).toBe(true);
    expect(errors.some(e => (e as Error).message === "body-throw-1")).toBe(true);
    // Effect should still re-execute on next change
    errors.length = 0;
    s.value = 2;
    expect(values).toContain(2);
  });

  it("cleanup throw does not prevent body from running (ordering)", () => {
    const s = signal("a");
    const log: string[] = [];
    effect(() => {
      log.push(`body:${s.value}`);
      return () => {
        log.push(`cleanup:${s.value}`);
        throw new Error("cleanup!");
      };
    });
    s.value = "b";
    // cleanup runs first (with old captured value from closure — but s.value is already "b")
    // body runs second
    expect(log).toContain("body:b");
  });
});

// ---------------------------------------------------------------------------
// 2. Cleanup throwing across many effects in a single flush
// ---------------------------------------------------------------------------

describe("many effects' cleanups throw in single flush", () => {
  let prevHandler: EffectErrorHandler;
  const errors: unknown[] = [];
  beforeEach(() => {
    errors.length = 0;
    prevHandler = setEffectErrorHandler((e) => { errors.push(e); });
  });
  afterEach(() => { setEffectErrorHandler(prevHandler); });

  it("10 effects all with throwing cleanups: all re-execute correctly", () => {
    const s = signal(0);
    const spies = Array.from({ length: 10 }, () => vi.fn());
    for (let i = 0; i < 10; i++) {
      const spy = spies[i]!;
      effect(() => {
        spy(s.value);
        return () => { throw new Error(`cleanup-${i}`); };
      });
    }
    for (const spy of spies) {spy.mockClear();}
    s.value = 1;
    // All effects should re-execute despite all cleanups throwing
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledWith(1);
    }
    expect(errors.length).toBe(10); // 10 cleanup errors
  });

  it("batch where multiple effects' cleanups throw: all flush correctly", () => {
    const s = signal(0);
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      effect(() => {
        results.push(s.value);
        return () => { throw new Error(`batch-cleanup-${i}`); };
      });
    }
    results.length = 0;
    errors.length = 0;
    batch(() => { s.value = 99; });
    expect(results.filter(v => v === 99).length).toBe(5);
    expect(errors.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 3. Dispose during cleanup-throw (dispose() must not throw to caller)
// ---------------------------------------------------------------------------

describe("dispose during cleanup throw", () => {
  let prevHandler: EffectErrorHandler;
  const errors: unknown[] = [];
  beforeEach(() => {
    errors.length = 0;
    prevHandler = setEffectErrorHandler((e) => { errors.push(e); });
  });
  afterEach(() => { setEffectErrorHandler(prevHandler); });

  it("dispose() when cleanup throws: error goes to handler, does not propagate", () => {
    const s = signal(0);
    const dispose = effect(() => {
      void s.value;
      return () => { throw new Error("dispose-cleanup-throw"); };
    });
    // dispose must NOT throw
    expect(() => dispose()).not.toThrow();
    expect(errors.some(e => (e as Error).message === "dispose-cleanup-throw")).toBe(true);
  });

  it("after dispose with cleanup throw, signal no longer triggers effect", () => {
    const s = signal(0);
    const spy = vi.fn();
    const dispose = effect(() => {
      spy(s.value);
      return () => { throw new Error("dispose-cleanup"); };
    });
    spy.mockClear();
    dispose();
    s.value = 1;
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Computed cleanup paths (computed that throws during recompute in effect)
// ---------------------------------------------------------------------------

describe("computed cleanup paths", () => {
  let prevHandler: EffectErrorHandler;
  const errors: unknown[] = [];
  beforeEach(() => {
    errors.length = 0;
    prevHandler = setEffectErrorHandler((e) => { errors.push(e); });
  });
  afterEach(() => { setEffectErrorHandler(prevHandler); });

  it("effect reading computed that throws: error in handler, effect recovers", () => {
    const s = signal(0);
    const c = computed(() => {
      if (s.value === 1) {throw new Error("computed-throw");}
      return s.value * 10;
    });
    const values: (number | string)[] = [];
    effect(() => {
      try {
        values.push(c.value);
      } catch (e) {
        values.push((e as Error).message);
      }
      return undefined;
    });
    s.value = 1;
    s.value = 2;
    expect(values).toContain(0); // initial
    expect(values).toContain("computed-throw"); // error state
    expect(values).toContain(20); // recovery
  });

  it("computed throwing does not leave dirty flag stuck", () => {
    const s = signal(0);
    const c = computed(() => {
      if (s.value === 1) {throw new Error("stuck?");}
      return s.value;
    });
    expect(c.value).toBe(0);
    s.value = 1;
    expect(() => c.value).toThrow("stuck?");
    s.value = 2;
    expect(c.value).toBe(2); // not stuck
  });
});

// ---------------------------------------------------------------------------
// 5. Store effect cleanup throw
// ---------------------------------------------------------------------------

describe("store effect cleanup throw", () => {
  it("store effect cleanup throw does not crash store, effect re-runs", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    const values: number[] = [];
    const origErr = console.error;
    const errSpy = vi.fn();
    console.error = errSpy;
    store.effect(() => {
      values.push(store.get("x"));
      return () => { throw new Error("store-cleanup-boom"); };
    });
    store.set("x", 1);
    store.set("x", 2);
    console.error = origErr;
    expect(values).toContain(0);
    expect(values).toContain(1);
    expect(values).toContain(2);
  });

  it("store dispose with throwing cleanup does not throw to caller", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    const origErr = console.error;
    console.error = vi.fn();
    const dispose = store.effect(() => {
      void store.get("x");
      return () => { throw new Error("store-dispose-cleanup"); };
    });
    expect(() => dispose()).not.toThrow();
    console.error = origErr;
  });
});

// ---------------------------------------------------------------------------
// 6. Exception inside effectErrorHandler itself
// ---------------------------------------------------------------------------

describe("exception inside effectErrorHandler", () => {
  let prevHandler: EffectErrorHandler;
  beforeEach(() => {
    prevHandler = setEffectErrorHandler(() => { /* swallow */ });
  });
  afterEach(() => { setEffectErrorHandler(prevHandler); });

  it("if effectErrorHandler throws, system remains usable", () => {
    setEffectErrorHandler(() => { throw new Error("handler-throws"); });
    const s = signal(0);
    // Effect that throws
    effect(() => {
      if (s.value === 1) {throw new Error("trigger");}
      return undefined;
    });
    // This will cause effectErrorHandler to be called, which itself throws
    // The system should still work after (drainPending has try/finally)
    try { s.value = 1; } catch { /* expected */ }
    // Reset handler and verify system still works
    const errors: unknown[] = [];
    setEffectErrorHandler((e) => errors.push(e));
    const spy = vi.fn();
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });

  it("if effectErrorHandler throws during cleanup, next effects still run", () => {
    setEffectErrorHandler(() => { throw new Error("handler-boom"); });
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      void s.value;
      return () => { throw new Error("cleanup!"); };
    });
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    // Cleanup will throw -> handler will throw -> but drainPending catches per-effect
    try { s.value = 1; } catch { /* may propagate */ }
    // Check if the second effect still ran
    // NOTE: If effectErrorHandler throws, it propagates from the try/catch in execute()
    // which is itself inside a try/catch in drainPending. Let's verify.
    setEffectErrorHandler(() => { /* swallow */ });
    spy.mockClear();
    s.value = 2;
    expect(spy).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// 7. Fake timers: verify no async leaks
// ---------------------------------------------------------------------------

describe("fake timers: no async leaks in error paths", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  let prevHandler: EffectErrorHandler;
  beforeEach(() => {
    prevHandler = setEffectErrorHandler(() => { /* swallow */ });
  });
  afterEach(() => { setEffectErrorHandler(prevHandler); });

  it("cleanup throw + re-execution is fully synchronous", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.value);
      return () => { throw new Error("sync-cleanup"); };
    });
    spy.mockClear();
    s.value = 1;
    // Must be called already, no microtask
    expect(spy).toHaveBeenCalledWith(1);
  });

  it("batch + multiple cleanup throws + body throws: all synchronous", () => {
    const s = signal(0);
    const results: number[] = [];
    for (let i = 0; i < 3; i++) {
      effect(() => {
        results.push(s.value);
        if (s.value === 1) {throw new Error(`body-${i}`);}
        return () => { throw new Error(`cleanup-${i}`); };
      });
    }
    results.length = 0;
    batch(() => { s.value = 1; });
    // All should have attempted to run synchronously
    expect(results.length).toBe(3);
  });
});
