import { describe, it, expect, expectTypeOf, vi, afterEach } from "vitest";
import { createFetch } from "./instance.js";
import type { ApiResult, Decoder, RequestOptions } from "./types.js";

function stubFetch(res: Response): typeof fetch {
  return vi.fn().mockResolvedValue(res) as unknown as typeof fetch;
}
function call(fn: typeof fetch): [string, RequestInit] {
  return (fn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("null-collapsing verb helpers", () => {
  it("apiGet issues a GET and returns data", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const data = await fx.apiGet<{ a: number }>("/x");
    expect(data).toEqual({ a: 1 });
    expect(call(fetchFn)[1].method).toBe("GET");
  });

  it("apiPost issues a POST with a JSON body", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
    const fx = createFetch({ fetchFn });
    const data = await fx.apiPost<{ id: number }>("/x", { name: "n" });
    expect(data).toEqual({ id: 1 });
    const [, init] = call(fetchFn);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "n" }));
    expect((init.headers as Headers).get("content-type")).toBe("application/json");
  });

  it("apiPut and apiPatch issue their verb with a body", async () => {
    for (const [name, method] of [
      ["apiPut", "PUT"],
      ["apiPatch", "PATCH"],
    ] as const) {
      const fetchFn = stubFetch(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
      const fx = createFetch({ fetchFn });
      await fx[name]("/x", { v: 1 });
      expect(call(fetchFn)[1].method).toBe(method);
      expect(call(fetchFn)[1].body).toBe(JSON.stringify({ v: 1 }));
    }
  });

  it("apiDelete issues a DELETE with no body (204 collapses to null)", async () => {
    const fetchFn = stubFetch(new Response(null, { status: 204 }));
    const fx = createFetch({ fetchFn });
    const data = await fx.apiDelete("/x");
    expect(data).toBeNull();
    expect(call(fetchFn)[1].method).toBe("DELETE");
    expect(call(fetchFn)[1].body).toBeUndefined();
  });

  it("returns null on an error status", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ error: "no" }), { status: 500 }));
    const fx = createFetch({ fetchFn });
    expect(await fx.apiGet("/x")).toBeNull();
  });

  it("threads per-request opts (headers) alongside the body", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    const fx = createFetch({ fetchFn });
    await fx.apiPost("/x", { a: 1 }, { headers: { "X-Req": "1" } });
    const [, init] = call(fetchFn);
    expect((init.headers as Headers).get("x-req")).toBe("1");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("lets the body argument win over an opts.body", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    const fx = createFetch({ fetchFn });
    await fx.apiPost("/x", { winner: true }, { body: { loser: true } });
    expect(call(fetchFn)[1].body).toBe(JSON.stringify({ winner: true }));
  });
});

describe("decoder-validated verb helpers", () => {
  const numDecoder: Decoder<{ n: number }> = (v) => {
    if (typeof v !== "object" || v === null || typeof (v as { n: unknown }).n !== "number") {
      throw new Error("bad shape");
    }
    return v as { n: number };
  };

  it("apiGetTyped validates and returns data", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ n: 3 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    expect(await fx.apiGetTyped("/x", numDecoder)).toEqual({ n: 3 });
  });

  it("apiGetTyped returns null when the decoder rejects the shape", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ wrong: 1 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    expect(await fx.apiGetTyped("/x", numDecoder)).toBeNull();
  });

  it("apiPostTyped sends the body, validates, and returns data", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ n: 9 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const data = await fx.apiPostTyped("/x", { in: true }, numDecoder);
    expect(data).toEqual({ n: 9 });
    expect(call(fetchFn)[1].body).toBe(JSON.stringify({ in: true }));
  });
});

describe("envelope (*Raw) verb helpers", () => {
  it("apiGetRaw returns an ok envelope", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    expect(await fx.apiGetRaw("/x")).toEqual({
      ok: true,
      status: 200,
      data: { a: 1 },
      headers: expect.any(Headers),
    });
  });

  it("apiGetRaw returns an err envelope with lifted fields", async () => {
    const fetchFn = stubFetch(
      new Response(JSON.stringify({ error: "bad", code: "c1" }), { status: 400 }),
    );
    const fx = createFetch({ fetchFn });
    expect(await fx.apiGetRaw("/x")).toMatchObject({
      ok: false,
      status: 400,
      error: "bad",
      code: "c1",
    });
  });

  it("apiPostRaw / apiPutRaw / apiPatchRaw send a body and return an envelope", async () => {
    for (const [name, method] of [
      ["apiPostRaw", "POST"],
      ["apiPutRaw", "PUT"],
      ["apiPatchRaw", "PATCH"],
    ] as const) {
      const fetchFn = stubFetch(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
      const fx = createFetch({ fetchFn });
      const r = await fx[name]("/x", { v: 1 });
      expect(r).toEqual({ ok: true, status: 200, data: { ok: 1 }, headers: expect.any(Headers) });
      expect(call(fetchFn)[1].method).toBe(method);
      expect(call(fetchFn)[1].body).toBe(JSON.stringify({ v: 1 }));
    }
  });

  it("apiDeleteRaw returns an envelope", async () => {
    const fetchFn = stubFetch(new Response(null, { status: 204 }));
    const fx = createFetch({ fetchFn });
    expect(await fx.apiDeleteRaw("/x")).toEqual({
      ok: true,
      status: 204,
      data: undefined,
      headers: expect.any(Headers),
    });
  });
});

describe("null body + empty body helpers", () => {
  it("apiPost with a null body sends no body / no Content-Type", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    const fx = createFetch({ fetchFn });
    await fx.apiPost("/x", null);
    const [, init] = call(fetchFn);
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).get("content-type")).toBeNull();
  });

  it("apiGetRaw surfaces an empty body as ok with undefined data", async () => {
    const fetchFn = stubFetch(new Response("", { status: 200 }));
    const fx = createFetch({ fetchFn });
    expect(await fx.apiGetRaw("/x")).toEqual({
      ok: true,
      status: 200,
      data: undefined,
      headers: expect.any(Headers),
    });
  });
});

describe("forwarding RequestOptions<T>", () => {
  it("lets a generic wrapper pass its RequestOptions<T> to apiGetRaw and requestRaw", async () => {
    const fx = createFetch({
      fetchFn: () => Promise.resolve(new Response(JSON.stringify({ id: "a" }))),
    });
    function viaVerb<T>(path: string, opts?: RequestOptions<T>): Promise<ApiResult<T>> {
      return fx.apiGetRaw<T>(path, opts);
    }
    function viaCore<T>(path: string, opts?: RequestOptions<T>): Promise<ApiResult<T>> {
      return fx.requestRaw<T>("GET", path, opts);
    }
    const decoder: Decoder<{ id: string }> = (v) => v as { id: string };
    const opts: RequestOptions<{ id: string }> = { decoder, timeoutMs: 1_000 };
    const byVerb = await viaVerb("/x", opts);
    const byCore = await viaCore("/x", opts);
    expectTypeOf(byVerb).toEqualTypeOf<ApiResult<{ id: string }>>();
    expectTypeOf(byCore).toEqualTypeOf<ApiResult<{ id: string }>>();
    expect(byVerb).toMatchObject({ ok: true, data: { id: "a" } });
    expect(byCore).toMatchObject({ ok: true, data: { id: "a" } });
  });
});
