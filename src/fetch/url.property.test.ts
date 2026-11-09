import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { createFetch } from "./instance.js";

const ORIGIN = "https://api.example.com";

// Non-empty path segments over a slash-free alphabet (version-agnostic:
// avoids the fast-check string-generator API churn between majors).
const SEG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const segment = fc
  .array(fc.constantFrom(...SEG_CHARS), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(""));

describe("baseUrl + path joining (property)", () => {
  it("always joins with exactly one slash, never drops the path", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(segment, { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        fc.boolean(),
        async (segs, baseTrailingSlash, pathLeadingSlash) => {
          const baseUrl = ORIGIN + (baseTrailingSlash ? "/" : "");
          const path = (pathLeadingSlash ? "/" : "") + segs.join("/");

          const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
          const fx = createFetch({ baseUrl, fetchFn: fetchFn as unknown as typeof fetch });
          await fx.requestRaw("GET", path);

          const url = fetchFn.mock.calls[0]![0] as string;
          const expectedPath = segs.join("/");

          // Exactly one slash at the join, path preserved verbatim.
          expect(url).toBe(`${ORIGIN}/${expectedPath}`);
          // No double slash anywhere after the scheme separator.
          expect(url.slice("https://".length)).not.toContain("//");
          // Every segment survives, in order.
          expect(url.endsWith(expectedPath)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("passes the path through verbatim when no baseUrl is configured", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(segment, { minLength: 1, maxLength: 5 }), async (segs) => {
        const path = `/${segs.join("/")}`;
        const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
        const fx = createFetch({ fetchFn: fetchFn as unknown as typeof fetch });
        await fx.requestRaw("GET", path);
        expect(fetchFn.mock.calls[0]![0]).toBe(path);
      }),
      { numRuns: 100 },
    );
  });

  it("preserves the configured origin for any path (origin-override oracle)", async () => {
    const evilPrefix = fc.constantFrom(
      "",
      "/",
      "//",
      "///",
      "https://evil.com",
      "//evil.com",
      "/\\/evil.com",
      "\\\\evil.com",
      "@evil.com",
      ":@evil.com/x",
      "http:evil.com",
    );
    await fc.assert(
      fc.asyncProperty(
        evilPrefix,
        fc.array(segment, { minLength: 1, maxLength: 4 }),
        async (prefix, segs) => {
          const path = `${prefix}/${segs.join("/")}`;
          const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
          const fx = createFetch({ baseUrl: ORIGIN, fetchFn: fetchFn as unknown as typeof fetch });
          await fx.requestRaw("GET", path);
          const url = fetchFn.mock.calls[0]![0] as string;
          // A crafted path can never override the configured origin.
          expect(new URL(url).origin).toBe(ORIGIN);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps a crafted dot-segment / backslash path inside the configured base path", async () => {
    const BASE = `${ORIGIN}/v1`;
    const adversarial = [
      "/../admin",
      "/%2e%2e/admin",
      "/.%2e/admin",
      "/..\\admin",
      // A `..` / `.` fused to a trailing `?`/`#` with no intervening `/` is
      // still a live navigation operator during URL normalization, so it must
      // be neutralized like any other dot-segment.
      "/..?x=1",
      "/foo/..?x=1",
      "/..#frag",
      // ASCII TAB / LF / CR are stripped by the WHATWG URL parser before path
      // normalization; percent-encoding them first prevents adjacent dots from
      // fusing into live `..` navigation.
      "/\t../admin",
      "/.\t./admin",
      "/.\n./admin",
      "/..\r/admin",
    ];
    for (const path of adversarial) {
      const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      const fx = createFetch({ baseUrl: BASE, fetchFn: fetchFn as unknown as typeof fetch });
      await fx.requestRaw("GET", path);
      const url = fetchFn.mock.calls[0]![0] as string;
      const parsed = new URL(url);
      // Cannot escape the origin ...
      expect(parsed.origin).toBe(ORIGIN);
      // ... nor the /v1 base path prefix after URL normalization.
      expect(parsed.pathname.startsWith("/v1/")).toBe(true);
    }
  });

  it("preserves a path-valued query / fragment verbatim (never dot-neutralizes it)", async () => {
    const BASE = `${ORIGIN}/v1`;
    const cases: [string, string][] = [
      ["/search?redirect=/..", `${BASE}/search?redirect=/..`],
      ["/x?q=foo/../bar", `${BASE}/x?q=foo/../bar`],
      ["/page#/../frag", `${BASE}/page#/../frag`],
    ];
    for (const [path, expected] of cases) {
      const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      const fx = createFetch({ baseUrl: BASE, fetchFn: fetchFn as unknown as typeof fetch });
      await fx.requestRaw("GET", path);
      const url = fetchFn.mock.calls[0]![0] as string;
      // Dot-segment neutralization is PATH-only: the query / fragment reaches
      // the server byte-for-byte, so path-valued query data is not mangled.
      expect(url).toBe(expected);
    }
  });

  it("neutralizes a lone '.' segment, not just '..'", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const fx = createFetch({
      baseUrl: `${ORIGIN}/v1`,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await fx.requestRaw("GET", "/./config");
    const url = fetchFn.mock.calls[0]![0] as string;
    // Double-encoded, so URL normalization cannot pop it: the caller's literal
    // "." segment reaches the server as path data instead of vanishing.
    expect(new URL(url).pathname).toBe("/v1/%252E/config");
  });

  it("splits at the first marker when the path carries both a query and a fragment", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const fx = createFetch({
      baseUrl: `${ORIGIN}/v1`,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await fx.requestRaw("GET", "/search?next=/../home#frag");
    // Splitting at the "#" instead would drag the query into the path part and
    // dot-neutralize the caller's `next=/../home` value.
    expect(fetchFn.mock.calls[0]![0]).toBe(`${ORIGIN}/v1/search?next=/../home#frag`);
  });

  it("keeps any generated dot-segment / backslash path inside the base path (generator)", async () => {
    const BASE = `${ORIGIN}/v1`;
    const dangerToken = fc.constantFrom(
      "a",
      "1",
      ".",
      "..",
      "%2e",
      "%2E",
      ".%2e",
      "%2e.",
      "\\",
      "\\..",
      "..\\",
    );
    const dangerPath = fc
      .array(dangerToken, { minLength: 1, maxLength: 8 })
      .map((toks) => `/${toks.join("/")}`);
    await fc.assert(
      fc.asyncProperty(dangerPath, async (path) => {
        const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
        const fx = createFetch({ baseUrl: BASE, fetchFn: fetchFn as unknown as typeof fetch });
        await fx.requestRaw("GET", path);
        const parsed = new URL(fetchFn.mock.calls[0]![0] as string);
        expect(parsed.origin).toBe(ORIGIN);
        expect(parsed.pathname.startsWith("/v1/")).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
