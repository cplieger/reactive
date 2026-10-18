import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRoot,
  effect,
  resource,
  setEffectErrorHandler,
  signal,
  type EffectErrorHandler,
  type Loadable,
  type Resource,
} from "./index.js";

interface Pending<T> {
  readonly source: unknown;
  readonly signal: AbortSignal;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferredLoad<S, T>(): {
  calls: Pending<T>[];
  load: (source: S, signal: AbortSignal) => Promise<T>;
} {
  const calls: Pending<T>[] = [];
  return {
    calls,
    load: (source, sig) =>
      new Promise<T>((resolve, reject) => {
        calls.push({ source, signal: sig, resolve, reject });
      }),
  };
}

function call<T>(calls: readonly Pending<T>[], i: number): Pending<T> {
  const c = calls[i];
  if (c === undefined) {
    throw new Error(`no load call ${String(i)}`);
  }
  return c;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let errors: unknown[];
let previousHandler: EffectErrorHandler;
let disposers: (() => void)[];

beforeEach(() => {
  errors = [];
  disposers = [];
  previousHandler = setEffectErrorHandler((e) => {
    errors.push(e);
  });
});

afterEach(() => {
  for (const d of disposers) {
    d();
  }
  setEffectErrorHandler(previousHandler);
});

function inRoot<T>(fn: () => T): { value: T; dispose: () => void } {
  return createRoot((dispose) => {
    disposers.push(dispose);
    return { value: fn(), dispose };
  });
}

describe("a superseded run writes nothing", () => {
  it("when the source changes before it settles", async () => {
    const id = signal("a");
    const { calls, load } = deferredLoad<string, string>();
    const { value: r } = inRoot(() => resource(() => id.value, load));
    id.value = "b";
    expect(call(calls, 0).signal.aborted).toBe(true);
    expect(call(calls, 1).source).toBe("b");
    call(calls, 1).resolve("B");
    await settle();
    call(calls, 0).resolve("A");
    await settle();
    expect(r.peek()).toEqual({ state: "ready", data: "B" });
  });

  it("when refetch starts a new run", async () => {
    const { calls, load } = deferredLoad<number, string>();
    const { value: r } = inRoot(() => resource(() => 1, load));
    r.refetch();
    expect(calls.length).toBe(2);
    expect(call(calls, 0).signal.aborted).toBe(true);
    call(calls, 1).resolve("second");
    await settle();
    call(calls, 0).reject(new Error("late"));
    await settle();
    expect(r.peek()).toEqual({ state: "ready", data: "second" });
  });

  it("when its owner is disposed", async () => {
    const { calls, load } = deferredLoad<number, string>();
    const { value: r, dispose } = inRoot(() => resource(() => 1, load));
    const seen: Loadable<string>[] = [];
    const stop = effect(() => {
      seen.push(r.value);
    });
    dispose();
    expect(call(calls, 0).signal.aborted).toBe(true);
    call(calls, 0).resolve("late");
    await settle();
    expect(seen).toEqual([{ state: "loading" }]);
    stop();
  });

  it("refetch after disposal starts no run", () => {
    const { calls, load } = deferredLoad<number, string>();
    const { value: r, dispose } = inRoot(() => resource(() => 1, load));
    dispose();
    r.refetch();
    expect(calls.length).toBe(1);
  });
});

describe("stale data", () => {
  it("a rejection keeps the last good data in the error arm, and the next loading carries it", async () => {
    const { calls, load } = deferredLoad<number, string>();
    const { value: r } = inRoot(() => resource(() => 1, load));
    call(calls, 0).resolve("good");
    await settle();
    r.refetch();
    expect(r.peek()).toEqual({ state: "loading", stale: "good" });
    const failure = new Error("502");
    call(calls, 1).reject(failure);
    await settle();
    expect(r.peek()).toEqual({ state: "error", error: failure, stale: "good" });
    r.refetch();
    expect(r.peek()).toEqual({ state: "loading", stale: "good" });
  });

  it("an error with no good data before it carries no stale key", async () => {
    const { calls, load } = deferredLoad<number, string>();
    const { value: r } = inRoot(() => resource(() => 1, load));
    call(calls, 0).reject("down");
    await settle();
    expect(r.peek()).toStrictEqual({ state: "error", error: "down" });
  });

  it("a synchronous throw from load becomes the error arm", async () => {
    const boom = new Error("sync");
    const { value: r } = inRoot(() =>
      resource(
        () => 1,
        (): Promise<string> => {
          throw boom;
        },
      ),
    );
    await settle();
    expect(r.peek()).toEqual({ state: "error", error: boom });
    expect(errors).toEqual([]);
  });
});

describe("construction", () => {
  it("throws outside an owner", () => {
    expect(() =>
      resource(
        () => 1,
        () => Promise.resolve(1),
      ),
    ).toThrow("reactive: cannot create a resource outside an owner");
  });

  it("throws inside a disposal callback", () => {
    createRoot((dispose, owner) => {
      owner.onDispose(() => {
        resource(
          () => 1,
          () => Promise.resolve(1),
        );
      });
      dispose();
    });
    expect(errors.map((e) => (e instanceof Error ? e.message : e))).toEqual([
      "reactive: cannot create a resource under an owner that is being disposed",
    ]);
  });

  it("load runs untracked, with its run's owner current", async () => {
    const outside = signal(0);
    const id = signal(1);
    let loads = 0;
    let runCleanups = 0;
    inRoot(() =>
      resource(
        () => id.value,
        (_s, sig) => {
          loads++;
          void outside.value;
          effect(() => () => {
            runCleanups++;
          });
          expect(sig.aborted).toBe(false);
          return Promise.resolve(loads);
        },
      ),
    );
    outside.value = 1;
    expect(loads).toBe(1);
    id.value = 2;
    expect(loads).toBe(2);
    expect(runCleanups).toBe(1);
    await settle();
  });

  it("a throw from source goes to the error handler and starts no run", () => {
    const boom = new Error("source");
    let loads = 0;
    const { value: r } = inRoot(() =>
      resource(
        (): number => {
          throw boom;
        },
        () => {
          loads++;
          return Promise.resolve(1);
        },
      ),
    );
    r.refetch();
    expect(loads).toBe(0);
    expect(errors).toEqual([boom]);
    expect(r.peek()).toEqual({ state: "loading" });
  });
});

describe("source equality", () => {
  it("an equal source value under options.equals starts no run", () => {
    const query = signal({ id: 1, page: 0 });
    const { calls, load } = deferredLoad<{ id: number; page: number }, string>();
    inRoot(() => resource(() => query.value, load, { equals: (a, b) => a.id === b.id }));
    query.value = { id: 1, page: 2 };
    expect(calls.length).toBe(1);
    query.value = { id: 2, page: 2 };
    expect(calls.length).toBe(2);
  });

  it("refetch after an equal source value loads the latest one", () => {
    const query = signal({ id: 1, page: 0 });
    const { calls, load } = deferredLoad<{ id: number; page: number }, string>();
    const { value: r } = inRoot(() =>
      resource(() => query.value, load, { equals: (a, b) => a.id === b.id }),
    );
    query.value = { id: 1, page: 2 };
    r.refetch();
    expect(calls.map((c) => c.source)).toEqual([
      { id: 1, page: 0 },
      { id: 1, page: 2 },
    ]);
  });

  it("without options.equals a new object is a new source value", () => {
    const query = signal({ id: 1 });
    const { calls, load } = deferredLoad<{ id: number }, string>();
    inRoot(() => resource(() => query.value, load));
    query.value = { id: 1 };
    expect(calls.length).toBe(2);
  });

  it("a source re-run to the same value starts no run", () => {
    const a = signal(1);
    const b = signal(0);
    const { calls, load } = deferredLoad<number, string>();
    inRoot(() => resource(() => a.value + b.value * 0, load));
    b.value = 1;
    expect(calls.length).toBe(1);
  });

  it("is reactive to readers through value", async () => {
    const { calls, load } = deferredLoad<number, string>();
    let r: Resource<string> | undefined;
    const states: string[] = [];
    inRoot(() => {
      r = resource(() => 1, load);
      const res = r;
      effect(() => {
        states.push(res.value.state);
      });
    });
    call(calls, 0).resolve("x");
    await settle();
    expect(states).toEqual(["loading", "ready"]);
  });
});
