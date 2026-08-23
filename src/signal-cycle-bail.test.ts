// Reactive signal core — what the batch-iteration cycle bail leaves behind.
// endBatch abandons the effect chain it is holding when it decides a write loop
// is cyclic. Every effect in that chain still carries NOTIFIED, and
// notifyTargets skips a NOTIFIED effect, so an abandoned effect could never be
// queued again: a bystander that merely shares a signal with the cycling effect
// would stop updating for the rest of the page's life, silently and with no
// second error. These pin that the bail costs the cycling program its cycle,
// not every effect that happened to be in flight beside it.
import { describe, it, expect } from "vitest";
import { batch, createStore, effect, setEffectErrorHandler, signal } from "./index.js";

describe("cycle bail: effects abandoned by the bail stay reactive", () => {
  it("re-runs a bystander effect on a signal the cycle also wrote", () => {
    const prev = setEffectErrorHandler(() => {
      // The cycle report itself is asserted by the store case below.
    });
    try {
      const x = signal(0);
      const y = signal(0);
      const seen: number[] = [];
      effect(() => {
        seen.push(x.value);
        return undefined;
      });
      // Two effects writing each other's source: the batch drain re-queues them
      // until MAX_BATCH_ITERATIONS and bails, dropping the queued chain.
      const disposeA = effect(() => {
        y.value = x.value + 1;
        return undefined;
      });
      const disposeB = effect(() => {
        x.value = y.value + 1;
        return undefined;
      });
      // Retire the cycle, so the write below is an ordinary one and the
      // bystander's last observation is exactly what it was told.
      disposeA();
      disposeB();

      x.value = 5000;

      expect(seen[seen.length - 1]).toBe(5000);
    } finally {
      setEffectErrorHandler(prev);
    }
  });

  it("re-notifies a store subscription on the key whose computed cycled", () => {
    const errors: unknown[] = [];
    const prev = setEffectErrorHandler((e) => {
      errors.push(e);
    });
    try {
      const store = createStore<{ k: number }>();
      store.set("k", 0);
      const seen: number[] = [];
      store.subscribe("k", (v) => {
        seen.push(v);
      });
      // The documented self-read cycle: a computed key whose fn yields a new
      // value every run surfaces "Cycle detected" through the error handler.
      const disposeCycle = store.computed("k", () => store.get("k") + 1);
      disposeCycle();

      store.set("k", 5000);

      expect(errors.some((e) => e instanceof Error && e.message === "Cycle detected")).toBe(true);
      expect(seen[seen.length - 1]).toBe(5000);
    } finally {
      setEffectErrorHandler(prev);
    }
  });
});

// The drain is re-entrant by design: a write or a batch() from an effect body sees
// the batch depth back at 0 and starts a NESTED drain. The pass counter that
// decides "Cycle detected" is shared by all of them, so what it means has to be
// independent of which of those reached the drain. When a nested drain zeroed the
// counter on its way out it could never reach the cap at all: each pass of a write
// cycle recurses one level and opens one nested drain from the body, so the
// recursion ran until the JS stack gave out and the consumer's error handler was
// handed a RangeError instead of the library's cycle report — at a depth that is a
// property of the runtime, not of the program.
//
// The empty `batch(() => {})` arm below is the interesting one and covers the
// removed `flushSync()` exactly: its body WAS `startBatch(); endBatch()`, so an
// arm calling it was the same program as an arm opening an empty batch. That is
// the shape that reaches the drain with nothing to do and must still leave the
// enclosing count intact.
describe("cycle bail: the threshold does not depend on how the drain was reached", () => {
  // Two effects writing each other's source: the canonical write cycle. Each pass
  // recurses one level deeper, so the value the pair reached when the bail fired
  // is a direct reading of the effective cap.
  function pingPong(tail: () => void): { reached: number; reported: string[] } {
    const reported: string[] = [];
    const prev = setEffectErrorHandler((e) => {
      reported.push(e instanceof Error ? e.message : String(e));
    });
    try {
      const x = signal(0);
      const y = signal(0);
      // `tail` runs BEFORE the write: after it, the write's own nested drain has
      // not returned yet when the bail fires, so the nested drain a body opens
      // only lands on the counter from here.
      effect(() => {
        tail();
        y.value = x.value + 1;
        return undefined;
      });
      effect(() => {
        tail();
        x.value = y.value + 1;
        return undefined;
      });
      return { reached: x.peek(), reported };
    } finally {
      setEffectErrorHandler(prev);
    }
  }

  const plain = (): void => {
    // an effect body that opens no nested drain of its own
  };

  it("reports the same cycle at the same point whether or not the body opens a batch()", () => {
    const bare = pingPong(plain);
    const batched = pingPong(() => {
      batch(() => {
        // the batch itself is the nested drain; it needs no writes of its own
      });
    });

    expect(bare.reported).toEqual(["Cycle detected"]);
    expect(batched.reported).toEqual(["Cycle detected"]);
    expect(batched.reached).toBe(bare.reached);
  });

  it("does not read a wide fan-out from one effect as a cycle", () => {
    // The counter may not simply accumulate across nested drains either: an effect
    // writing many signals opens one nested drain per write, and there are more of
    // them here than the cap. That is a terminating program and must not be
    // reported as a cycle or lose the effects behind the write it happened on.
    const errors: unknown[] = [];
    const prev = setEffectErrorHandler((e) => {
      errors.push(e);
    });
    try {
      const width = 250;
      const trigger = signal(0);
      const sources = Array.from({ length: width }, () => signal(0));
      const seen = new Array<number>(width).fill(-1);
      sources.forEach((s, i) => {
        effect(() => {
          seen[i] = s.value;
          return undefined;
        });
      });
      effect(() => {
        const t = trigger.value;
        for (const s of sources) {
          s.value = t;
        }
        return undefined;
      });

      trigger.value = 7;

      expect(errors).toEqual([]);
      expect(seen.every((v) => v === 7)).toBe(true);
    } finally {
      setEffectErrorHandler(prev);
    }
  });
});
