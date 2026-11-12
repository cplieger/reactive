import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFetch } from "./instance.js";
import { API_TIMEOUT_MS, withTimeout } from "./timeout.js";

function abortedWith(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      resolve(signal.reason);
    });
  });
}

describe("API_TIMEOUT_MS", () => {
  it("defaults to 30 seconds", () => {
    expect(API_TIMEOUT_MS).toBe(30_000);
  });
});

describe("withTimeout", () => {
  it("returns a fresh, non-aborted signal when no caller signal is given", () => {
    const signal = withTimeout(undefined, 60_000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("returns a signal that aborts when the caller signal aborts", () => {
    const ac = new AbortController();
    const composed = withTimeout(ac.signal, 60_000);
    expect(composed.aborted).toBe(false);
    ac.abort();
    expect(composed.aborted).toBe(true);
  });

  it("is already aborted when the caller signal is already aborted", () => {
    const ac = new AbortController();
    ac.abort();
    const composed = withTimeout(ac.signal, 60_000);
    expect(composed.aborted).toBe(true);
  });
});

/** A request whose fetchFn holds its abort rejection until the test releases
 *  it, so the caller can abort after the timeout has already won. */
async function timeoutThenCallerAbort(): Promise<unknown> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let timedOut: Promise<unknown> | undefined;
  const fetchFn = ((_url: string, init: RequestInit) => {
    timedOut = abortedWith(init.signal!);
    return timedOut.then(async (reason) => {
      await held;
      throw reason;
    });
  }) as unknown as typeof fetch;
  const ac = new AbortController();
  const pending = createFetch({ fetchFn }).requestRaw("GET", "/slow", {
    signal: ac.signal,
    timeoutMs: 10,
  });
  await vi.waitFor(() => {
    expect(timedOut).toBeDefined();
  });
  expect(await timedOut).toMatchObject({ name: "TimeoutError" });
  ac.abort();
  release();
  return pending;
}

/** A request whose fetchFn, once the timeout has won, aborts the caller with
 *  that same reason object and then rejects with it. */
async function timeoutThenCallerAbortWithItsReason(): Promise<unknown> {
  const ac = new AbortController();
  const fetchFn = ((_url: string, init: RequestInit) =>
    abortedWith(init.signal!).then((reason) => {
      ac.abort(reason);
      throw reason;
    })) as unknown as typeof fetch;
  const result = await createFetch({ fetchFn }).requestRaw("GET", "/slow", {
    signal: ac.signal,
    timeoutMs: 10,
  });
  expect(ac.signal.aborted).toBe(true);
  return result;
}

/** A request the caller aborts while it is in flight, long before its timeout. */
async function callerAbortsFirst(): Promise<unknown> {
  let sent: AbortSignal | undefined;
  const fetchFn = ((_url: string, init: RequestInit) => {
    sent = init.signal ?? undefined;
    return abortedWith(init.signal!).then((reason) => Promise.reject(reason));
  }) as unknown as typeof fetch;
  const ac = new AbortController();
  const pending = createFetch({ fetchFn }).requestRaw("GET", "/slow", {
    signal: ac.signal,
    timeoutMs: 2_000,
  });
  await vi.waitFor(() => {
    expect(sent).toBeDefined();
  });
  ac.abort();
  expect(sent?.aborted).toBe(true);
  return pending;
}

/** A request whose caller signal is already aborted, sent through a fetchFn
 *  that rejects an aborted signal with its reason as the platform does. */
function callerAbortedBeforeTheRequest(): Promise<unknown> {
  const fetchFn = ((_url: string, init: RequestInit) =>
    init.signal?.aborted === true
      ? Promise.reject(init.signal.reason as Error)
      : new Promise<never>(() => undefined)) as unknown as typeof fetch;
  return createFetch({ fetchFn }).requestRaw("GET", "/slow", { signal: AbortSignal.abort() });
}

/** A request whose fetchFn, once the timeout has won, aborts the caller,
 *  dispatches a second "abort" event on the signal it was given, and then
 *  rejects with the timeout's reason. */
async function timeoutThenCallerAbortAndRedispatch(): Promise<unknown> {
  const ac = new AbortController();
  const fetchFn = ((_url: string, init: RequestInit) => {
    const signal = init.signal!;
    return abortedWith(signal).then((reason) => {
      ac.abort(new Error("too late"));
      signal.dispatchEvent(new Event("abort"));
      throw reason;
    });
  }) as unknown as typeof fetch;
  return createFetch({ fetchFn }).requestRaw("GET", "/slow", { signal: ac.signal, timeoutMs: 10 });
}

/** A request whose fetchFn dispatches an "abort" event on its signal before
 *  anything aborted, then the caller really aborts it. */
async function syntheticAbortThenCallerAbort(): Promise<unknown> {
  let sent: AbortSignal | undefined;
  const fetchFn = ((_url: string, init: RequestInit) => {
    const signal = init.signal!;
    signal.dispatchEvent(new Event("abort"));
    sent = signal;
    return abortedWith(signal).then((reason) => Promise.reject(reason));
  }) as unknown as typeof fetch;
  const ac = new AbortController();
  const pending = createFetch({ fetchFn }).requestRaw("GET", "/slow", {
    signal: ac.signal,
    timeoutMs: 2_000,
  });
  await vi.waitFor(() => {
    expect(sent).toBeDefined();
  });
  expect(sent?.aborted).toBe(false);
  ac.abort();
  return pending;
}

/** A request whose fetchFn hooks the signal it was given as soon as it is
 *  called: on the timeout's abort it aborts the caller with the same reason,
 *  then rejects with it a macrotask later. */
function timeoutThenCallerAbortFromAListener(): Promise<unknown> {
  const ac = new AbortController();
  const fetchFn = ((_url: string, init: RequestInit) =>
    new Promise<never>((_resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener("abort", () => {
        ac.abort(signal.reason);
        setTimeout(() => {
          reject(signal.reason as Error);
        }, 0);
      });
    })) as unknown as typeof fetch;
  return createFetch({ fetchFn }).requestRaw("GET", "/slow", { signal: ac.signal, timeoutMs: 10 });
}

const cancelled = { ok: false, status: 0, code: "cancelled", error: "request cancelled" };
const timeoutResult = { ok: false, status: 0, code: "timeout" };

describe("requestRaw — which abort won", () => {
  it("stays a timeout when the caller aborts after the timeout won", async () => {
    expect(await timeoutThenCallerAbort()).toMatchObject({ ok: false, status: 0, code: "timeout" });
  });

  it("stays a timeout when the later caller abort reuses the timeout's reason", async () => {
    expect(await timeoutThenCallerAbortWithItsReason()).toMatchObject({
      ok: false,
      status: 0,
      code: "timeout",
    });
  });

  it("is cancelled when the caller aborts before the timeout", async () => {
    expect(await callerAbortsFirst()).toEqual(cancelled);
  });

  it("is cancelled when the caller signal is already aborted", async () => {
    expect(await callerAbortedBeforeTheRequest()).toEqual(cancelled);
  });

  it("stays a timeout when the caller aborts and the signal's abort event fires again", async () => {
    expect(await timeoutThenCallerAbortAndRedispatch()).toMatchObject(timeoutResult);
  });

  it("is cancelled when an abort event fired before the caller aborted", async () => {
    expect(await syntheticAbortThenCallerAbort()).toEqual(cancelled);
  });

  it("stays a timeout when the fetchFn's own abort listener aborts the caller", async () => {
    expect(await timeoutThenCallerAbortFromAListener()).toMatchObject(timeoutResult);
  });
});

describe("requestRaw — a caller abort with a NaN reason", () => {
  it("is cancelled, not a network failure", async () => {
    let sent: AbortSignal | undefined;
    const fetchFn = ((_url: string, init: RequestInit) => {
      sent = init.signal ?? undefined;
      return abortedWith(init.signal!).then((reason) => Promise.reject(reason));
    }) as unknown as typeof fetch;
    const ac = new AbortController();
    const pending = createFetch({ fetchFn }).requestRaw("GET", "/slow", { signal: ac.signal });
    await vi.waitFor(() => {
      expect(sent).toBeDefined();
    });
    ac.abort(Number.NaN);
    expect(await pending).toEqual(cancelled);
  });
});

describe("withTimeout without AbortSignal.any", () => {
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(AbortSignal, "any");
    delete (AbortSignal as { any?: unknown }).any;
  });

  afterEach(() => {
    if (original !== undefined) {
      Object.defineProperty(AbortSignal, "any", original);
    }
  });

  it("aborts with the caller's reason when the caller aborts first", () => {
    const ac = new AbortController();
    const composed = withTimeout(ac.signal, 60_000);
    expect(composed.aborted).toBe(false);
    const reason = new Error("caller gave up");
    ac.abort(reason);
    expect(composed.aborted).toBe(true);
    expect(composed.reason).toBe(reason);
  });

  it("is already aborted, with the caller's reason, when the caller signal already is", () => {
    const reason = new Error("already gone");
    const composed = withTimeout(AbortSignal.abort(reason), 60_000);
    expect(composed.aborted).toBe(true);
    expect(composed.reason).toBe(reason);
  });

  it("aborts with a TimeoutError when the timeout fires first, and ignores a later caller abort", async () => {
    const ac = new AbortController();
    const composed = withTimeout(ac.signal, 10);
    const reason = await abortedWith(composed);
    expect(reason).toBeInstanceOf(DOMException);
    expect((reason as DOMException).name).toBe("TimeoutError");
    ac.abort(new Error("too late"));
    expect(composed.reason).toBe(reason);
  });

  it("stays a timeout when the caller aborts after the timeout won", async () => {
    expect(await timeoutThenCallerAbort()).toMatchObject({ ok: false, status: 0, code: "timeout" });
  });

  it("stays a timeout when the later caller abort reuses the timeout's reason", async () => {
    expect(await timeoutThenCallerAbortWithItsReason()).toMatchObject({
      ok: false,
      status: 0,
      code: "timeout",
    });
  });

  it("cancels an in-flight request when the caller aborts before the timeout", async () => {
    expect(await callerAbortsFirst()).toEqual(cancelled);
  });

  it("is cancelled when the caller signal is already aborted", async () => {
    expect(await callerAbortedBeforeTheRequest()).toEqual(cancelled);
  });

  it("stays a timeout when the caller aborts and the signal's abort event fires again", async () => {
    expect(await timeoutThenCallerAbortAndRedispatch()).toMatchObject(timeoutResult);
  });

  it("is cancelled when an abort event fired before the caller aborted", async () => {
    expect(await syntheticAbortThenCallerAbort()).toEqual(cancelled);
  });

  it("stays a timeout when the fetchFn's own abort listener aborts the caller", async () => {
    expect(await timeoutThenCallerAbortFromAListener()).toMatchObject(timeoutResult);
  });
});
