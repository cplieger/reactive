// Reactive signal core — what the batch-iteration cycle bail leaves behind.
// endBatch abandons the effect chain it is holding when it decides a write loop
// is cyclic. Every effect in that chain still carries NOTIFIED, and
// notifyTargets skips a NOTIFIED effect, so an abandoned effect could never be
// queued again: a bystander that merely shares a signal with the cycling effect
// would stop updating for the rest of the page's life, silently and with no
// second error. These pin that the bail costs the cycling program its cycle,
// not every effect that happened to be in flight beside it.
import { describe, it, expect } from "vitest";
import { createStore, effect, setEffectErrorHandler, signal } from "./index.js";

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
