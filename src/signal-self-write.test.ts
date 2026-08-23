// Reactive signal core — a computed that writes a signal it also reads.
// notifyTargets cannot recurse into a computed that is mid-evaluation (that is
// how a ping-pong gets built), but it must still record that the computed's
// input moved, or the DIRTY pre-check at every refresh call site skips the
// refresh forever and the computed serves its pre-write value for the rest of
// the program while the source it reads has already moved on.
import { describe, it, expect, vi } from "vitest";
import { signal, computed, effect, setEffectErrorHandler } from "./index.js";

describe("computed: a write during its own evaluation", () => {
  it("is observed by the next read of the computed", () => {
    const s = signal(0);
    const body = vi.fn(() => {
      const v = s.value;
      if (v === 0) {
        s.value = 1;
      }
      return v;
    });
    const c = computed(body);

    // The run that did the write still returns the value it read.
    expect(c.value).toBe(0);
    expect(s.peek()).toBe(1);
    // The next read sees the write, instead of serving 0 forever.
    expect(c.value).toBe(1);
    expect(body).toHaveBeenCalledTimes(2);
    // And it settles: the second run wrote nothing, so nothing is stale.
    expect(c.value).toBe(1);
    expect(body).toHaveBeenCalledTimes(2);
  });

  it("is observed by the next peek() of the computed", () => {
    const s = signal(0);
    const body = vi.fn(() => {
      const v = s.value;
      if (v === 0) {
        s.value = 1;
      }
      return v;
    });
    const c = computed(body);

    expect(c.peek()).toBe(0);
    expect(c.peek()).toBe(1);
    expect(body).toHaveBeenCalledTimes(2);
  });

  it("does not report a cycle when the computed already has a subscriber", () => {
    const errors: unknown[] = [];
    const prev = setEffectErrorHandler((e) => {
      errors.push(e);
    });
    try {
      const armed = signal(0);
      const s = signal(0);
      const c = computed(() => {
        const on = armed.value;
        const v = s.value;
        if (on === 1) {
          s.value = v + 1;
        }
        return v;
      });
      effect(() => {
        void c.value;
        return undefined;
      });

      // The computed now has a live subscriber, which is the shape where
      // recursing out of a RUNNING node bites: the subscriber gets queued, the
      // drain reaches it while the computed is still RUNNING, and the refresh
      // reports a cycle that is not one.
      armed.value = 1;

      expect(errors).toEqual([]);
      expect(s.peek()).toBe(1);
    } finally {
      setEffectErrorHandler(prev);
    }
  });
});

describe("computed: successive reads of a self-writing computed", () => {
  it("converges instead of freezing on the first value that repeated", () => {
    const s = signal(0);
    const body = vi.fn(() => {
      const v = s.value;
      if (v < 2) {
        s.value = v + 1;
      }
      return v < 2 ? "pending" : `done:${String(v)}`;
    });
    const c = computed(body);

    // Runs 1 and 2 both return "pending", so the equality check says unchanged —
    // and the unchanged path is exactly where the staleness recorded during the
    // evaluation could be thrown away, freezing the computed on "pending" while
    // its source has already moved past the value that produced it.
    expect(c.value).toBe("pending");
    expect(c.value).toBe("pending");
    expect(c.value).toBe("done:2");
    expect(body).toHaveBeenCalledTimes(3);

    // Settled: the third run wrote nothing, so nothing is stale.
    expect(c.value).toBe("done:2");
    expect(body).toHaveBeenCalledTimes(3);
  });
});

describe("computed: a refresh demanded while the computed is mid-evaluation", () => {
  it("reports a cycle instead of re-entering the evaluation", () => {
    const errors: unknown[] = [];
    const prev = setEffectErrorHandler((e) => {
      errors.push(e);
    });
    try {
      const armed = signal(0);
      const s = signal(0);
      const c = computed(() => {
        const on = armed.value;
        const v = s.value;
        if (on === 1) {
          s.value = v + 1;
        }
        return v;
      });
      const seen: number[] = [];
      // The subscriber depends on `s` as well as on `c`. That is what makes the
      // write inside `c`'s own body queue this effect and drain it while `c` is
      // still RUNNING — the case the sibling test above cannot reach, because a
      // subscriber that reads only `c` has already been dequeued by then.
      effect(() => {
        void s.value;
        seen.push(c.value);
        return undefined;
      });
      expect(seen).toEqual([0]);

      armed.value = 1;

      // Re-entering would recompute from a half-prepared dependency set and
      // write `s` again on every pass, so the guard reports rather than recurses.
      expect(errors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([
        "Cycle detected",
      ]);
      // Exactly one pass wrote, so `s` advanced exactly once.
      expect(s.peek()).toBe(1);
      expect(seen).toEqual([0]);
    } finally {
      setEffectErrorHandler(prev);
    }
  });
});
