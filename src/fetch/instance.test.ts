import { describe, it, expect, vi, afterEach } from "vitest";
import { createFetch, type FetchInstance } from "./instance.js";
import type { FetchConfig } from "./types.js";

function stubFetch(res: Response): typeof fetch {
  return vi.fn().mockResolvedValue(res) as unknown as typeof fetch;
}
function urlOf(fn: typeof fetch): string {
  return (fn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFetch — instance isolation", () => {
  it("isolates baseUrl + fetchFn between two instances", async () => {
    const fa = stubFetch(new Response("{}", { status: 200 }));
    const fb = stubFetch(new Response("{}", { status: 200 }));
    const a = createFetch({ baseUrl: "https://a.test", fetchFn: fa });
    const b = createFetch({ baseUrl: "https://b.test", fetchFn: fb });
    await a.apiGet("/x");
    await b.apiGet("/y");
    expect(urlOf(fa)).toBe("https://a.test/x");
    expect(urlOf(fb)).toBe("https://b.test/y");
    expect(fa).toHaveBeenCalledTimes(1);
    expect(fb).toHaveBeenCalledTimes(1);
  });

  it("exposes requestRaw, request, and all 12 verb helpers", () => {
    const inst = createFetch();
    const keys = [
      "requestRaw",
      "request",
      "apiGet",
      "apiPost",
      "apiPut",
      "apiPatch",
      "apiDelete",
      "apiGetTyped",
      "apiPostTyped",
      "apiGetRaw",
      "apiPostRaw",
      "apiPutRaw",
      "apiPatchRaw",
      "apiDeleteRaw",
    ] as const satisfies readonly (keyof FetchInstance)[];
    for (const k of keys) {
      expect(typeof inst[k]).toBe("function");
    }
  });

  it("instance requestRaw returns the full envelope; verbs null-collapse", async () => {
    // A Response body is single-read; a shared instance would be consumed by
    // the first call and read empty by the second.
    const f = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ a: 1 }), { status: 200 })),
    ) as unknown as typeof fetch;
    const inst = createFetch({ fetchFn: f });
    const raw = await inst.apiGetRaw<{ a: number }>("/x");
    expect(raw).toEqual({ ok: true, status: 200, data: { a: 1 }, headers: expect.any(Headers) });
    const data = await inst.apiGet<{ a: number }>("/x");
    expect(data).toEqual({ a: 1 });
  });
});

describe("createFetch — config immutability", () => {
  it("captures a shallow copy: mutating the caller's config object later has no effect", async () => {
    const f1 = stubFetch(new Response("{}", { status: 200 }));
    const cfg: FetchConfig = { baseUrl: "https://before.test", fetchFn: f1 };
    const inst = createFetch(cfg);
    // Caller mutates their own object after construction — must not leak in.
    cfg.baseUrl = "https://after.test";
    await inst.apiGet("/x");
    expect(urlOf(f1)).toBe("https://before.test/x");
  });

  it("has no configure method — config is fixed at construction", () => {
    const inst = createFetch();
    expect((inst as unknown as Record<string, unknown>)["configure"]).toBeUndefined();
  });

  it("reads late-bound state through the prepareHeaders hook (the supported pattern)", async () => {
    const f = stubFetch(new Response("{}", { status: 200 }));
    let token: string | undefined = undefined;
    const inst = createFetch({
      fetchFn: f,
      prepareHeaders: (headers) => {
        if (token !== undefined) {
          headers.set("Authorization", `Bearer ${token}`);
        }
      },
    });
    token = "tok-later";
    await inst.apiGet("/x");
    const init = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect((init.headers as Headers).get("authorization")).toBe("Bearer tok-later");
  });
});
