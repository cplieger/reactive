import { describe, it, expect, vi, afterEach } from "vitest";
import { createFetch } from "./instance.js";
import type { ApiErr, FailedRequest } from "./types.js";

function stubFetch(res: Response): typeof fetch {
  return vi.fn().mockResolvedValue(res) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFetch — onError", () => {
  it("runs once per failure with the lifted code, and receives the result the caller gets", async () => {
    const seen: [ApiErr, FailedRequest][] = [];
    const fetchFn = stubFetch(
      jsonResponse({ error: "session expired", code: "auth_session_expired" }, 401),
    );
    const fx = createFetch({
      fetchFn,
      onError: (err, req) => {
        seen.push([err, req]);
      },
    });
    const r = await fx.requestRaw("GET", "/me");
    expect(seen).toHaveLength(1);
    const [err, req] = seen[0]!;
    expect(err).toBe(r);
    expect(err).toMatchObject({ ok: false, status: 401, code: "auth_session_expired" });
    expect(req).toEqual({ method: "GET", path: "/me" });
  });

  it("never runs for a 2xx result", async () => {
    const onError = vi.fn();
    const fx = createFetch({ fetchFn: stubFetch(jsonResponse({ a: 1 }, 200)), onError });
    const r = await fx.requestRaw("GET", "/x");
    expect(r.ok).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("runs for a failure that never reached a response, with the library code", async () => {
    const onError = vi.fn();
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const fx = createFetch({ fetchFn: fetchFn as unknown as typeof fetch, onError });
    await fx.requestRaw("POST", "/items", { body: { a: 1 } });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, status: 0, code: "network" }),
      { method: "POST", path: "/items" },
    );
  });

  it("runs for a 2xx whose body fails decoding, since the caller gets a failure", async () => {
    const onError = vi.fn();
    const fx = createFetch({
      fetchFn: stubFetch(new Response("not json", { status: 200 })),
      onError,
    });
    await fx.requestRaw("GET", "/x");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 200, code: "decode" }), {
      method: "GET",
      path: "/x",
    });
  });

  it("runs once when a null-collapsing helper fails", async () => {
    const onError = vi.fn();
    const fx = createFetch({ fetchFn: stubFetch(jsonResponse({ code: "gone" }, 410)), onError });
    expect(await fx.apiGet("/x")).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("logs a throwing onError once and still returns the failure to the caller", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("observer bug");
    const fx = createFetch({
      fetchFn: stubFetch(jsonResponse({ code: "conflict" }, 409)),
      onError: () => {
        throw boom;
      },
    });
    const r = await fx.requestRaw("PUT", "/x", { body: {} });
    expect(r).toMatchObject({ ok: false, status: 409, code: "conflict" });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toContain(boom);
  });

  it("logs an async onError's rejection once and still returns the failure", async () => {
    const boom = new Error("async observer bug");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fx = createFetch({
      fetchFn: stubFetch(jsonResponse({}, 500)),
      onError: () => Promise.reject(boom),
    });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 500 });
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toContain(boom);
  });

  it("still returns the failure when console.error itself throws for a throwing onError", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console failed");
    });
    const fx = createFetch({
      fetchFn: stubFetch(jsonResponse({ code: "conflict" }, 409)),
      onError: () => {
        throw new Error("observer bug");
      },
    });
    await expect(fx.requestRaw("GET", "/x")).resolves.toMatchObject({ ok: false, status: 409 });
  });

  it("raises no unhandled rejection when console.error throws for a rejecting onError", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console failed");
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => {
      e.preventDefault();
      unhandled.push(e.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      const fx = createFetch({
        fetchFn: stubFetch(jsonResponse({}, 500)),
        onError: () => Promise.reject(new Error("async observer bug")),
      });
      await expect(fx.requestRaw("GET", "/x")).resolves.toMatchObject({ ok: false, status: 500 });
      await vi.waitFor(() => {
        expect(logged).toHaveBeenCalled();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });
});
