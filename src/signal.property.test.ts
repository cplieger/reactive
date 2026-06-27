// signal.property.test.ts — property-based coverage for the dependency-tracking
// core invariants. The example-based suites pin specific graph shapes; these
// generalize over randomized DAGs and write sequences with fast-check, so a
// regression in Object.is dedup, the per-node version / global-epoch fast-skip,
// or the staleness check that survives the enumerated shapes is still caught.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { signal, computed, effect, batch } from "./index.js";
import type { ReadonlySignal } from "./index.js";

interface ComputedSpec {
  rawInputs: number[];
  k: number;
}

// Eagerly evaluate every node from scratch (the oracle): bases first, then each
// computed as (sum of its input nodes) + k, in build order. No caching, no
// version skips — a deliberately different evaluation strategy from the engine,
// so a stale/glitched engine value diverges from this reference.
function oracle(
  specs: readonly ComputedSpec[],
  nBase: number,
  baseVals: readonly number[],
): number[] {
  const vals: number[] = [];
  for (let i = 0; i < nBase; i++) {
    vals.push(baseVals[i]!);
  }
  for (let i = 0; i < specs.length; i++) {
    const avail = nBase + i;
    let sum = specs[i]!.k;
    for (const r of specs[i]!.rawInputs) {
      sum += vals[r % avail]!;
    }
    vals.push(sum);
  }
  return vals;
}

const graphArb = fc.record({
  nBase: fc.integer({ min: 1, max: 4 }),
  initial: fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 4, maxLength: 4 }),
  specs: fc.array(
    fc.record({
      rawInputs: fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 4 }),
      k: fc.integer({ min: -5, max: 5 }),
    }),
    { minLength: 1, maxLength: 8 },
  ),
  writes: fc.array(
    fc.record({ idx: fc.nat({ max: 1000 }), val: fc.integer({ min: -100, max: 100 }) }),
    { minLength: 1, maxLength: 6 },
  ),
});

// Build a live signal graph mirroring `specs`: each computed reads readers for
// indices < its own (acyclic by construction), summing them plus its constant.
function buildGraph(
  nBase: number,
  initial: readonly number[],
  specs: readonly ComputedSpec[],
): { bases: { value: number }[]; computeds: ReadonlySignal<number>[] } {
  const bases = Array.from({ length: nBase }, (_, i) => signal(initial[i]!));
  const readers: (() => number)[] = bases.map((s) => () => s.value);
  const computeds: ReadonlySignal<number>[] = [];
  for (let i = 0; i < specs.length; i++) {
    const avail = nBase + i;
    const k = specs[i]!.k;
    const inputs = specs[i]!.rawInputs.map((r) => r % avail);
    const c = computed(() => {
      let sum = k;
      for (const idx of inputs) {
        sum += readers[idx]!();
      }
      return sum;
    });
    computeds.push(c);
    readers.push(() => c.value);
  }
  return { bases, computeds };
}

describe("signal: property — correct propagation (oracle)", () => {
  it("every computed equals an eager from-scratch recompute, across random DAGs and writes", () => {
    fc.assert(
      fc.property(graphArb, ({ nBase, initial, specs, writes }) => {
        const { bases, computeds } = buildGraph(nBase, initial, specs);
        const baseVals = initial.slice(0, nBase);

        let expected = oracle(specs, nBase, baseVals);
        for (let i = 0; i < computeds.length; i++) {
          expect(computeds[i]!.value).toBe(expected[nBase + i]);
        }

        for (const w of writes) {
          const bi = w.idx % nBase;
          baseVals[bi] = w.val;
          bases[bi]!.value = w.val;
        }
        expected = oracle(specs, nBase, baseVals);
        for (let i = 0; i < computeds.length; i++) {
          expect(computeds[i]!.value).toBe(expected[nBase + i]);
        }
      }),
    );
  });
});

describe("signal: property — glitch-freedom", () => {
  it("a batched multi-write fires a downstream effect at most once, never on a stale value", () => {
    fc.assert(
      fc.property(graphArb, ({ nBase, initial, specs, writes }) => {
        const { bases, computeds } = buildGraph(nBase, initial, specs);
        const leaf = computeds[computeds.length - 1]!;
        let runs = 0;
        let lastSeen = 0;
        const dispose = effect(() => {
          lastSeen = leaf.value;
          runs++;
          return undefined;
        });

        const baseVals = initial.slice(0, nBase);
        runs = 0;
        batch(() => {
          for (const w of writes) {
            const bi = w.idx % nBase;
            baseVals[bi] = w.val;
            bases[bi]!.value = w.val;
          }
        });
        const expected = oracle(specs, nBase, baseVals);
        expect(runs).toBeLessThanOrEqual(1);
        if (runs === 1) {
          expect(lastSeen).toBe(expected[expected.length - 1]);
        }
        dispose();
      }),
    );
  });
});

describe("signal: property — batch coalescing", () => {
  it("any sequence of writes in a batch notifies at most once with the final value", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 20 }), (vals) => {
        const s = signal(0);
        let runs = 0;
        let last = 0;
        const dispose = effect(() => {
          last = s.value;
          runs++;
          return undefined;
        });
        runs = 0;
        batch(() => {
          for (const v of vals) {
            s.value = v;
          }
        });
        expect(runs).toBeLessThanOrEqual(1);
        expect(s.peek()).toBe(vals[vals.length - 1]!);
        if (runs === 1) {
          expect(last).toBe(vals[vals.length - 1]!);
        }
        dispose();
      }),
    );
  });
});

describe("signal: property — computed error caching and recovery", () => {
  it("a computed throws iff its current input is bad, and recovers to the correct value", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 12 }),
        (seq) => {
          const s = signal(seq[0]!);
          const c = computed(() => {
            if (s.value === 0) {
              throw new Error("bad");
            }
            return s.value * 2;
          });
          for (const v of seq) {
            s.value = v;
            if (v === 0) {
              expect(() => c.peek()).toThrow("bad");
            } else {
              expect(c.peek()).toBe(v * 2);
            }
          }
        },
      ),
    );
  });
});
