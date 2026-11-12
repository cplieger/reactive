// Config behavior of createFetch instances: baseUrl joining, prepareHeaders,
// credentials, per-request headers, and origin-override protection.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createFetch } from "./instance.js";

function stubFetch(res: Response): typeof fetch {
  return vi.fn().mockResolvedValue(res) as unknown as typeof fetch;
}
function urlOf(fn: typeof fetch): string {
  return (fn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![0];
}
function initOf(fn: typeof fetch): RequestInit {
  return (fn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFetch — baseUrl join", () => {
  it("prepends baseUrl to the path", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ baseUrl: "https://api.example.com/v1", fetchFn });
    await fx.requestRaw("GET", "/items/42");
    expect(urlOf(fetchFn)).toBe("https://api.example.com/v1/items/42");
  });

  it("collapses the double slash when base ends with '/' and path starts with '/'", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ baseUrl: "https://api.example.com/", fetchFn });
    await fx.requestRaw("GET", "/items/42");
    expect(urlOf(fetchFn)).toBe("https://api.example.com/items/42");
  });

  it("inserts a single slash when base has a trailing slash and path has no leading slash", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ baseUrl: "https://api.example.com/", fetchFn });
    await fx.requestRaw("GET", "items");
    expect(urlOf(fetchFn)).toBe("https://api.example.com/items");
  });

  it("inserts a single slash when neither base nor path carry one", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ baseUrl: "https://api.example.com", fetchFn });
    await fx.requestRaw("GET", "items");
    expect(urlOf(fetchFn)).toBe("https://api.example.com/items");
  });

  it("preserves the query string", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ baseUrl: "https://api.example.com/v1", fetchFn });
    await fx.requestRaw("GET", "/items?foo=bar&baz=1");
    expect(urlOf(fetchFn)).toBe("https://api.example.com/v1/items?foo=bar&baz=1");
  });

  it("passes the path verbatim when no baseUrl is set", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    await fx.requestRaw("GET", "/items/1");
    expect(urlOf(fetchFn)).toBe("/items/1");
  });
});

describe("createFetch — prepareHeaders", () => {
  it("injects headers by mutating the provided instance", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({
      fetchFn,
      prepareHeaders: (headers) => {
        headers.set("Authorization", "Bearer tok");
      },
    });
    await fx.requestRaw("GET", "/me");
    expect((initOf(fetchFn).headers as Headers).get("authorization")).toBe("Bearer tok");
  });

  it("honors a Headers object returned by prepareHeaders, replacing the mutated one", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({
      fetchFn,
      prepareHeaders: (headers) => {
        headers.set("X-Mutated", "ignored");
        const replacement = new Headers();
        replacement.set("Authorization", "Bearer returned");
        return replacement;
      },
    });
    await fx.requestRaw("GET", "/x");
    const headers = initOf(fetchFn).headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer returned");
    expect(headers.get("x-mutated")).toBeNull();
  });

  it("awaits an async prepareHeaders", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({
      fetchFn,
      prepareHeaders: async (headers) => {
        await Promise.resolve();
        headers.set("X-Async", "1");
        return undefined;
      },
    });
    await fx.requestRaw("GET", "/x");
    expect((initOf(fetchFn).headers as Headers).get("x-async")).toBe("1");
  });

  it("runs after per-request headers, so prepareHeaders wins", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({
      fetchFn,
      prepareHeaders: (headers) => {
        headers.set("X-Override", "from-global");
      },
    });
    await fx.requestRaw("GET", "/x", { headers: { "X-Override": "from-spec", "X-Keep": "yes" } });
    const headers = initOf(fetchFn).headers as Headers;
    expect(headers.get("x-override")).toBe("from-global");
    expect(headers.get("x-keep")).toBe("yes");
  });

  it("classifies a prepareHeaders throw without calling fetch", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const fx = createFetch({
      fetchFn,
      prepareHeaders: () => {
        throw new Error("token refresh failed");
      },
    });
    const r = await fx.requestRaw("GET", "/x");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("token refresh failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("createFetch — credentials", () => {
  it("applies the configured credentials mode", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ credentials: "include", fetchFn });
    await fx.requestRaw("GET", "/x");
    expect(initOf(fetchFn).credentials).toBe("include");
  });

  it("omits credentials when not configured", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    await fx.requestRaw("GET", "/x");
    expect(initOf(fetchFn).credentials).toBeUndefined();
  });
});

describe("createFetch — per-request headers", () => {
  it("merges a plain-object headers map", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    await fx.requestRaw("GET", "/x", { headers: { "X-Custom": "val" } });
    expect((initOf(fetchFn).headers as Headers).get("x-custom")).toBe("val");
  });

  it("merges a Headers instance", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const h = new Headers();
    h.set("X-From-Headers", "yes");
    await fx.requestRaw("GET", "/x", { headers: h });
    expect((initOf(fetchFn).headers as Headers).get("x-from-headers")).toBe("yes");
  });

  it("keeps a per-request Content-Type override on a POST", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    await fx.requestRaw("POST", "/x", {
      body: { a: 1 },
      headers: { "Content-Type": "application/merge-patch+json" },
    });
    expect((initOf(fetchFn).headers as Headers).get("content-type")).toBe(
      "application/merge-patch+json",
    );
  });
});

describe("createFetch — baseUrl origin protection", () => {
  it("keeps the configured origin when the path is an absolute URL", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ baseUrl: "https://api.example.com/v1", fetchFn });
    await fx.requestRaw("GET", "https://evil.com/x");
    // The absolute path is demoted to a path segment; the origin is preserved.
    expect(urlOf(fetchFn)).toBe("https://api.example.com/v1/https://evil.com/x");
  });

  it("keeps the configured origin when the path is protocol-relative", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ baseUrl: "https://api.example.com/v1", fetchFn });
    await fx.requestRaw("GET", "//evil.com/x");
    expect(urlOf(fetchFn)).toBe("https://api.example.com/v1//evil.com/x");
  });
});

describe("createFetch — maxResponseBytes validation", () => {
  // A 50 KB body: every `> NaN` comparison is false, so a NaN cap would read
  // unbounded on both the declared-length and streamed paths.
  const FIFTY_KB = "x".repeat(50_000);
  const bigBody = JSON.stringify({ s: FIFTY_KB });

  it("refuses a NaN cap at construction instead of silently disabling the cap", () => {
    expect(() => createFetch({ maxResponseBytes: Number.NaN })).toThrow(TypeError);
    expect(() => createFetch({ maxResponseBytes: Number.NaN })).toThrow(/maxResponseBytes/);
  });

  it("refuses the unset-env-var shape, Number(undefined) === NaN", () => {
    // Models an unset env var as the string map it is (rather than reading
    // `process`, absent in the browser this suite runs in) so the value
    // reaching createFetch is an absent-key read, not a NaN literal.
    const env: Record<string, string | undefined> = {};
    const fromEnv = Number(env["FETCH_MAX_BYTES_NOT_SET"]);
    expect(Number.isNaN(fromEnv)).toBe(true);
    expect(() => createFetch({ maxResponseBytes: fromEnv })).toThrow(TypeError);
  });

  it("never gets as far as a request under a NaN cap, so no body is buffered", () => {
    const fetchFn = stubFetch(new Response(bigBody, { status: 200 }));
    expect(() => createFetch({ fetchFn, maxResponseBytes: Number.NaN })).toThrow(TypeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps Infinity meaning unlimited: a 50 KB body is buffered in full", async () => {
    const fetchFn = stubFetch(
      new Response(bigBody, {
        status: 200,
        headers: { "content-length": String(bigBody.length) },
      }),
    );
    const fx = createFetch({ fetchFn, maxResponseBytes: Number.POSITIVE_INFINITY });
    const r = await fx.requestRaw<{ s: string }>("GET", "/x");
    expect(r).toEqual({
      ok: true,
      status: 200,
      data: { s: FIFTY_KB },
      headers: expect.any(Headers),
    });
  });

  it("still rejects that same 50 KB body under a finite cap", async () => {
    const fetchFn = stubFetch(
      new Response(bigBody, {
        status: 200,
        headers: { "content-length": String(bigBody.length) },
      }),
    );
    const fx = createFetch({ fetchFn, maxResponseBytes: 10 });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toEqual({
      ok: false,
      status: 0,
      code: "network",
      error: "response exceeds 10 bytes",
    });
  });

  it("refuses a negative cap at construction, which would refuse every non-empty body", () => {
    expect(() => createFetch({ maxResponseBytes: -1 })).toThrow(TypeError);
    expect(() => createFetch({ maxResponseBytes: -1 })).toThrow(/maxResponseBytes.*-1/);
    expect(() => createFetch({ maxResponseBytes: Number.NEGATIVE_INFINITY })).toThrow(TypeError);
  });

  it("accepts a zero cap, which reads only empty bodies", async () => {
    const empty = createFetch({
      fetchFn: stubFetch(new Response(null, { status: 200 })),
      maxResponseBytes: 0,
    });
    expect(await empty.requestRaw("GET", "/x")).toMatchObject({ ok: true, data: undefined });
    const full = createFetch({ fetchFn: stubFetch(new Response("[1]")), maxResponseBytes: 0 });
    expect(await full.requestRaw("GET", "/x")).toMatchObject({ ok: false, code: "network" });
  });

  it("accepts an unset cap and a finite positive cap unchanged", () => {
    expect(() => createFetch()).not.toThrow();
    expect(() => createFetch({})).not.toThrow();
    expect(() => createFetch({ maxResponseBytes: 1024 })).not.toThrow();
  });
});
