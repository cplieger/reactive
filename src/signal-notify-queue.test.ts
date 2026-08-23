// Reactive signal core — the NOTIFIED flag and the pending-effect queue.
//
// notifyTargets threads every effect it wakes onto one singly-linked queue by
// writing `_nextBatchedEffect`, so an effect that is ALREADY queued has to be
// skipped: pushing it a second time overwrites the link that was holding the
// rest of the queue, and every effect behind it is dropped from the flush.
// That failure is silent — no error, no second chance — and it only appears
// when two writes inside one batch touch an effect that is already waiting,
// which is the ordinary shape of a batched multi-signal update.
//
// The same flag also guards notification against a cyclic dependency graph. A
// computed that ends up as its own transitive source cannot be built by reading
// alone (a read of a RUNNING computed throws before the edge is recorded), but
// it CAN be built through the error path, and once it exists the walk over the
// graph has to terminate.
import { describe, it, expect } from "vitest";
import { batch, computed, effect, signal, type ReadonlySignal } from "./index.js";

describe("batch: every effect notified in a batch runs exactly once", () => {
  it("still runs a single-signal effect when the two-signal effect is re-notified", () => {
    const a = signal(0);
    const b = signal(0);
    const both: number[] = [];
    const onlyA: number[] = [];
    // Creation order decides where each effect lands in the pending queue, and
    // the destructive case is a second push of whichever effect is at the head.
    // Both orders are covered, here and in the next case.
    effect(() => {
      both.push(a.value + b.value);
      return undefined;
    });
    effect(() => {
      onlyA.push(a.value);
      return undefined;
    });
    expect(both).toEqual([0]);
    expect(onlyA).toEqual([0]);

    batch(() => {
      a.value = 1; // queues both effects
      b.value = 10; // notifies an effect that is already queued
    });

    expect(both).toEqual([0, 11]);
    expect(onlyA).toEqual([0, 1]);
  });

  it("still runs the two-signal effect when it was queued first", () => {
    const a = signal(0);
    const b = signal(0);
    const onlyA: number[] = [];
    const both: number[] = [];
    effect(() => {
      onlyA.push(a.value);
      return undefined;
    });
    effect(() => {
      both.push(a.value + b.value);
      return undefined;
    });
    expect(onlyA).toEqual([0]);
    expect(both).toEqual([0]);

    batch(() => {
      a.value = 1;
      b.value = 10;
    });

    expect(onlyA).toEqual([0, 1]);
    expect(both).toEqual([0, 11]);
  });

  it("runs three effects on a shared signal when a fourth write re-notifies one", () => {
    const shared = signal(0);
    const extra = signal(0);
    const seen: string[] = [];
    effect(() => {
      seen.push(`x${String(shared.value)}${String(extra.value)}`);
      return undefined;
    });
    effect(() => {
      seen.push(`y${String(shared.value)}`);
      return undefined;
    });
    effect(() => {
      seen.push(`z${String(shared.value)}`);
      return undefined;
    });
    seen.length = 0;

    batch(() => {
      shared.value = 1;
      extra.value = 1;
    });

    // One run each, whatever the flush order is.
    expect(seen.slice().sort()).toEqual(["x11", "y1", "z1"]);
  });
});

describe("notification over a cyclic dependency graph", () => {
  it("terminates when two computeds have become each other's source", () => {
    const flip = signal(0);
    const holder: { back?: ReadonlySignal<number> } = {};
    // `front` reads `back` only once armed; `back` always reads `front`. The
    // first read links back -> front. Arming it makes `front`'s refresh read
    // `back`, whose own refresh reads `front` while `front` is RUNNING: that
    // read throws, `back` caches the error, and the read of `back` that raised
    // it still records the edge front <- back before rethrowing. From then on
    // each computed is reachable from the other.
    const front = computed(() => (flip.value === 1 ? (holder.back?.value ?? 0) : 0));
    holder.back = computed(() => front.value + 1);

    expect(holder.back.value).toBe(1);

    flip.value = 1;
    expect(() => front.value).toThrow("Cycle detected");

    // The graph is now cyclic. A write has to walk it without recursing forever.
    expect(() => {
      flip.value = 2;
    }).not.toThrow();

    // And the cycle was a state, not a poisoning: with the arming condition
    // false again the pair recovers.
    expect(front.value).toBe(0);
    expect(holder.back.value).toBe(1);
  });
});
