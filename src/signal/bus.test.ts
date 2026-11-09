import { describe, it, expect, vi } from "vitest";

import { createBus } from "./bus.js";

interface Events {
  ping: undefined;
  num: number;
  obj: { id: string };
}

describe("createBus", () => {
  it("on/emit delivers typed payloads; unsubscribe stops delivery", () => {
    expect.assertions(2);
    const bus = createBus<Events>();
    const seen: number[] = [];
    const off = bus.on("num", (n) => seen.push(n));
    bus.emit("num", 1);
    bus.emit("num", 2);
    off();
    bus.emit("num", 3);
    expect(seen).toEqual([1, 2]);
    expect(bus).toBeDefined();
  });

  it("void events emit with no payload arg", () => {
    expect.assertions(2);
    const bus = createBus<Events>();
    const handler = vi.fn<() => void>();
    bus.on("ping", handler);
    bus.emit("ping");
    bus.emit("ping");
    expect(handler).toHaveBeenCalledTimes(2);
    // A `() => void` handler must be invoked with zero arguments, not a stray
    // `undefined`.
    expect(handler).toHaveBeenCalledWith();
  });

  it("once fires exactly once then auto-unsubscribes", () => {
    expect.assertions(1);
    const bus = createBus<Events>();
    const seen: number[] = [];
    bus.once("num", (n) => seen.push(n));
    bus.emit("num", 1);
    bus.emit("num", 2);
    expect(seen).toEqual([1]);
  });

  it("off removes a specific handler; clear removes per-event or all", () => {
    expect.assertions(3);
    const bus = createBus<Events>();
    let a = 0;
    let b = 0;
    const ha = (): void => {
      a++;
    };
    const hb = (): void => {
      b++;
    };
    bus.on("ping", ha);
    bus.on("ping", hb);
    bus.off("ping", ha);
    bus.emit("ping");
    expect(a).toBe(0);
    expect(b).toBe(1);
    bus.clear("ping");
    bus.emit("ping");
    expect(b).toBe(1);
  });

  it("a handler unsubscribed DURING emit still fires for that emit (snapshot)", () => {
    expect.assertions(2);
    const bus = createBus<Events>();
    const order: string[] = [];
    const ctl: { offB: () => void } = { offB: () => undefined };
    bus.on("ping", () => {
      order.push("a");
      ctl.offB(); // unsubscribe b mid-emit
    });
    ctl.offB = bus.on("ping", () => {
      order.push("b");
    });
    bus.emit("ping"); // both fire (b was in the snapshot)
    bus.emit("ping"); // only a fires now
    expect(order).toEqual(["a", "b", "a"]);
    expect(order.filter((x) => x === "b")).toHaveLength(1);
  });

  it("a throwing handler is isolated: siblings still run, onError is called", () => {
    expect.assertions(3);
    const onError = vi.fn();
    const bus = createBus<Events>({ onError });
    let reached = false;
    bus.on("num", () => {
      throw new Error("boom");
    });
    bus.on("num", () => {
      reached = true;
    });
    bus.emit("num", 1);
    expect(reached).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("num", expect.any(Error));
  });
});

describe("createBus: clear with no event", () => {
  it("removes the handlers of every event, not just one", () => {
    expect.assertions(2);
    const bus = createBus<Events>();
    const ping = vi.fn<() => void>();
    const num = vi.fn<(n: number) => void>();
    bus.on("ping", ping);
    bus.on("num", num);

    bus.clear();

    bus.emit("ping");
    bus.emit("num", 1);
    expect(ping).not.toHaveBeenCalled();
    expect(num).not.toHaveBeenCalled();
  });
});

describe("createBus: the built-in onError", () => {
  it("reports a throwing handler to console.error when no onError was supplied", () => {
    expect.assertions(2);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const bus = createBus<Events>(); // no onError → the built-in default
      bus.on("num", () => {
        throw new Error("boom");
      });
      bus.emit("num", 1);
      // Without this the default swallows handler errors silently.
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith('[bus] handler error for "num":', expect.any(Error));
    } finally {
      logged.mockRestore();
    }
  });
});
