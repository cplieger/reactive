// Reactive signal core — when work is skipped. A computed recomputes only when
// one of its own dependencies changed, an effect re-runs only when one of its
// dependencies actually produced a new version, and the equality comparator
// decides propagation without being allowed to suppress a first value or an
// error recovery. These pin the cost side of the engine's promise: the version
// bookkeeping has to be consulted, not just maintained.
import { describe, it, expect, vi } from "vitest";
import { signal, effect, computed, setEffectErrorHandler } from "./index.js";

describe("computed: recompute only on its own dependencies", () => {
  it("does not recompute when an unrelated signal changes", () => {
    const own = signal(1);
    const unrelated = signal(0);
    const body = vi.fn(() => own.value * 2);
    const c = computed(body);
    const seen: number[] = [];
    // The unrelated signal is read first on purpose: the staleness check walks
    // the effect's dependencies in reverse read order, so reading the computed
    // last is what puts it on the path the check actually takes.
    effect(() => {
      seen.push(unrelated.value + c.value);
      return undefined;
    });
    expect(seen).toEqual([2]);
    expect(body).toHaveBeenCalledTimes(1);

    unrelated.value = 1;
    expect(seen).toEqual([2, 3]);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it("does not recompute on peek() when an unrelated signal changes", () => {
    const own = signal(1);
    const unrelated = signal(0);
    const body = vi.fn(() => own.value * 2);
    const c = computed(body);
    expect(c.peek()).toBe(2);
    expect(body).toHaveBeenCalledTimes(1);

    unrelated.value = 1;
    expect(c.peek()).toBe(2);
    expect(body).toHaveBeenCalledTimes(1);
  });
});

describe("effect: re-run only on a changed dependency", () => {
  it("is not re-run by an unchanged computed when it also reads a signal", () => {
    const other = signal(1);
    const flag = computed(() => other.value > 0);
    const plain = signal(0);
    const seen: string[] = [];
    effect(() => {
      seen.push(`${String(plain.value)}:${String(flag.value)}`);
      return undefined;
    });
    // Move the plain signal's version on, so a stale version comparison would
    // report the effect as needing work.
    plain.value = 1;
    plain.value = 2;
    expect(seen).toEqual(["0:true", "1:true", "2:true"]);

    seen.length = 0;
    other.value = 5; // `flag` stays true, so nothing the effect reads changed
    expect(seen).toEqual([]);
  });

  it("re-observes a cached computed error when another dependency notifies", () => {
    const bad = signal(0);
    const other = signal(1);
    const failing = computed(() => {
      if (bad.value === 0) {
        throw new Error("still-bad");
      }
      return bad.value;
    });
    const stable = computed(() => other.value > 0);
    const errors: unknown[] = [];
    const prev = setEffectErrorHandler((e) => {
      errors.push(e);
    });
    try {
      effect(() => {
        void stable.value;
        void failing.value;
        return undefined;
      });
      expect(errors).toHaveLength(1);

      // `stable` is notified but resolves to the same value, so only the
      // errored dependency can justify re-running the effect — and it must.
      other.value = 2;
      expect(errors).toHaveLength(2);
      expect((errors[1] as Error).message).toBe("still-bad");
    } finally {
      setEffectErrorHandler(prev);
    }
  });
});

describe("computed: equality comparator limits", () => {
  it("produces its first value even when the comparator reports every pair equal", () => {
    const c = computed(() => 5, { equals: () => true });
    expect(c.value).toBe(5);
  });
});
