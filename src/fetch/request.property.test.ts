import { describe, it, expect, vi, afterEach } from "vitest";
import fc from "fast-check";
import { createFetch } from "./instance.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseErrorResponse (property)", () => {
  it("returns a well-formed ApiErr for any JSON error body and never throws", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 400, max: 599 }), fc.jsonValue(), async (status, body) => {
        const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
        const fx = createFetch({ fetchFn: fetchFn as unknown as typeof fetch });
        const r = await fx.requestRaw("GET", "/x");
        expect(r.ok).toBe(false);
        if (r.ok) {
          return;
        }
        expect(r.status).toBe(status);
        expect(typeof r.error).toBe("string");
        if (r.code !== undefined) {
          expect(typeof r.code).toBe("string");
        }
        if (r.requestId !== undefined) {
          expect(typeof r.requestId).toBe("string");
        }
        // A non-2xx always came from a real response, so headers are present.
        expect(r.headers).toBeInstanceOf(Headers);
      }),
      { numRuns: 300 },
    );
  });

  it("lifts a present string error/code/request_id verbatim; falls back otherwise (oracle)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 599 }),
        fc.record(
          {
            error: fc.string(),
            code: fc.string(),
            request_id: fc.string(),
            requestId: fc.string(),
            detail: fc.jsonValue(),
          },
          { requiredKeys: [] },
        ),
        async (status, body) => {
          const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
          const fx = createFetch({ fetchFn: fetchFn as unknown as typeof fetch });
          const r = await fx.requestRaw("GET", "/x");
          expect(r.ok).toBe(false);
          if (r.ok) {
            return;
          }
          expect(r.status).toBe(status);
          expect(r.error).toBe(typeof body.error === "string" ? body.error : `HTTP ${status}`);
          if (typeof body.code === "string") {
            expect(r.code).toBe(body.code);
          } else {
            expect(r.code).toBeUndefined();
          }
          const wantRid =
            typeof body.request_id === "string"
              ? body.request_id
              : typeof body.requestId === "string"
                ? body.requestId
                : undefined;
          expect(r.requestId).toBe(wantRid);
        },
      ),
      { numRuns: 300 },
    );
  });
});
