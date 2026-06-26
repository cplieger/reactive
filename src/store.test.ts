// Typed per-key reactive store (facade over the signal engine).
import { describe, it, expect, vi } from "vitest";
import { createStore } from "./index.js";

describe("createStore", () => {
  it("get/set round-trip", () => {
    expect.assertions(1);
    const { get, set } = createStore<{ x: number }>();
    set("x", 42);
    expect(get("x")).toBe(42);
  });

  it("subscribe fires on change", () => {
    expect.assertions(2);
    const { set, subscribe } = createStore<{ v: string }>();
    const spy = vi.fn();
    subscribe("v", spy);
    set("v", "hello");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("hello");
  });

  it("subscribe does not fire on same value", () => {
    expect.assertions(1);
    const { set, subscribe } = createStore<{ v: string }>();
    set("v", "same");
    const spy = vi.fn();
    subscribe("v", spy);
    set("v", "same");
    expect(spy).not.toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", () => {
    expect.assertions(1);
    const { set, subscribe } = createStore<{ v: number }>();
    const spy = vi.fn();
    const unsub = subscribe("v", spy);
    set("v", 1);
    unsub();
    set("v", 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("batch coalesces", () => {
    expect.assertions(2);
    const store = createStore<{ a: number; b: number }>();
    const spyA = vi.fn();
    const spyB = vi.fn();
    store.subscribe("a", spyA);
    store.subscribe("b", spyB);
    store.batch(() => {
      store.set("a", 1);
      store.set("b", 2);
      store.set("a", 10);
    });
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyA).toHaveBeenCalledWith(10);
  });

  it("effect auto-tracks keys", () => {
    expect.assertions(2);
    const { get, set, effect: eff } = createStore<{ x: number; y: number }>();
    set("x", 0);
    set("y", 0);
    const spy = vi.fn();
    eff(() => {
      spy(get("x"));
    });
    spy.mockClear();
    set("x", 1);
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockClear();
    // y not tracked
    set("y", 1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("effect cleanup runs on re-execution", () => {
    expect.assertions(1);
    const { get, set, effect: eff } = createStore<{ n: number }>();
    set("n", 0);
    const order: string[] = [];
    eff(() => {
      const v = get("n");
      order.push(`run:${v}`);
      return () => {
        order.push(`cleanup:${v}`);
      };
    });
    set("n", 1);
    expect(order).toEqual(["run:0", "cleanup:0", "run:1"]);
  });

  it("effect disposal", () => {
    expect.assertions(1);
    const { get, set, effect: eff } = createStore<{ n: number }>();
    set("n", 0);
    const spy = vi.fn();
    const dispose = eff(() => {
      spy(get("n"));
    });
    spy.mockClear();
    dispose();
    set("n", 1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("computed updates output key", () => {
    expect.assertions(2);
    const { get, set, computed: comp } = createStore<{ a: number; b: number; sum: number }>();
    set("a", 1);
    set("b", 2);
    comp("sum", () => get("a") + get("b"));
    expect(get("sum")).toBe(3);
    set("a", 10);
    expect(get("sum")).toBe(12);
  });

  it("computed disposal stops updates", () => {
    expect.assertions(2);
    const { get, set, computed: comp } = createStore<{ x: number; out: number }>();
    set("x", 1);
    const dispose = comp("out", () => get("x") * 2);
    expect(get("out")).toBe(2);
    dispose();
    set("x", 5);
    expect(get("out")).toBe(2);
  });

  it("dynamic deps in effect", () => {
    expect.assertions(1);
    const { get, set, effect: eff } = createStore<{ cond: boolean; a: number; b: number }>();
    set("cond", true);
    set("a", 1);
    set("b", 2);
    const spy = vi.fn();
    eff(() => {
      spy(get("cond") ? get("a") : get("b"));
    });
    spy.mockClear();
    set("cond", false); // now tracks b, not a
    spy.mockClear();
    set("a", 99); // should NOT trigger
    expect(spy).not.toHaveBeenCalled();
  });

  it("Object.is equality: NaN does not trigger spurious notifications", () => {
    const { set, subscribe: sub } = createStore<{ x: number }>();
    set("x", NaN);
    const spy = vi.fn();
    sub("x", spy);
    set("x", NaN);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("createStore: error handling", () => {
  it("subscriber error does not prevent other subscribers", () => {
    const { set, subscribe: sub } = createStore<{ x: number }>();
    const spy1 = vi.fn(() => {
      throw new Error("sub1 error");
    });
    const spy2 = vi.fn();
    sub("x", spy1);
    sub("x", spy2);
    // Should not throw, and spy2 should still be called
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
      /* noop */
    });
    set("x", 1);
    expect(spy2).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
  });

  it("batch exception does not leave batch depth dirty", () => {
    const store = createStore<{ x: number }>();
    const spy = vi.fn();
    store.subscribe("x", spy);
    try {
      store.batch(() => {
        throw new Error("batch err");
      });
    } catch {
      // swallow
    }
    store.set("x", 42);
    expect(spy).toHaveBeenCalledWith(42);
  });
});

describe("createStore: deep nesting and dispose-from-cleanup", () => {
  it("deeply nested batch (10 levels) still flushes once", () => {
    const store = createStore<{ x: number }>();
    const spy = vi.fn();
    store.subscribe("x", spy);

    const nest = (depth: number, fn: () => void): void => {
      if (depth === 0) {
        fn();
        return;
      }
      store.batch(() => {
        nest(depth - 1, fn);
      });
    };

    nest(10, () => {
      store.set("x", 42);
    });
    expect(spy).toHaveBeenCalledWith(42);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("effect tracking many keys updates on a single key change", () => {
    const store = createStore<Record<string, number>>();
    for (let i = 0; i < 100; i++) {
      store.set(`k${i}` as never, i as never);
    }
    const spy = vi.fn();
    store.effect(() => {
      let sum = 0;
      for (let i = 0; i < 100; i++) {
        sum += store.get(`k${i}` as never) as number;
      }
      spy(sum);
      return undefined;
    });
    expect(spy).toHaveBeenCalledWith(4950); // sum 0..99
    spy.mockClear();
    store.set("k0" as never, 100 as never);
    expect(spy).toHaveBeenCalledWith(5050); // 4950 - 0 + 100
  });

  it("effect dispose called from cleanup does not overflow", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    let disposeRef: (() => void) | null = null;
    disposeRef = store.effect(() => {
      void store.get("x");
      return () => {
        if (disposeRef) {
          disposeRef();
        }
      };
    });
    expect(() => {
      store.set("x", 1);
    }).not.toThrow();
  });

  it("effect double dispose is a no-op", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    let cleanupCount = 0;
    const dispose = store.effect(() => {
      void store.get("x");
      return () => {
        cleanupCount++;
      };
    });
    dispose();
    expect(cleanupCount).toBe(1);
    dispose();
    expect(cleanupCount).toBe(1);
  });
});

describe("createStore: batch + computed + effect interleaving", () => {
  it("computed key updates atomically in a batch", () => {
    const store = createStore<{ a: number; b: number; sum: number }>();
    store.set("a", 1);
    store.set("b", 2);
    store.computed("sum", () => store.get("a") + store.get("b"));
    expect(store.get("sum")).toBe(3);
    const spy = vi.fn();
    store.subscribe("sum", spy);
    store.batch(() => {
      store.set("a", 10);
      store.set("b", 20);
    });
    expect(store.get("sum")).toBe(30);
  });

  it("a throwing effect does not break subsequent effects", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    const spy = vi.fn();
    store.effect(() => {
      if (store.get("x") === 1) {
        throw new Error("store effect boom");
      }
      return undefined;
    });
    store.effect(() => {
      spy(store.get("x"));
      return undefined;
    });
    spy.mockClear();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
      /* noop */
    });
    store.set("x", 1);
    consoleSpy.mockRestore();
    expect(spy).toHaveBeenCalledWith(1);
  });
});

describe("createStore: effect cleanup throwing", () => {
  it("a throwing cleanup does not crash the store and the effect re-runs", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    const values: number[] = [];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
      /* noop */
    });
    store.effect(() => {
      values.push(store.get("x"));
      return () => {
        throw new Error("store-cleanup-boom");
      };
    });
    store.set("x", 1);
    store.set("x", 2);
    consoleSpy.mockRestore();
    expect(values).toContain(0);
    expect(values).toContain(1);
    expect(values).toContain(2);
  });

  it("dispose with a throwing cleanup does not propagate to the caller", () => {
    const store = createStore<{ x: number }>();
    store.set("x", 0);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
      /* noop */
    });
    const dispose = store.effect(() => {
      void store.get("x");
      return () => {
        throw new Error("store-dispose-cleanup");
      };
    });
    expect(() => dispose()).not.toThrow();
    consoleSpy.mockRestore();
  });
});

describe("createStore: mass dispose does not leak subscriptions", () => {
  it("disposed store effects are not triggered by later changes", () => {
    const store = createStore<{ k: number }>();
    store.set("k", 0);
    const disposers: (() => void)[] = [];
    const spies: ReturnType<typeof vi.fn>[] = [];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
      /* noop */
    });
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
    consoleSpy.mockRestore();
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("createStore: subscriber throw during batch", () => {
  it("a throwing subscriber does not corrupt batch state", () => {
    const store = createStore<{ a: number; b: number }>();
    store.set("a", 0);
    store.set("b", 0);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
      /* noop */
    });
    store.subscribe("a", () => {
      throw new Error("a-sub");
    });
    const spy = vi.fn();
    store.subscribe("b", spy);
    store.batch(() => {
      store.set("a", 1);
      store.set("b", 2);
    });
    expect(spy).toHaveBeenCalledWith(2);
    // Non-batch write still works afterwards
    spy.mockClear();
    store.set("b", 3);
    expect(spy).toHaveBeenCalledWith(3);
    consoleSpy.mockRestore();
  });
});
