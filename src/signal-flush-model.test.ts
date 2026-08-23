// Reactive signal core — the FLUSH MODEL itself.
//
// The engine has one phase: a write opens an implicit batch, notifies and drains
// before the assignment returns, and `batch()` is the only deferral. That was the
// behaviour all along and nothing asserted it — the file this replaced
// (`signal-flush.test.ts`) tested the removed `flushSync()`'s batch-depth hygiene
// instead, which is why the contract could drift into claiming a write leaves
// effects pending.
//
// These tests pin clause 1 and clause 2 from every position a caller can occupy,
// so a change that queues effects anywhere fails here rather than in a consumer.
// Each one reads state on the statement AFTER the write, with no drain call in
// between, because "there is no drain call" is the property.
import { describe, it, expect } from "vitest";
import { signal, effect, batch, computed } from "./index.js";

describe("flush model: a write flushes before the assignment returns", () => {
  it("has re-run the effect by the next statement", () => {
    const s = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(s.value);
      return undefined;
    });

    s.value = 1;
    expect(seen).toEqual([0, 1]);

    s.value = 2;
    expect(seen).toEqual([0, 1, 2]);
  });

  it("has committed the DOM an effect writes, so the next statement can read it", () => {
    // The consumer-facing form of clause 1: three UIs in this workspace read the
    // DOM on the line after a write. If effects were queued, this measurement
    // would be of the pre-write layout.
    const host = document.createElement("div");
    const label = signal("one");
    effect(() => {
      host.textContent = label.value;
      return undefined;
    });

    label.value = "two";
    expect(host.textContent).toBe("two");
  });

  it("has flushed a chain of dependent effects, not just the first", () => {
    const s = signal(0);
    const doubled = computed(() => s.value * 2);
    const order: string[] = [];
    effect(() => {
      order.push(`a${s.value}`);
      return undefined;
    });
    effect(() => {
      order.push(`b${doubled.value}`);
      return undefined;
    });
    order.length = 0;

    s.value = 3;
    expect(order).toEqual(["a3", "b6"]);
  });

  it("has run the cleanup of the previous pass before the write returns", () => {
    const s = signal(0);
    const order: string[] = [];
    effect(() => {
      const v = s.value;
      order.push(`run${v}`);
      return () => {
        order.push(`clean${v}`);
      };
    });

    s.value = 1;
    expect(order).toEqual(["run0", "clean0", "run1"]);
  });
});

describe("flush model: batch() is the only deferral", () => {
  it("holds effects until the outermost batch returns", () => {
    const s = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(s.value);
      return undefined;
    });

    batch(() => {
      s.value = 1;
      expect(seen).toEqual([0]);
      s.value = 2;
      expect(seen).toEqual([0]);
    });
    expect(seen).toEqual([0, 2]);
  });

  it("defers a nested batch to the outermost, not to its own end", () => {
    const s = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(s.value);
      return undefined;
    });

    batch(() => {
      batch(() => {
        s.value = 1;
      });
      expect(seen).toEqual([0]);
      s.value = 2;
    });
    expect(seen).toEqual([0, 2]);
  });

  it("still flushes when the batch body throws", () => {
    const s = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(s.value);
      return undefined;
    });

    expect(() => {
      batch(() => {
        s.value = 1;
        throw new Error("boom");
      });
    }).toThrow("boom");
    expect(seen).toEqual([0, 1]);
  });

  it("leaves the next bare write eager — a batch does not latch the deferral on", () => {
    // The batch depth is shared global state, so an unbalanced batch would
    // silently switch every later write between "flush immediately" and "never
    // flush". This is the assertion the removed flushSync tests were really
    // making, kept because the property is the engine's, not that function's.
    const s = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(s.value);
      return undefined;
    });

    batch(() => {
      s.value = 1;
    });
    s.value = 2;
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe("flush model: a write from inside the graph flushes too", () => {
  it("flushes a write made from an effect body before that write returns", () => {
    const src = signal(0);
    const mid = signal(0);
    const order: string[] = [];
    effect(() => {
      const v = src.value;
      order.push(`src${v}`);
      mid.value = v * 10;
      // The nested drain has already run by here: `mid`'s effect is in the log.
      order.push(`after-write:${order.includes(`mid${v * 10}`) ? "flushed" : "pending"}`);
      return undefined;
    });
    effect(() => {
      order.push(`mid${mid.value}`);
      return undefined;
    });
    order.length = 0;

    src.value = 1;
    expect(order).toEqual(["src1", "mid10", "after-write:flushed"]);
  });

  it("flushes a write made from a cleanup", () => {
    const s = signal(0);
    const other = signal(0);
    const seen: number[] = [];
    effect(() => {
      // Tracked for its own sake: the cleanup is the subject, not the value.
      void s.value;
      return () => {
        other.value = other.peek() + 1;
      };
    });
    effect(() => {
      seen.push(other.value);
      return undefined;
    });
    seen.length = 0;

    s.value = 1;
    expect(seen).toEqual([1]);
  });
});

describe("flush model: deferral beyond a batch belongs to the caller", () => {
  it("flushes inside the caller's own microtask when the write is deferred there", async () => {
    // Clause 3. A consumer wanting effects on a later task defers the WRITE, not
    // the flush — this is the shape vibekit's message-render coalescer uses.
    const s = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(s.value);
      return undefined;
    });

    const settled = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        s.value = 1;
        // Flushed within the microtask that wrote, with nothing else scheduled.
        expect(seen).toEqual([0, 1]);
        resolve();
      });
    });
    expect(seen).toEqual([0]);
    await settled;
    expect(seen).toEqual([0, 1]);
  });
});
