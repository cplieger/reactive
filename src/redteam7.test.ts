// @vitest-environment happy-dom
// RED-TEAM round-7 — final convergence verification
// Per-callback-site throw-safety + pathological graphs (diamonds, chains, fan-in/out)
import { describe, it, expect, vi } from "vitest";
import {
  signal,
  effect,
  batch,
  computed,
  setEffectErrorHandler,
  flushSync,
} from "./index.js";
import { createStore } from "./store.js";
import { reconcile, KEY_ATTR } from "./reconcile.js";

function withHandler(fn: (errors: unknown[]) => void): void {
  const errors: unknown[] = [];
  const prev = setEffectErrorHandler((e) => errors.push(e));
  try {
    fn(errors);
  } finally {
    setEffectErrorHandler(prev);
  }
}

// ===========================================================================
// CALLBACK SITE 1: effect body throw in pathological graphs
// ===========================================================================
describe("R7: effect body throw — pathological graphs", () => {
  it("diamond graph: root → L,R → join; L throws — join still subscribes", () => {
    withHandler((errors) => {
      const root = signal(0);
      const left = computed(() => root.value + 1);
      const right = computed(() => root.value + 2);
      const log: string[] = [];
      // L effect throws
      effect(() => {
        if (left.value > 1) {throw new Error("L-boom");}
        return undefined;
      });
      // Join effect reads both
      effect(() => {
        log.push(`${left.value}+${right.value}`);
        return undefined;
      });
      log.length = 0;
      errors.length = 0;
      root.value = 1;
      expect(errors.length).toBe(1);
      expect(log).toContain("2+3");
      // Verify join still subscribes after L threw
      log.length = 0;
      root.value = 2;
      expect(log).toContain("3+4");
    });
  });

  it("fan-out: one source → 20 effects, all throw — no skipped, all re-subscribe", () => {
    withHandler((errors) => {
      const s = signal(0);
      const spies = Array.from({ length: 20 }, () => vi.fn());
      spies.forEach((spy, i) => {
        effect(() => {
          spy(s.value);
          if (s.value > 0) {throw new Error(`fan-${i}`);}
          return undefined;
        });
      });
      spies.forEach((spy) => spy.mockClear());
      errors.length = 0;
      s.value = 1;
      expect(errors.length).toBe(20);
      spies.forEach((spy) => expect(spy).toHaveBeenCalledWith(1));
      // All re-subscribe
      spies.forEach((spy) => spy.mockClear());
      errors.length = 0;
      s.value = 2;
      expect(errors.length).toBe(20);
      spies.forEach((spy) => expect(spy).toHaveBeenCalledWith(2));
    });
  });

  it("chain: s → c1 → c2 → c3 → effect; c2 throws — effect still works after recovery", () => {
    withHandler(() => {
      const s = signal(0);
      const c1 = computed(() => s.value * 2);
      let throwInC2 = false;
      const c2 = computed(() => {
        if (throwInC2) {throw new Error("c2-chain");}
        return c1.value + 1;
      });
      const c3 = computed(() => c2.value + 10);
      const log: string[] = [];
      effect(() => {
        try { log.push(`v=${c3.value}`); }
        catch { log.push("err"); }
        return undefined;
      });
      log.length = 0;
      throwInC2 = true;
      s.value = 1;
      expect(log).toContain("err");
      // Recovery
      log.length = 0;
      throwInC2 = false;
      s.value = 2;
      expect(log).toContain("v=15"); // 2*2+1+10=15
    });
  });

  it("fan-in: 5 signals → 1 computed → effect; throw in effect body", () => {
    withHandler((errors) => {
      const sigs = Array.from({ length: 5 }, (_, i) => signal(i));
      const sum = computed(() => sigs.reduce((a, s) => a + s.value, 0));
      const spy = vi.fn();
      effect(() => {
        spy(sum.value);
        if (sum.value > 10) {throw new Error("fan-in-boom");}
        return undefined;
      });
      spy.mockClear();
      errors.length = 0;
      batch(() => { sigs.forEach((s) => { s.value = 10; }); });
      expect(errors.length).toBe(1);
      expect(spy).toHaveBeenCalledWith(50);
      // Still subscribes
      spy.mockClear();
      errors.length = 0;
      sigs[0]!.value = 0;
      expect(spy).toHaveBeenCalledWith(40);
    });
  });
});

// ===========================================================================
// CALLBACK SITE 2: effect cleanup throw — pathological cases
// ===========================================================================
describe("R7: effect cleanup throw — pathological", () => {
  it("cleanup throws then effect body throws — both caught, effect re-subscribes", () => {
    withHandler((errors) => {
      const s = signal(0);
      let throwCount = 0;
      effect(() => {
        void s.value;
        throwCount++;
        if (throwCount > 1) {throw new Error("body-throw");}
        return () => { throw new Error("cleanup-throw"); };
      });
      errors.length = 0;
      s.value = 1; // triggers cleanup (throws) then body (throws)
      expect(errors.length).toBe(2);
      // Still subscribed for next update
      errors.length = 0;
      throwCount = 0; // reset to not throw
      s.value = 2;
      // Effect ran (throwCount incremented)
      expect(throwCount).toBe(1);
    });
  });

  it("cleanup throws during dispose — no zombie", () => {
    withHandler((errors) => {
      const s = signal(0);
      const spy = vi.fn();
      const dispose = effect(() => {
        spy(s.value);
        return () => { throw new Error("dispose-cleanup"); };
      });
      spy.mockClear();
      errors.length = 0;
      dispose();
      expect(errors.length).toBe(1);
      spy.mockClear();
      s.value = 1;
      expect(spy).not.toHaveBeenCalled(); // no zombie
    });
  });
});

// ===========================================================================
// CALLBACK SITE 3: computed fn throw — pathological
// ===========================================================================
describe("R7: computed fn throw — pathological graphs", () => {
  it("diamond: root → cL(throws), cR → join-computed → effect", () => {
    withHandler(() => {
      const root = signal(0);
      const cL = computed(() => {
        if (root.value > 0) {throw new Error("cL");}
        return root.value;
      });
      const cR = computed(() => root.value * 10);
      const join = computed(() => {
        let l: number;
        try { l = cL.value; } catch { l = -1; }
        return l + cR.value;
      });
      const log: number[] = [];
      effect(() => { log.push(join.value); return undefined; });
      log.length = 0;
      root.value = 1;
      expect(log).toContain(-1 + 10); // -1 + 10 = 9
      // cL recovers
      log.length = 0;
      root.value = -1;
      expect(log).toContain(-1 + -10); // -1 + -10 = -11
    });
  });

  it("computed throws mid-tracking — partial deps preserved for retry (no zombie)", () => {
    withHandler(() => {
      const a = signal(1);
      const b = signal(2);
      let shouldThrow = false;
      const c = computed(() => {
        const av = a.value; // subscribes to a
        if (shouldThrow) {throw new Error("mid-track");}
        return av + b.value; // subscribes to b only if no throw
      });
      const spy = vi.fn();
      effect(() => {
        try { spy(c.value); } catch { spy("err"); }
        return undefined;
      });
      expect(spy).toHaveBeenCalledWith(3);
      shouldThrow = true;
      spy.mockClear();
      a.value = 10; // triggers recompute, throws mid-track
      expect(spy).toHaveBeenCalledWith("err");
      // The computed restored old deps (a,b) — changing b triggers recompute.
      // But since the computed still errors with same "shape" (hasError=true, val unchanged),
      // the equality dedup correctly skips re-notification. This is correct behavior.
      // The key invariant: when we RECOVER, changing b triggers the recompute.
      shouldThrow = false;
      spy.mockClear();
      b.value = 20; // triggers recompute because b dep was preserved
      // Now it succeeds: a=10, b=20 → 30
      expect(spy).toHaveBeenCalledWith(30);
    });
  });
});

// ===========================================================================
// CALLBACK SITE 4: computed equals throw
// ===========================================================================
describe("R7: computed equals comparator throw", () => {
  it("equals throws — treated as changed, downstream notified, no corruption", () => {
    withHandler((_errors) => {
      const s = signal(0);
      let eqThrow = false;
      const c = computed(() => s.value * 2, {
        equals: () => { if (eqThrow) {throw new Error("eq-boom");} return false; },
      });
      const spy = vi.fn();
      effect(() => { spy(c.value); return undefined; });
      spy.mockClear();
      eqThrow = true;
      s.value = 1;
      // The equals throw in computed.sub.execute should be caught (try/catch around eq)
      // and treated as changed=true, so downstream gets notified
      expect(spy).toHaveBeenCalledWith(2);
      // System still works
      eqThrow = false;
      spy.mockClear();
      s.value = 2;
      expect(spy).toHaveBeenCalledWith(4);
      // No errors reported to handler (eq throw is internal to computed machinery)
      // Actually check: computed's execute() catches eq throw internally
    });
  });
});

// ===========================================================================
// CALLBACK SITE 5: signal equals throw
// ===========================================================================
describe("R7: signal equals throw", () => {
  it("equals throws inside deeply nested batch — batchDepth restored", () => {
    const s = signal(0, {
      equals: (_a, b) => { if (b === 100) {throw new Error("deep-eq");} return _a === b; },
    });
    const spy = vi.fn();
    const prev = setEffectErrorHandler(() => { /* swallow */ });
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    expect(() => {
      batch(() => batch(() => batch(() => { s.value = 100; })));
    }).toThrow("deep-eq");
    // batchDepth must be 0 — next write must flush immediately
    spy.mockClear();
    s.value = 7;
    expect(spy).toHaveBeenCalledWith(7);
    setEffectErrorHandler(prev);
  });

  it("equals throws — does not corrupt signal value or subscriber set", () => {
    const s = signal(42, {
      equals: (_a, b) => { if (b === 0) {throw new Error("zero-eq");} return _a === b; },
    });
    const spy = vi.fn();
    const prev = setEffectErrorHandler(() => { /* swallow */ });
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    expect(() => { s.value = 0; }).toThrow("zero-eq");
    expect(s.peek()).toBe(42); // value unchanged
    spy.mockClear();
    s.value = 99;
    expect(spy).toHaveBeenCalledWith(99);
    expect(s.peek()).toBe(99);
    setEffectErrorHandler(prev);
  });
});

// ===========================================================================
// CALLBACK SITE 6: store subscriber throw
// ===========================================================================
describe("R7: store subscriber throw", () => {
  it("subscriber throws — other subscribers still notified", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    const spy1 = vi.fn();
    const spy2 = vi.fn();
    store.subscribe("x", () => { throw new Error("sub-throw"); });
    store.subscribe("x", spy1);
    store.subscribe("x", spy2);
    store.set("x", 5);
    expect(spy1).toHaveBeenCalledWith(5);
    expect(spy2).toHaveBeenCalledWith(5);
  });

  it("store batch — subscriber throw doesn't corrupt batchDepth", () => {
    const store = createStore<{ a: number; b: number }>();
    store.set("a", 0);
    store.set("b", 0);
    store.subscribe("a", () => { throw new Error("a-sub"); });
    const spy = vi.fn();
    store.subscribe("b", spy);
    store.batch(() => {
      store.set("a", 1);
      store.set("b", 2);
    });
    expect(spy).toHaveBeenCalledWith(2);
    // Verify non-batch still works after
    spy.mockClear();
    store.set("b", 3);
    expect(spy).toHaveBeenCalledWith(3);
  });
});

// ===========================================================================
// CALLBACK SITE 7: reconcile mount/update/onRemove/key throw
// (These don't touch reactive state, just verify no infinite loop/hang)
// ===========================================================================
describe("R7: reconcile callbacks throw — no hang", () => {
  it("key throws — propagates, no reactive corruption", () => {
    const parent = document.createElement("div");
    expect(() => {
      reconcile(parent, [{ id: 1 }], {
        key: () => { throw new Error("key-throw"); },
        mount: (item) => { const el = document.createElement("div"); el.textContent = String(item); return el; },
      });
    }).toThrow("key-throw");
    // Reactive system still works after
    const s = signal(0);
    const spy = vi.fn();
    const prev = setEffectErrorHandler(() => { /* swallow */ });
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledWith(1);
    setEffectErrorHandler(prev);
  });

  it("mount throws — propagates, no reactive corruption", () => {
    const parent = document.createElement("div");
    expect(() => {
      reconcile(parent, [{ id: 1 }], {
        key: (item) => String(item.id),
        mount: () => { throw new Error("mount-throw"); },
      });
    }).toThrow("mount-throw");
    const s = signal(0);
    const spy = vi.fn();
    const prev = setEffectErrorHandler(() => { /* swallow */ });
    effect(() => { spy(s.value); return undefined; });
    spy.mockClear();
    s.value = 1;
    expect(spy).toHaveBeenCalledWith(1);
    setEffectErrorHandler(prev);
  });

  it("update throws — propagates, no reactive corruption", () => {
    const parent = document.createElement("div");
    reconcile(parent, [{ id: 1, v: "a" }], {
      key: (item) => String(item.id),
      mount: (item) => { const el = document.createElement("div"); el.setAttribute(KEY_ATTR, String(item.id)); return el; },
      update: () => { throw new Error("update-throw"); },
    });
    // Now update
    expect(() => {
      reconcile(parent, [{ id: 1, v: "b" }], {
        key: (item) => String(item.id),
        mount: (item) => { const el = document.createElement("div"); el.setAttribute(KEY_ATTR, String(item.id)); return el; },
        update: () => { throw new Error("update-throw"); },
      });
    }).toThrow("update-throw");
  });

  it("onRemove throws — propagates, no reactive corruption", () => {
    const parent = document.createElement("div");
    const spec = {
      key: (item: { id: number }) => String(item.id),
      mount: (item: { id: number }) => { const el = document.createElement("div"); el.setAttribute(KEY_ATTR, String(item.id)); return el; },
      onRemove: () => { throw new Error("onRemove-throw"); },
    };
    reconcile(parent, [{ id: 1 }, { id: 2 }], spec);
    expect(() => {
      reconcile(parent, [{ id: 1 }], spec); // removes id=2, onRemove throws
    }).toThrow("onRemove-throw");
  });
});

// ===========================================================================
// INVARIANT CHECKS: flushing, batchDepth, no infinite loop
// ===========================================================================
describe("R7: global invariants after throw storms", () => {
  it("100 alternating throw/success cycles — system remains stable", () => {
    withHandler(() => {
      const s = signal(0);
      let shouldThrow = true;
      effect(() => {
        void s.value;
        if (shouldThrow) {throw new Error("storm");}
        return undefined;
      });
      for (let i = 1; i <= 100; i++) {
        shouldThrow = i % 2 === 0;
        s.value = i;
      }
      // Final state — effect should have run (shouldThrow=false for odd=100? no, 100%2=0 so throws)
      shouldThrow = false;
      const spy = vi.fn();
      effect(() => { spy(s.value); return undefined; });
      spy.mockClear();
      s.value = 999;
      expect(spy).toHaveBeenCalledWith(999);
    });
  });

  it("flushSync after throw storm — works (flushing not stuck)", () => {
    withHandler(() => {
      const s = signal(0);
      effect(() => { if (s.value > 0) {throw new Error("fs");} return undefined; });
      s.value = 1;
      // If flushing were stuck, this would be a no-op
      const s2 = signal(0);
      const spy = vi.fn();
      effect(() => { spy(s2.value); return undefined; });
      spy.mockClear();
      batch(() => { s2.value = 42; });
      flushSync();
      expect(spy).toHaveBeenCalledWith(42);
    });
  });

  it("no infinite loop: effect throws and re-dispatches to itself (writes in error path)", () => {
    // If effect throws, it's caught. If during that the error handler writes to
    // the same signal, the effect is re-queued. Could this loop forever?
    // Answer: no, because drainPending processes the current batch, and new
    // pending items are processed in the next while-loop iteration.
    // But let's verify it terminates.
    const s = signal(0);
    let writeCount = 0;
    const prev = setEffectErrorHandler(() => {
      // Write back to the signal — but only a few times
      if (writeCount < 5) {
        writeCount++;
        s.value = s.peek() + 1;
      }
    });
    effect(() => {
      if (s.value > 0 && s.value < 10) {throw new Error("loop-test");}
      return undefined;
    });
    s.value = 1;
    // Should terminate. writeCount should be 5 (handler stops writing after 5)
    expect(writeCount).toBe(5);
    expect(s.peek()).toBe(6); // 1 + 5 increments
    setEffectErrorHandler(prev);
  });
});

// ===========================================================================
// CROSS-CUTTING: computed in effect that throws during batch flush
// ===========================================================================
describe("R7: computed+effect interaction during batch flush throw", () => {
  it("batch with 3 computeds, middle throws — first and last still propagate", () => {
    withHandler(() => {
      const s = signal(0);
      const c1 = computed(() => s.value + 1);
      const c2 = computed(() => {
        if (s.value > 0) {throw new Error("c2-batch");}
        return s.value + 2;
      });
      const c3 = computed(() => s.value + 3);
      const log1: number[] = [];
      const log2: string[] = [];
      const log3: number[] = [];
      effect(() => { log1.push(c1.value); return undefined; });
      effect(() => {
        try { log2.push(`v=${c2.value}`); } catch { log2.push("err"); }
        return undefined;
      });
      effect(() => { log3.push(c3.value); return undefined; });
      log1.length = 0;
      log2.length = 0;
      log3.length = 0;
      batch(() => { s.value = 5; });
      expect(log1).toContain(6);
      expect(log2).toContain("err");
      expect(log3).toContain(8);
    });
  });
});
