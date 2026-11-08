import { describe, it, expect, vi, afterEach } from "vitest";
import { createFetch } from "./instance.js";
import type { Decoder } from "./types.js";

/** Build a stub fetch that always resolves to the given Response. */
function stubFetch(res: Response): typeof fetch {
  return vi.fn().mockResolvedValue(res) as unknown as typeof fetch;
}

/** Read the (url, init) a fetch stub was called with. */
function callArgs(fn: typeof fetch): [string, RequestInit] {
  const calls = (fn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  return calls[0]!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestRaw — happy paths", () => {
  it("GET returns parsed JSON with ok + status", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ name: "foo" }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw<{ name: string }>("GET", "/items/1");
    expect(r).toEqual({
      ok: true,
      status: 200,
      data: { name: "foo" },
      headers: expect.any(Headers),
    });
    const [url, init] = callArgs(fetchFn);
    expect(url).toBe("/items/1");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("PUT sends rawBody as-is with the caller's Content-Type (no JSON encoding)", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ status: "saved" }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const yaml = "providers:\n  opensubtitles:\n    enabled: true\n";
    const r = await fx.requestRaw("PUT", "/config", {
      rawBody: yaml,
      headers: { "Content-Type": "text/yaml" },
    });
    expect(r).toEqual({
      ok: true,
      status: 200,
      data: { status: "saved" },
      headers: expect.any(Headers),
    });
    const [, init] = callArgs(fetchFn);
    expect(init.body).toBe(yaml); // NOT JSON.stringify(yaml)
    expect((init.headers as Headers).get("content-type")).toBe("text/yaml");
  });

  it("rejects body + rawBody together as a client-side invalid request", async () => {
    const fetchFn = stubFetch(new Response(null, { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("POST", "/x", { body: { a: 1 }, rawBody: "raw" });
    expect(r).toMatchObject({ ok: false, status: 0, code: "invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("ignores rawBody on GET (same contract as body)", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x", { rawBody: "ignored" });
    expect(r).toMatchObject({ ok: true, status: 200 });
    const [, init] = callArgs(fetchFn);
    expect(init.body).toBeUndefined();
  });

  it("ignores body on GET (same contract as rawBody)", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    await fx.requestRaw("GET", "/x", { body: { a: 1 } });
    const [, init] = callArgs(fetchFn);
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).get("content-type")).toBeNull();
  });

  it("POST encodes the JSON body and sets Content-Type", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ id: 7 }), { status: 201 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw<{ id: number }>("POST", "/items", { body: { name: "bar" } });
    expect(r).toEqual({ ok: true, status: 201, data: { id: 7 }, headers: expect.any(Headers) });
    const [, init] = callArgs(fetchFn);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "bar" }));
    expect((init.headers as Headers).get("content-type")).toBe("application/json");
  });

  it("PUT and PATCH also encode the body and set Content-Type", async () => {
    for (const method of ["PUT", "PATCH"] as const) {
      const fetchFn = stubFetch(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
      const fx = createFetch({ fetchFn });
      await fx.requestRaw(method, "/items/1", { body: { v: 2 } });
      const [, init] = callArgs(fetchFn);
      expect(init.method).toBe(method);
      expect(init.body).toBe(JSON.stringify({ v: 2 }));
      expect((init.headers as Headers).get("content-type")).toBe("application/json");
    }
  });

  it("DELETE with no body sends no Content-Type", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw<{ deleted: boolean }>("DELETE", "/items/1");
    expect(r).toEqual({
      ok: true,
      status: 200,
      data: { deleted: true },
      headers: expect.any(Headers),
    });
    const [, init] = callArgs(fetchFn);
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).get("content-type")).toBeNull();
  });

  it("POST without a body sets no Content-Type", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    const fx = createFetch({ fetchFn });
    await fx.requestRaw("POST", "/ping");
    const [, init] = callArgs(fetchFn);
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).get("content-type")).toBeNull();
  });
});

describe("requestRaw — empty bodies", () => {
  it("204 resolves to ok with undefined data (no parse)", async () => {
    const fetchFn = stubFetch(new Response(null, { status: 204 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("DELETE", "/items/1");
    expect(r).toEqual({ ok: true, status: 204, data: undefined, headers: expect.any(Headers) });
  });

  it("empty 200 body resolves to ok with undefined data", async () => {
    const fetchFn = stubFetch(new Response("", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/empty");
    expect(r).toEqual({ ok: true, status: 200, data: undefined, headers: expect.any(Headers) });
  });

  it("short-circuits a 204 without reading the body", async () => {
    // A custom fetchFn could return a readable body on a 204; reading it
    // would surface `{ a: 1 }` as data instead of the empty-204 contract.
    const fetchFn = (async () => ({
      ok: true,
      status: 204,
      text: async () => JSON.stringify({ a: 1 }),
    })) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("DELETE", "/items/1");
    expect(r).toEqual({ ok: true, status: 204, data: undefined });
  });
});

describe("requestRaw — non-2xx responses", () => {
  /** Strip the headers field so envelope-shape assertions stay exact. */
  function withoutHeaders(r: unknown): unknown {
    const { headers: _headers, ...rest } = r as Record<string, unknown>;
    return rest;
  }

  it("lifts error, code, and request_id from a JSON error body", async () => {
    const fetchFn = stubFetch(
      new Response(
        JSON.stringify({ error: "Not found", code: "not_found", request_id: "req-42" }),
        {
          status: 404,
        },
      ),
    );
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/missing");
    expect(withoutHeaders(r)).toEqual({
      ok: false,
      status: 404,
      error: "Not found",
      code: "not_found",
      requestId: "req-42",
      body: { error: "Not found", code: "not_found", request_id: "req-42" },
    });
  });

  it("carries the parsed JSON error body on ApiErr.body", async () => {
    const envelope = { code: "has_dependents", dependents: ["job-a", "job-b"] };
    const fetchFn = stubFetch(new Response(JSON.stringify(envelope), { status: 409 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("DELETE", "/tools/x");
    expect(r).toMatchObject({ ok: false, status: 409, code: "has_dependents" });
    expect((r as { body?: unknown }).body).toEqual(envelope);
  });

  it("carries a bare non-object JSON error body on ApiErr.body", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify(42), { status: 400 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 400, error: "HTTP 400" });
    expect((r as { body?: unknown }).body).toBe(42);
  });

  it("omits ApiErr.body for a non-JSON error body", async () => {
    const fetchFn = stubFetch(new Response("<html>oops</html>", { status: 503 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(r).not.toHaveProperty("body");
  });

  it("omits ApiErr.body for an empty error body", async () => {
    const fetchFn = stubFetch(new Response("", { status: 500 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(r).not.toHaveProperty("body");
  });

  it("accepts a camelCase requestId field", async () => {
    const fetchFn = stubFetch(
      new Response(JSON.stringify({ error: "Boom", requestId: "req-9" }), { status: 500 }),
    );
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 500, error: "Boom", requestId: "req-9" });
    expect(r).not.toHaveProperty("code");
  });

  it("falls back to `HTTP <status>` for a non-JSON error body", async () => {
    const fetchFn = stubFetch(new Response("<html>oops</html>", { status: 503 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 503, error: "HTTP 503" });
  });

  it("falls back to `HTTP <status>` for an empty error body", async () => {
    const fetchFn = stubFetch(new Response("", { status: 500 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 500, error: "HTTP 500" });
  });

  it("falls back to `HTTP <status>` when the JSON error body has no error field", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ detail: "nope" }), { status: 422 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 422, error: "HTTP 422" });
  });

  it("falls back to `HTTP <status>` when the JSON error body is a bare non-object", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify(42), { status: 400 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 400, error: "HTTP 400" });
  });

  it("prefers snake_case request_id over camelCase requestId when both are present", async () => {
    const fetchFn = stubFetch(
      new Response(JSON.stringify({ error: "boom", request_id: "snake-1", requestId: "camel-2" }), {
        status: 500,
      }),
    );
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 500, error: "boom", requestId: "snake-1" });
  });
});

describe("requestRaw — success-response headers", () => {
  it("carries the response headers on a 2xx ok envelope", async () => {
    const fetchFn = stubFetch(
      new Response(JSON.stringify([1, 2]), {
        status: 200,
        headers: { "Subject-Stamp": '{"kind":"series","ref":"","version":"17","epoch":"a1"}' },
      }),
    );
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw<number[]>("GET", "/coverage/series");
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.headers).toBeInstanceOf(Headers);
    expect(r.headers.get("Subject-Stamp")).toBe(
      '{"kind":"series","ref":"","version":"17","epoch":"a1"}',
    );
  });
});

describe("requestRaw — error-response headers", () => {
  it("carries the response headers on a non-2xx error envelope", async () => {
    const fetchFn = stubFetch(
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    );
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/login");
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.status).toBe(429);
    expect(r.headers).toBeInstanceOf(Headers);
    expect(r.headers?.get("Retry-After")).toBe("30");
  });

  it("carries the response headers on a 2xx decode failure", async () => {
    const fetchFn = stubFetch(
      new Response("not json{", { status: 200, headers: { "X-Trace": "t-1" } }),
    );
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.code).toBe("decode");
    expect(r.headers?.get("X-Trace")).toBe("t-1");
  });

  it("carries the response headers on a decoder shape mismatch", async () => {
    const decoder: Decoder<unknown> = () => {
      throw new Error("bad shape");
    };
    const fetchFn = stubFetch(
      new Response(JSON.stringify({}), { status: 200, headers: { "X-Trace": "t-2" } }),
    );
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x", { decoder });
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.code).toBe("decode");
    expect(r.headers?.get("X-Trace")).toBe("t-2");
  });

  it("carries the parsed body on a decoder shape mismatch", async () => {
    const decoder: Decoder<unknown> = () => {
      throw new Error("bad shape");
    };
    const fetchFn = stubFetch(new Response(JSON.stringify({ n: "not-a-number" }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x", { decoder });
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.code).toBe("decode");
    expect(r.body).toEqual({ n: "not-a-number" });
  });

  it("omits body on a network failure (no response received)", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("body");
  });

  it("omits headers on a network failure (no response received)", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("headers");
  });
});

describe("requestRaw — ignoreBody", () => {
  it("resolves ok with undefined data without parsing a non-JSON 2xx body", async () => {
    const fetchFn = stubFetch(new Response("plain text, not json", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("DELETE", "/items/1", { ignoreBody: true });
    expect(r).toEqual({ ok: true, status: 200, data: undefined, headers: expect.any(Headers) });
  });

  it("does not invoke a supplied decoder", async () => {
    const decoder = vi.fn(() => {
      throw new Error("must not run");
    });
    const fetchFn = stubFetch(new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x", { decoder, ignoreBody: true });
    expect(r).toEqual({ ok: true, status: 200, data: undefined, headers: expect.any(Headers) });
    expect(decoder).not.toHaveBeenCalled();
  });

  it("releases the unread response body stream", async () => {
    const chunks = [new TextEncoder().encode("payload nobody reads")];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const res = new Response(body, { status: 200 });
    const stream = res.body;
    const fx = createFetch({ fetchFn: stubFetch(res) });
    await fx.requestRaw("DELETE", "/x", { ignoreBody: true });
    // The skipped body was cancelled, so the connection is released rather
    // than held open by an unread stream: nothing is left to read.
    const read = await stream!.getReader().read();
    expect(read.done).toBe(true);
  });

  it("resolves without waiting for a cancel that has not settled", async () => {
    let cancelled = false;
    let settle!: () => void;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>((resolve) => {
          settle = resolve;
        });
      },
    });
    const fx = createFetch({ fetchFn: stubFetch(new Response(body, { status: 200 })) });
    const r = await fx.requestRaw("DELETE", "/x", { ignoreBody: true });
    expect(r).toEqual({ ok: true, status: 200, data: undefined, headers: expect.any(Headers) });
    expect(cancelled).toBe(true);
    settle();
  });

  it("resolves ok when the skipped body's cancel rejects", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        throw new Error("cancel failed");
      },
    });
    const fx = createFetch({ fetchFn: stubFetch(new Response(body, { status: 200 })) });
    const r = await fx.requestRaw("DELETE", "/x", { ignoreBody: true });
    expect(r).toEqual({ ok: true, status: 200, data: undefined, headers: expect.any(Headers) });
    expect(cancelled).toBe(true);
  });

  it("resolves ok when a custom fetchFn's body throws from cancel", async () => {
    const res = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        cancel: () => {
          throw new Error("cancel threw");
        },
      },
    };
    const fetchFn = (() => Promise.resolve(res)) as unknown as typeof fetch;
    const r = await createFetch({ fetchFn }).requestRaw("DELETE", "/x", { ignoreBody: true });
    expect(r).toEqual({ ok: true, status: 200, data: undefined, headers: expect.any(Headers) });
  });

  it("still parses the error envelope on a non-2xx response", async () => {
    const fetchFn = stubFetch(
      new Response(JSON.stringify({ error: "nope", code: "denied" }), { status: 403 }),
    );
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("DELETE", "/x", { ignoreBody: true });
    expect(r).toMatchObject({ ok: false, status: 403, error: "nope", code: "denied" });
  });

  it("null-collapses to null through request()", async () => {
    const fetchFn = stubFetch(new Response("anything", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const data = await fx.request("DELETE", "/x", { ignoreBody: true });
    expect(data).toBeNull();
  });
});

describe("requestRaw — decoding", () => {
  it("returns parsed data when no decoder is supplied", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify([1, 2, 3]), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw<number[]>("GET", "/nums");
    expect(r).toEqual({ ok: true, status: 200, data: [1, 2, 3], headers: expect.any(Headers) });
  });

  it("runs a supplied decoder on the 2xx body", async () => {
    const decoder: Decoder<{ n: number }> = (v) => {
      if (typeof v !== "object" || v === null || typeof (v as { n: unknown }).n !== "number") {
        throw new Error("expected { n: number }");
      }
      return v as { n: number };
    };
    const fetchFn = stubFetch(new Response(JSON.stringify({ n: 5 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/n", { decoder });
    expect(r).toEqual({ ok: true, status: 200, data: { n: 5 }, headers: expect.any(Headers) });
  });

  it("maps a decoder throw to code 'decode'", async () => {
    const decoder: Decoder<{ n: number }> = () => {
      throw new Error("expected { n: number }");
    };
    const fetchFn = stubFetch(new Response(JSON.stringify({ wrong: true }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/n", { decoder });
    expect(r).toMatchObject({
      ok: false,
      status: 200,
      code: "decode",
      error: "response shape mismatch: expected { n: number }",
    });
  });

  it("preserves a raw string thrown by a decoder", async () => {
    const decoder: Decoder<unknown> = () => {
      throw "raw failure";
    };
    const fetchFn = stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/n", { decoder });
    expect(r).toMatchObject({
      ok: false,
      status: 200,
      code: "decode",
      error: "response shape mismatch: raw failure",
    });
  });

  it("falls back to 'unknown error' when a decoder throws a non-Error, non-string", async () => {
    const decoder: Decoder<unknown> = () => {
      throw { weird: true };
    };
    const fetchFn = stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/n", { decoder });
    expect(r).toMatchObject({
      ok: false,
      status: 200,
      code: "decode",
      error: "response shape mismatch: unknown error",
    });
  });

  it("maps a JSON.parse failure to code 'decode'", async () => {
    const fetchFn = stubFetch(new Response("not json{", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/n");
    expect(r.ok).toBe(false);
    expect((r as { code?: string }).code).toBe("decode");
    expect((r as { error: string }).error).toContain("response not JSON:");
    expect((r as { status: number }).status).toBe(200);
  });
});

describe("requestRaw — thrown fetch errors", () => {
  it("classifies a TypeError as code 'network' with status 0", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toEqual({ ok: false, status: 0, code: "network", error: "Failed to fetch" });
  });

  it("classifies a TimeoutError DOMException as code 'timeout'", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation timed out", "TimeoutError"),
      ) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toEqual({ ok: false, status: 0, code: "timeout", error: "The operation timed out" });
  });

  it("classifies a bare AbortError (no caller abort) as code 'timeout'", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new DOMException("aborted", "AbortError")) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toEqual({ ok: false, status: 0, code: "timeout", error: "aborted" });
  });

  it("classifies a non-abort DOMException as 'network', not 'timeout'", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(
        new DOMException("blocked by policy", "NotAllowedError"),
      ) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toEqual({ ok: false, status: 0, code: "network", error: "blocked by policy" });
  });

  it("classifies a failure as 'cancelled' when the caller signal is aborted", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation was aborted", "AbortError"),
      ) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const ac = new AbortController();
    ac.abort();
    const r = await fx.requestRaw("GET", "/x", { signal: ac.signal });
    expect(r).toEqual({ ok: false, status: 0, code: "cancelled", error: "request cancelled" });
  });

  it("never throws — a fetch resolving to null is classified, not propagated", async () => {
    const fetchFn = (async () => null) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r.ok).toBe(false);
    expect((r as { code?: string }).code).toBe("network");
  });
});

describe("request — null collapsing", () => {
  it("returns data on ok", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const data = await fx.request<{ a: number }>("GET", "/x");
    expect(data).toEqual({ a: 1 });
  });

  it("returns null on error", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ error: "no" }), { status: 400 }));
    const fx = createFetch({ fetchFn });
    const data = await fx.request("GET", "/x");
    expect(data).toBeNull();
  });

  it("returns null (not undefined) on a 204 success — empty body collapses", async () => {
    const fetchFn = stubFetch(new Response(null, { status: 204 }));
    const fx = createFetch({ fetchFn });
    const data = await fx.request("DELETE", "/x");
    expect(data).toBeNull();
  });

  it("returns null on an empty 200 body", async () => {
    const fetchFn = stubFetch(new Response("", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const data = await fx.request("GET", "/empty");
    expect(data).toBeNull();
  });

  it("passes a JSON null / 0 / false / '' body through as real data", async () => {
    for (const raw of ["null", "0", "false", '""'] as const) {
      const fetchFn = stubFetch(new Response(raw, { status: 200 }));
      const fx = createFetch({ fetchFn });
      const r = await fx.requestRaw("GET", "/x");
      expect(r).toEqual({
        ok: true,
        status: 200,
        data: JSON.parse(raw) as unknown,
        headers: expect.any(Headers),
      });
    }
  });

  it("passes a falsy JSON body (0 / false / '') through request(), not collapsed to null", async () => {
    for (const [raw, want] of [
      ["0", 0],
      ["false", false],
      ['""', ""],
    ] as const) {
      const fetchFn = stubFetch(new Response(raw, { status: 200 }));
      const fx = createFetch({ fetchFn });
      const data = await fx.request<number | boolean | string>("GET", "/x");
      expect(data).toBe(want);
    }
  });
});

describe("request — global fetch fallback", () => {
  it("uses the global fetch when no fetchFn is configured", async () => {
    const globalFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ g: true }), { status: 200 }));
    vi.stubGlobal("fetch", globalFetch);
    const fx = createFetch();
    const data = await fx.request<{ g: boolean }>("GET", "/x");
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(data).toEqual({ g: true });
  });
});

describe("requestRaw — buggy fetchFn results are classified, never thrown", () => {
  it("coerces status to 0 for a truthy non-Response ({ ok: false })", async () => {
    const fetchFn = (async () => ({ ok: false })) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x");
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(0);
  });

  it("coerces a non-number status to 0 on an otherwise-ok response", async () => {
    const fetchFn = (async () => ({
      ok: true,
      status: "200",
      text: async () => JSON.stringify({ a: 1 }),
    })) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw<{ a: number }>("GET", "/x");
    expect(r).toEqual({ ok: true, status: 0, data: { a: 1 } });
  });
});

describe("requestRaw — null request bodies", () => {
  it("sends neither payload nor Content-Type for a null body", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    const fx = createFetch({ fetchFn });
    await fx.requestRaw("POST", "/x", { body: null });
    const [, init] = callArgs(fetchFn);
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).get("content-type")).toBeNull();
  });
});

describe("requestRaw — caller signal + timeout composition", () => {
  it("composes the caller signal with the timeout and still resolves ok", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ v: 1 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const ac = new AbortController();
    const r = await fx.requestRaw("GET", "/x", { signal: ac.signal });
    expect(r).toEqual({ ok: true, status: 200, data: { v: 1 }, headers: expect.any(Headers) });
    const [, init] = callArgs(fetchFn);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal).not.toBe(ac.signal);
  });
});

describe("requestRaw — maxResponseBytes", () => {
  it("rejects a 2xx response when content-length exceeds the configured cap", async () => {
    const fetchFn = stubFetch(
      new Response(JSON.stringify({ a: 1 }), {
        status: 200,
        headers: { "content-length": "7" },
      }),
    );
    const fx = createFetch({ fetchFn, maxResponseBytes: 3 });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toEqual({
      ok: false,
      status: 0,
      code: "network",
      error: "response exceeds 3 bytes",
    });
  });

  it("rejects a declared content-length over the cap before reading the body", async () => {
    // The body itself is 3 bytes: only the declared length can trigger this,
    // which is the point of the up-front check — an untrusted upstream must not
    // be able to make the client buffer first and measure afterwards.
    const fetchFn = stubFetch(
      new Response("[1]", { status: 200, headers: { "content-length": "1000" } }),
    );
    const fx = createFetch({ fetchFn, maxResponseBytes: 100 });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toEqual({
      ok: false,
      status: 0,
      code: "network",
      error: "response exceeds 100 bytes",
    });
  });

  it("reassembles a multi-chunk streamed body in order", async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"a":'), encoder.encode('"bc"}')];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const fetchFn = stubFetch(new Response(body, { status: 200 }));
    const fx = createFetch({ fetchFn, maxResponseBytes: 100 });
    const r = await fx.requestRaw<{ a: string }>("GET", "/x");
    expect(r).toEqual({ ok: true, status: 200, data: { a: "bc" }, headers: expect.any(Headers) });
  });

  it("rejects a streaming 2xx response as soon as it crosses the cap", async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"a":'), encoder.encode("1}")];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const fetchFn = stubFetch(new Response(body, { status: 200 }));
    const fx = createFetch({ fetchFn, maxResponseBytes: 5 });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toEqual({
      ok: false,
      status: 0,
      code: "network",
      error: "response exceeds 5 bytes",
    });
  });

  it("parses a response that stays within the configured cap", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const fx = createFetch({ fetchFn, maxResponseBytes: 20 });
    const r = await fx.requestRaw<{ ok: boolean }>("GET", "/x");
    expect(r).toEqual({ ok: true, status: 200, data: { ok: true }, headers: expect.any(Headers) });
  });

  it("bounds non-2xx error bodies before lifting fields", async () => {
    const fetchFn = stubFetch(
      new Response(JSON.stringify({ error: "too large", code: "large" }), {
        status: 413,
        headers: { "content-length": "36" },
      }),
    );
    const fx = createFetch({ fetchFn, maxResponseBytes: 8 });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toMatchObject({ ok: false, status: 413, error: "HTTP 413" });
  });

  it("reads a null-body 2xx as empty when a cap is set", async () => {
    const fetchFn = stubFetch(new Response(null, { status: 200 }));
    const fx = createFetch({ fetchFn, maxResponseBytes: 16 });
    const r = await fx.requestRaw("GET", "/x");
    expect(r).toEqual({ ok: true, status: 200, data: undefined, headers: expect.any(Headers) });
  });

  it("accepts a body whose content-length exactly equals the cap", async () => {
    const fetchFn = stubFetch(
      new Response("[1,2]", { status: 200, headers: { "content-length": "5" } }),
    );
    const fx = createFetch({ fetchFn, maxResponseBytes: 5 });
    const r = await fx.requestRaw<number[]>("GET", "/x");
    expect(r).toEqual({ ok: true, status: 200, data: [1, 2], headers: expect.any(Headers) });
  });

  it("accepts a streamed body whose total exactly equals the cap", async () => {
    const chunks = [new TextEncoder().encode("[1,2]")];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const fetchFn = stubFetch(new Response(body, { status: 200 }));
    const fx = createFetch({ fetchFn, maxResponseBytes: 5 });
    const r = await fx.requestRaw<number[]>("GET", "/x");
    expect(r).toEqual({ ok: true, status: 200, data: [1, 2], headers: expect.any(Headers) });
  });
});
