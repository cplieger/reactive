// Client-side "invalid" classification: a bad header, an out-of-range
// timeout, or unencodable body JSON throws during the build phase, before the
// network is touched, so requestRaw classifies it "invalid" rather than
// "network".
import { describe, it, expect, vi, afterEach } from "vitest";
import { createFetch } from "./instance.js";

function stubFetch(res: Response): typeof fetch {
  return vi.fn().mockResolvedValue(res) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestRaw — client-side 'invalid' classification (never throws)", () => {
  it("classifies an un-encodable (circular) body as invalid, status 0, without fetching", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const r = await fx.requestRaw("POST", "/x", { body: circular });
    expect(r).toMatchObject({ ok: false, status: 0, code: "invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("classifies an invalid header name as invalid, not network", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x", { headers: { "Bad Header": "x" } });
    expect(r).toMatchObject({ ok: false, status: 0, code: "invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("classifies a negative timeoutMs as invalid", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("GET", "/x", { timeoutMs: -1 });
    expect(r).toMatchObject({ ok: false, status: 0, code: "invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("classifies a build failure as cancelled when the caller signal is already aborted", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const ac = new AbortController();
    ac.abort();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const r = await fx.requestRaw("POST", "/x", { body: circular, signal: ac.signal });
    expect(r).toMatchObject({ ok: false, status: 0, code: "cancelled" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("classifies a symbol body (JSON.stringify → undefined) as invalid, without fetching", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("POST", "/x", { body: Symbol("x") });
    expect(r).toMatchObject({ ok: false, status: 0, code: "invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("classifies a function body (JSON.stringify → undefined) as invalid, without fetching", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const r = await fx.requestRaw("POST", "/x", { body: () => 1 });
    expect(r).toMatchObject({ ok: false, status: 0, code: "invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("classifies a throwing signal getter as invalid, without fetching", async () => {
    const fetchFn = stubFetch(new Response("{}", { status: 200 }));
    const fx = createFetch({ fetchFn });
    const opts = {
      get signal(): AbortSignal {
        throw new Error("signal getter boom");
      },
    };
    const r = await fx.requestRaw("GET", "/x", opts);
    expect(r).toMatchObject({ ok: false, status: 0, code: "invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
