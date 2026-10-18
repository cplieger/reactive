import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createRoot, effect, runWithOwner, signal, type Owner } from "./index.js";

type Op =
  | { readonly kind: "root"; readonly parent: number }
  | { readonly kind: "effect"; readonly owner: number; readonly writesOnCleanup: boolean }
  | { readonly kind: "dispose"; readonly owner: number }
  | { readonly kind: "write" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("root" as const), parent: fc.nat() }),
  fc.record({
    kind: fc.constant("effect" as const),
    owner: fc.nat(),
    writesOnCleanup: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("dispose" as const), owner: fc.nat() }),
  fc.record({ kind: fc.constant("write" as const) }),
);

interface ModelOwner {
  readonly owner: Owner;
  readonly dispose: () => void;
  readonly parent: number | undefined;
  dead: boolean;
}

// The model tracks the tree on its own and marks a subtree dead before the
// library disposes it, so any run the library allows past that point counts.
function run(ops: readonly Op[]): { deadRuns: number; liveMissed: number } {
  const s = signal(0);
  const t = signal(0);
  const owners: ModelOwner[] = [];
  const effects: { owner: number | undefined; runs: number; reads: boolean }[] = [];
  let deadRuns = 0;
  let liveMissed = 0;

  const isDead = (i: number | undefined): boolean => i !== undefined && owners[i]?.dead === true;
  // Index 0 is "no owner"; i > 0 names owners[i - 1].
  const pick = (n: number): number | undefined =>
    n % (owners.length + 1) === 0 ? undefined : (n % (owners.length + 1)) - 1;
  const under = <T>(i: number | undefined, fn: () => T): T | undefined => {
    if (i === undefined) {
      return fn();
    }
    const o = owners[i];
    return o === undefined ? undefined : runWithOwner(o.owner, fn);
  };

  for (const op of ops) {
    switch (op.kind) {
      case "root": {
        const parent = pick(op.parent);
        const made = under(parent, () => createRoot((dispose, owner) => ({ dispose, owner })));
        if (made !== undefined) {
          owners.push({ ...made, parent, dead: false });
        }
        break;
      }
      case "effect": {
        const owner = pick(op.owner);
        const index = effects.length;
        const record = { owner, runs: 0, reads: !op.writesOnCleanup };
        const made = under(owner, () =>
          effect(() => {
            void s.value;
            if (record.reads) {
              void t.value;
            }
            if (isDead(owner)) {
              deadRuns++;
            }
            record.runs++;
            return op.writesOnCleanup
              ? () => {
                  t.value = t.peek() + 1;
                }
              : undefined;
          }),
        );
        if (made !== undefined) {
          effects[index] = record;
        }
        break;
      }
      case "dispose": {
        const i = pick(op.owner);
        const target = i === undefined ? undefined : owners[i];
        if (target === undefined) {
          break;
        }
        const mark = (j: number): void => {
          const o = owners[j];
          if (o === undefined || o.dead) {
            return;
          }
          o.dead = true;
          owners.forEach((child, k) => {
            if (child.parent === j) {
              mark(k);
            }
          });
        };
        if (i !== undefined) {
          mark(i);
        }
        target.dispose();
        break;
      }
      case "write": {
        const before = effects.map((e) => e.runs);
        s.value = s.peek() + 1;
        effects.forEach((e, k) => {
          if (!isDead(e.owner) && e.runs === before[k]) {
            liveMissed++;
          }
        });
        break;
      }
    }
  }
  for (const o of owners) {
    o.dispose();
  }
  return { deadRuns, liveMissed };
}

describe("owner trees", () => {
  it("never run an effect of a disposed owner, and keep every live effect running", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        expect(run(ops)).toEqual({ deadRuns: 0, liveMissed: 0 });
      }),
      { numRuns: 300 },
    );
  });
});
