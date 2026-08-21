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
