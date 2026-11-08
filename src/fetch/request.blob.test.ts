import { describe, it, expect, expectTypeOf, vi } from "vitest";
import { createFetch } from "./instance.js";
import type { ApiResult } from "./types.js";

function stubFetch(res: Response): typeof fetch {
  return vi.fn().mockResolvedValue(res) as unknown as typeof fetch;
}

function bytes(n: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: n }, (_, i) => i % 256);
}

/** A body with no content-length, so only the streamed count can enforce a cap. */
function streamOf(...chunks: Uint8Array<ArrayBuffer>[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

async function blobBytes(data: unknown): Promise<number[]> {
  expect(data).toBeInstanceOf(Blob);
  return [...new Uint8Array(await (data as Blob).arrayBuffer())];
}

describe("requestRaw — as: blob", () => {
  it("returns the body as a Blob typed by the response's Content-Type", async () => {
    const fetchFn = stubFetch(
      new Response(bytes(4), { status: 200, headers: { "Content-Type": "image/webp" } }),
    );
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw<Blob>("GET", "/poster", { as: "blob" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(200);
    expect(r.data.type).toBe("image/webp");
    expect(await blobBytes(r.data)).toEqual([0, 1, 2, 3]);
  });

  it("reads a body that is not JSON without a decode failure", async () => {
    const vtt = "WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n";
    const fetchFn = stubFetch(
      new Response(vtt, { status: 200, headers: { "Content-Type": "text/vtt" } }),
    );
    const fx = createFetch({ fetchFn, maxResponseBytes: 1024 });
    const r = await fx.requestRaw<Blob>("GET", "/render", { as: "blob" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.type).toBe("text/vtt");
    expect(await r.data.text()).toBe(vtt);
  });

  it("gives an untyped Blob when the response has no Content-Type", async () => {
    const fx = createFetch({
      fetchFn: stubFetch(new Response(streamOf(bytes(2)), { status: 200 })),
    });
    const r = await fx.requestRaw<Blob>("GET", "/x", { as: "blob" });
    expect(r.ok && r.data.type).toBe("");
  });

  it("reads a streamed body exactly at maxResponseBytes, in order", async () => {
    const fetchFn = stubFetch(new Response(streamOf(bytes(3), bytes(2)), { status: 200 }));
    const fx = createFetch({ fetchFn, maxResponseBytes: 5 });
    const r = await fx.requestRaw<Blob>("GET", "/x", { as: "blob" });
    expect(r.ok).toBe(true);
    expect(await blobBytes(r.ok ? r.data : undefined)).toEqual([0, 1, 2, 0, 1]);
  });

  it("refuses a streamed body one byte over maxResponseBytes with the cap's failure", async () => {
    const fetchFn = stubFetch(new Response(streamOf(bytes(3), bytes(3)), { status: 200 }));
    const fx = createFetch({ fetchFn, maxResponseBytes: 5 });
    const r = await fx.requestRaw<Blob>("GET", "/x", { as: "blob" });
    expect(r).toEqual({ ok: false, status: 0, code: "network", error: "response exceeds 5 bytes" });
  });

  it("returns the cap's failure without waiting for a cancel that has not settled", async () => {
    let cancelled = false;
    let settle!: () => void;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        controller.enqueue(bytes(2));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>((resolve) => {
          settle = resolve;
        });
      },
    });
    const fx = createFetch({ fetchFn: stubFetch(new Response(body)), maxResponseBytes: 1 });
    const r = await fx.requestRaw("GET", "/x", { as: "blob" });
    expect(r).toEqual({ ok: false, status: 0, code: "network", error: "response exceeds 1 bytes" });
    expect(cancelled).toBe(true);
    settle();
  });

  it("keeps the cap's failure when a custom fetchFn's reader throws from cancel", async () => {
    const reader = {
      read: () => Promise.resolve({ done: false, value: bytes(2) }),
      cancel: () => {
        throw new Error("cancel threw");
      },
    };
    const res = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => reader },
    };
    const fetchFn = (() => Promise.resolve(res)) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn, maxResponseBytes: 1 });
    const r = await fx.requestRaw("GET", "/x", { as: "blob" });
    expect(r).toEqual({ ok: false, status: 0, code: "network", error: "response exceeds 1 bytes" });
  });

  it("cancels the over-cap stream, and keeps the cap's failure when that cancel rejects", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        controller.enqueue(bytes(2));
      },
      cancel() {
        cancelled = true;
        throw new Error("cancel failed");
      },
    });
    const fx = createFetch({ fetchFn: stubFetch(new Response(body)), maxResponseBytes: 1 });
    const r = await fx.requestRaw<Blob>("GET", "/x", { as: "blob" });
    expect(r).toEqual({ ok: false, status: 0, code: "network", error: "response exceeds 1 bytes" });
    expect(cancelled).toBe(true);
  });

  it("refuses a declared content-length one byte over maxResponseBytes", async () => {
    const fetchFn = stubFetch(
      new Response(bytes(1), { status: 200, headers: { "content-length": "6" } }),
    );
    const fx = createFetch({ fetchFn, maxResponseBytes: 5 });
    const r = await fx.requestRaw<Blob>("GET", "/x", { as: "blob" });
    expect(r).toEqual({ ok: false, status: 0, code: "network", error: "response exceeds 5 bytes" });
  });

  it("reads a declared content-length exactly at maxResponseBytes", async () => {
    const fetchFn = stubFetch(
      new Response(bytes(5), { status: 200, headers: { "content-length": "5" } }),
    );
    const fx = createFetch({ fetchFn, maxResponseBytes: 5 });
    const r = await fx.requestRaw<Blob>("GET", "/x", { as: "blob" });
    expect(await blobBytes(r.ok ? r.data : undefined)).toEqual([0, 1, 2, 3, 4]);
  });

  it("lifts the JSON error envelope of a non-2xx response", async () => {
    const fetchFn = stubFetch(
      new Response(
        JSON.stringify({ error: "sign in", code: "auth_required", request_id: "rid-1" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );
    const fx = createFetch({ fetchFn, maxResponseBytes: 1024 });
    const r = await fx.requestRaw<Blob>("GET", "/poster", { as: "blob" });
    expect(r).toMatchObject({
      ok: false,
      status: 401,
      error: "sign in",
      code: "auth_required",
      requestId: "rid-1",
      body: { error: "sign in", code: "auth_required", request_id: "rid-1" },
    });
  });

  it("gives an empty Blob for an empty 2xx body and for a 204", async () => {
    const empty = createFetch({ fetchFn: stubFetch(new Response("", { status: 200 })) });
    const r200 = await empty.requestRaw("GET", "/x", { as: "blob" });
    expect(await blobBytes(r200.ok ? r200.data : undefined)).toEqual([]);

    const none = createFetch({ fetchFn: stubFetch(new Response(null, { status: 204 })) });
    const r204 = await none.requestRaw("GET", "/x", { as: "blob" });
    expect(r204).toMatchObject({ ok: true, status: 204 });
    expect(await blobBytes(r204.ok ? r204.data : undefined)).toEqual([]);
    expect(await none.apiDelete("/x", { as: "blob" })).toBeInstanceOf(Blob);
  });

  it("keeps as: json the default", async () => {
    const fetchFn = stubFetch(new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x", { as: "json" });
    expect(r).toEqual({ ok: true, status: 200, data: { a: 1 }, headers: expect.any(Headers) });
  });

  it("refuses a decoder with as: blob as an invalid request, sending nothing", async () => {
    const fetchFn = stubFetch(new Response(bytes(1), { status: 200 }));
    const fx = createFetch({ fetchFn });
    // @ts-expect-error -- the compiler refuses it; a JavaScript caller meets the run-time check
    const r = await fx.requestRaw("GET", "/x", { as: "blob", decoder: (v: unknown) => v });
    expect(r).toMatchObject({ ok: false, status: 0, code: "invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses ignoreBody with as: blob as an invalid request, sending nothing", async () => {
    const fetchFn = stubFetch(new Response(bytes(1), { status: 200 }));
    const fx = createFetch({ fetchFn });
    // @ts-expect-error -- the compiler refuses it; a JavaScript caller meets the run-time check
    const r = await fx.requestRaw("GET", "/x", { as: "blob", ignoreBody: true });
    expect(r).toMatchObject({ ok: false, status: 0, code: "invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("types a Blob read's data as Blob, and refuses another type or a JSON-only option", async () => {
    const fetchFn = (() => Promise.resolve(new Response(bytes(1)))) as unknown as typeof fetch;
    const fx = createFetch({ fetchFn });
    expectTypeOf(await fx.requestRaw("GET", "/x", { as: "blob" })).toEqualTypeOf<ApiResult<Blob>>();
    expectTypeOf(await fx.request("GET", "/x", { as: "blob" })).toEqualTypeOf<Blob | null>();
    expectTypeOf(await fx.apiGetRaw<Blob>("/x", { as: "blob" })).toEqualTypeOf<ApiResult<Blob>>();
    expectTypeOf(await fx.apiGet("/x", { as: "blob" })).toEqualTypeOf<Blob | null>();
    expectTypeOf(await fx.apiPost("/x", { a: 1 }, { as: "blob" })).toEqualTypeOf<Blob | null>();
    expectTypeOf(await fx.apiDeleteRaw("/x", { as: "blob" })).toEqualTypeOf<ApiResult<Blob>>();
    expectTypeOf(await fx.apiPatchRaw("/x", {}, { as: "blob" })).toEqualTypeOf<ApiResult<Blob>>();
    // @ts-expect-error -- a Blob read's data is never a JSON shape
    await fx.requestRaw<{ id: string }>("GET", "/x", { as: "blob" });
    // @ts-expect-error -- nor a Blob subtype, whose extra fields the read never sets
    await fx.apiGetRaw<File>("/x", { as: "blob" });
    // @ts-expect-error -- a decoder validates JSON only
    await fx.apiGet("/x", { as: "blob", decoder: (v: unknown) => v });
    // @ts-expect-error -- ignoreBody skips the body a Blob read returns
    await fx.apiPutRaw("/x", {}, { as: "blob", ignoreBody: true });
    // @ts-expect-error -- a typed helper always reads JSON
    await fx.apiGetTyped("/x", (v: unknown) => v, { as: "blob" });
  });
});
