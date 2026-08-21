// Reactive signal core — flushSync() and the batch-depth counter it borrows.
// Writes already flush at the end of their own implicit batch, so flushSync()
// normally has nothing to drain; what it must never do is leave the shared
// batch depth unbalanced, because that silently switches every later write
// between "flush immediately" and "never flush".
import { describe, it, expect } from "vitest";
import { signal, effect, batch, flushSync } from "./index.js";

describe("flushSync: batch-depth balance", () => {
  it("leaves a later write flushing synchronously", () => {
    const s = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(s.value);
      return undefined;
    });
    flushSync();

    s.value = 1;
    expect(seen).toEqual([0, 1]);
  });

  it("leaves a later batch still coalescing", () => {
    const s = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(s.value);
      return undefined;
    });
    flushSync();

    batch(() => {
      s.value = 1;
      s.value = 2;
    });
    expect(seen).toEqual([0, 2]);
  });
});
