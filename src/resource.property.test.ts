import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createRoot, resource, signal } from "./index.js";

type Step =
  | { readonly kind: "source"; readonly value: number }
  | { readonly kind: "refetch" }
  | { readonly kind: "settle"; readonly pick: number; readonly fail: boolean };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("source" as const), value: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ kind: fc.constant("refetch" as const) }),
  fc.record({ kind: fc.constant("settle" as const), pick: fc.nat(), fail: fc.boolean() }),
);

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Call {
  readonly run: number;
  readonly resolve: (v: string) => void;
  readonly reject: (e: unknown) => void;
}

describe("resource under interleaved runs and settlements", () => {
  it("ends at the last run's answer, whatever order earlier runs settle in", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { maxLength: 25 }), async (steps) => {
        const src = signal(0);
        const open: Call[] = [];
        const sources: number[] = [];
        const outcomes = new Map<number, { readonly ok: boolean; readonly text: string }>();
        let runs = 0;
        const { r, dispose } = createRoot((d) => ({
          dispose: d,
          r: resource(
            () => src.value,
            (source) =>
              new Promise<string>((resolve, reject) => {
                sources.push(source);
                open.push({ run: runs++, resolve, reject });
              }),
          ),
        }));
        for (const step of steps) {
          if (step.kind === "source") {
            src.value = step.value;
          } else if (step.kind === "refetch") {
            r.refetch();
          } else if (open.length > 0) {
            const [c] = open.splice(step.pick % open.length, 1);
            if (c !== undefined) {
              const text = `${step.fail ? "fail" : "ok"} ${String(c.run)}`;
              outcomes.set(c.run, { ok: !step.fail, text });
              if (step.fail) {
                c.reject(text);
              } else {
                c.resolve(text);
              }
            }
            await tick();
          }
        }
        // Settle what is left, newest first, so every older run settles after it.
        for (const c of open.reverse()) {
          const text = `ok ${String(c.run)}`;
          outcomes.set(c.run, { ok: true, text });
          c.resolve(text);
        }
        await tick();
        const last = outcomes.get(runs - 1);
        expect(sources[runs - 1]).toBe(src.peek());
        expect(r.peek()).toMatchObject(
          last?.ok === true
            ? { state: "ready", data: last.text }
            : { state: "error", error: last?.text },
        );
        dispose();
      }),
      { numRuns: 150 },
    );
  });
});
