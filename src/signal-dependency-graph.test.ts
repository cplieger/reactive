// Reactive signal core — maintenance of the source↔target edge lists and of the
// tracking context. The engine links every dependency into two doubly-linked
// lists (the target's sources, the source's targets) and rewires them on every
// re-run; these tests pin the observable consequences of that surgery — a
// sibling's subscription must survive another target dropping the same source,
// a target must keep the dependencies it re-read, a source it stopped reading
// must stop waking it, and refreshing or disposing something mid-run must leave
// the tracking context exactly as it was found.
import { describe, it, expect, vi } from "vitest";
import { signal, effect, computed } from "./index.js";

describe("dropping a dependency", () => {
  it("leaves a sibling effect on the same signal still subscribed", () => {
    const mode = signal(0);
    const shared = signal("s");
    const first: string[] = [];
    const second: string[] = [];
    // `first` subscribes to `shared` before `second`, so it sits behind
    // `second` in `shared`'s target list: unlinking it must not take the
    // sibling ahead of it with it.
    effect(() => {
      if (mode.value === 0) {
        first.push(shared.value);
      }
      return undefined;
    });
    effect(() => {
      second.push(shared.value);
      return undefined;
    });
    expect(first).toEqual(["s"]);
    expect(second).toEqual(["s"]);

    mode.value = 1; // `first` stops reading `shared`
    first.length = 0;
    second.length = 0;
    shared.value = "s2";
    expect(first).toEqual([]);
    expect(second).toEqual(["s2"]);
  });

  it("keeps tracking a dependency that was read after the dropped one", () => {
    const mode = signal(0);
    const dropped = signal("d");
    const kept = signal("k");
    const seen: string[] = [];
    // Read order matters: `dropped` is read before `kept`, so it trails `kept`
    // in the effect's source list. Unlinking a trailing node must not detach
    // the head of the list.
    effect(() => {
      if (mode.value === 0) {
        void dropped.value;
      }
      seen.push(kept.value);
      return undefined;
    });
    expect(seen).toEqual(["k"]);

    mode.value = 1; // drops the dependency on `dropped`
    seen.length = 0;
    kept.value = "k2";
    expect(seen).toEqual(["k2"]);
  });

  it("stops recomputing a computed on a signal it no longer reads", () => {
    const useLeft = signal(true);
    const left = signal(1);
    const right = signal(2);
    const body = vi.fn(() => (useLeft.value ? left.value : right.value));
    const c = computed(body);
    expect(c.value).toBe(1);
    expect(body).toHaveBeenCalledTimes(1);

    useLeft.value = false;
    expect(c.value).toBe(2);
    expect(body).toHaveBeenCalledTimes(2);

    left.value = 99; // `left` is no longer a dependency of `c`
    expect(c.value).toBe(2);
    expect(body).toHaveBeenCalledTimes(2);
  });

  it("stops waking a computed that dropped a source a sibling computed still reads", () => {
    const useShared = signal(true);
    const shared = signal(1);
    // `first` subscribes to `shared` before `second`, so it sits behind
    // `second` in `shared`'s target list: unlinking it must repair the link
    // from the sibling ahead of it, or `shared` keeps waking it.
    const firstBody = vi.fn(() => (useShared.value ? shared.value : -1));
    const first = computed(firstBody);
    const secondBody = vi.fn(() => shared.value * 10);
    const second = computed(secondBody);
    expect(first.value).toBe(1);
    expect(second.value).toBe(10);

    useShared.value = false; // `first` drops `shared`
    expect(first.value).toBe(-1);
    expect(firstBody).toHaveBeenCalledTimes(2);

    shared.value = 2;
    expect(second.value).toBe(20);
    expect(first.value).toBe(-1);
    expect(firstBody).toHaveBeenCalledTimes(2);
  });

  it("stops waking two computeds that both dropped the same source", () => {
    const shared = signal(1);
    const firstOn = signal(true);
    const secondOn = signal(true);
    const firstBody = vi.fn(() => (firstOn.value ? shared.value : -1));
    const first = computed(firstBody);
    const secondBody = vi.fn(() => (secondOn.value ? shared.value * 10 : -10));
    const second = computed(secondBody);
    expect(first.value).toBe(1);
    expect(second.value).toBe(10);

    // The newer subscriber drops the source first, then the older one: the
    // first unlink has to hand the head of the target list over cleanly, or
    // the second unlink leaves the dropped node still linked.
    secondOn.value = false;
    expect(second.value).toBe(-10);
    firstOn.value = false;
    expect(first.value).toBe(-1);
    expect(firstBody).toHaveBeenCalledTimes(2);
    expect(secondBody).toHaveBeenCalledTimes(2);

    shared.value = 2; // nothing reads `shared` any more
    expect(first.value).toBe(-1);
    expect(second.value).toBe(-10);
    expect(firstBody).toHaveBeenCalledTimes(2);
    expect(secondBody).toHaveBeenCalledTimes(2);
  });

  it("is not re-run by an unchanged computed after dropping two dependencies at once", () => {
    const base = signal(1);
    const flag = computed(() => base.value > 0);
    const narrow = signal(false);
    const b = signal("b1");
    const c = signal("c1");
    const seen: string[] = [];
    // The second pass drops `c` and `b` — two edges that are adjacent in the
    // effect's source list — so unlinking the first has to hand the list over
    // to the second cleanly. A leftover edge would report the effect as stale
    // on every later notification.
    effect(() => {
      seen.push(narrow.value ? String(flag.value) : `${String(flag.value)}|${b.value}|${c.value}`);
      return undefined;
    });
    expect(seen).toEqual(["true|b1|c1"]);

    narrow.value = true;
    expect(seen).toEqual(["true|b1|c1", "true"]);

    base.value = 2; // `flag` is notified but stays true, so nothing changed
    expect(seen).toEqual(["true|b1|c1", "true"]);
  });
});

describe("disposing an effect", () => {
  it("leaves a computed on the same signal able to drop it", () => {
    const shared = signal(1);
    const useShared = signal(true);
    const body = vi.fn(() => (useShared.value ? shared.value : -1));
    const c = computed(body);
    expect(c.value).toBe(1); // the computed subscribes to `shared` first

    // The effect subscribes second, so it sits at the head of `shared`'s
    // target list; disposing it must repair the computed's back-link, or the
    // computed can never unsubscribe from `shared` afterwards.
    const dispose = effect(() => {
      void shared.value;
      return undefined;
    });
    dispose();

    useShared.value = false; // the computed drops `shared`
    expect(c.value).toBe(-1);
    expect(body).toHaveBeenCalledTimes(2);

    shared.value = 2;
    expect(c.value).toBe(-1);
    expect(body).toHaveBeenCalledTimes(2);
  });
});

describe("changing read order", () => {
  it("keeps every dependency when a re-run reads them in a different order", () => {
    const order = signal("forward");
    const a = signal("a1");
    const b = signal("b1");
    const c = signal("c1");
    const seen: string[] = [];
    // Re-reading a dependency moves its edge to the head of the effect's
    // source list. Reading them in reverse on the second pass moves a node
    // that has neighbours on both sides, which is the only shape that
    // exercises both halves of that relink.
    effect(() => {
      seen.push(
        order.value === "forward"
          ? `${a.value}|${b.value}|${c.value}`
          : `${c.value}|${b.value}|${a.value}`,
      );
      return undefined;
    });
    expect(seen).toEqual(["a1|b1|c1"]);

    order.value = "reverse";
    expect(seen).toEqual(["a1|b1|c1", "c1|b1|a1"]);

    c.value = "c2";
    expect(seen).toEqual(["a1|b1|c1", "c1|b1|a1", "c2|b1|a1"]);

    b.value = "b2";
    expect(seen).toEqual(["a1|b1|c1", "c1|b1|a1", "c2|b1|a1", "c2|b2|a1"]);

    order.value = "forward";
    expect(seen).toEqual(["a1|b1|c1", "c1|b1|a1", "c2|b1|a1", "c2|b2|a1", "a1|b2|c2"]);
  });
});

describe("tracking context restoration", () => {
  it("keeps later reads tracked after peek() refreshes a stale computed", () => {
    const src = signal(1);
    const derived = computed(() => src.value * 2);
    const tracked = signal("a");
    const seen: string[] = [];
    // The computed is stale on the effect's first pass, so peek() refreshes it
    // from inside the effect; the effect's own tracking must resume afterwards.
    effect(() => {
      void derived.peek();
      seen.push(tracked.value);
      return undefined;
    });
    expect(seen).toEqual(["a"]);

    tracked.value = "b";
    expect(seen).toEqual(["a", "b"]);
  });

  it("keeps later reads tracked after disposing another effect mid-run", () => {
    const trigger = signal(0);
    const tracked = signal("a");
    const cleanup = vi.fn();
    const disposeInner = effect(() => cleanup);
    const seen: string[] = [];
    let disposed = false;
    // Disposing `inner` runs its cleanup untracked; restoring the context
    // afterwards is what keeps the read of `tracked` below a dependency.
    effect(() => {
      void trigger.value;
      if (!disposed) {
        disposed = true;
        disposeInner();
      }
      seen.push(tracked.value);
      return undefined;
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["a"]);

    tracked.value = "b";
    expect(seen).toEqual(["a", "b"]);
  });
});
