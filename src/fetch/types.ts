/** Public types for @cplieger/reactive/fetch. No imports, no runtime behavior. */

/** HTTP verbs the wrapper speaks. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A runtime validator for a 2xx response body: returns the typed value or
 * THROWS on a mismatch. Ships no combinators — each consumer supplies its own
 * validators (hand-written, zod, valibot, …).
 */
export type Decoder<T> = (value: unknown) => T;

/** Configuration for a fetch instance. Captured immutably by
 *  {@link createFetch} (shallow-copied and frozen at construction); a changed
 *  backend produces a new instance. */
export interface FetchConfig {
  /** Prepended to relative paths, minus one trailing `/`. With it set,
   *  an absolute (`https://…`) or protocol-relative (`//host`) path stays a
   *  path segment and cannot override the origin. With it UNSET, `path` goes
   *  to `fetch()` verbatim, so the caller owns the full URL and must never
   *  pass untrusted input as the whole path. */
  baseUrl?: string;
  /** `RequestInit.credentials` mode applied to every request (e.g. `"include"`
   *  for cookies). */
  credentials?: RequestCredentials;
  /** Custom fetch implementation. Useful for SSR (isomorphic fetch) or tests. */
  fetchFn?: typeof fetch;
  /** Inject headers on every request. Mutate the provided instance and/or
   *  return a replacement (a returned `Headers` wins wholesale, otherwise the
   *  mutated instance is used). May be async — read late-bound state (a token
   *  set after boot) from inside the hook rather than reconfiguring the
   *  instance. */
  prepareHeaders?: (headers: Headers) => Headers | undefined | Promise<Headers | undefined>;
  /** Optional cap on the response body size in bytes. Unset or `Infinity`
   *  means unlimited. When set, a larger body is rejected instead of buffered.
   *  `NaN` or a negative number is rejected by {@link createFetch} with a
   *  `TypeError`. */
  maxResponseBytes?: number;
  /** Observes every failure this instance returns, `decode` included, after
   *  its `code` is lifted and before the caller receives the same `ApiErr`
   *  object. Its return value is ignored and the promise is not awaited; a
   *  throw or a rejection is logged with `console.error` and swallowed, so it
   *  can never replace or delay the caller's failure. */
  onError?: (err: ApiErr, req: FailedRequest) => void | Promise<void>;
}

/** The request an {@link FetchConfig.onError} failure belongs to. */
export interface FailedRequest {
  readonly method: HttpMethod;
  /** The path as the caller passed it, before the `baseUrl` join. */
  readonly path: string;
}

/** Successful result envelope. */
export interface ApiOk<T> {
  readonly ok: true;
  readonly status: number;
  /** The decoded / parsed response body, or a `Blob` under `as: "blob"`.
   *  `undefined` for a 204 or an empty body read as JSON; the null-collapsing helpers
   *  turn that into `null`. */
  readonly data: T;
  /** Response headers. Always present: a success envelope exists only once a
   *  real HTTP response was received. */
  readonly headers: Headers;
}

/** Failure result envelope. Never thrown — always returned by `requestRaw`. */
export interface ApiErr {
  readonly ok: false;
  /** HTTP status, or 0 for a network / timeout / cancelled / invalid failure. */
  readonly status: number;
  /** Human-readable message. */
  readonly error: string;
  /** Machine code: `"network"` | `"timeout"` | `"cancelled"` | `"decode"` |
   *  `"invalid"`, or a code lifted from the server's error body, which can
   *  spoof a reserved one. Disambiguate by `status`, never by `code` alone:
   *  reserved codes carry `status === 0` (`"decode"` its real 2xx status), a
   *  lifted code always the real non-2xx status. */
  readonly code?: string;
  /** Lifted from the error body's `request_id` / `requestId`, when present. */
  readonly requestId?: string;
  /** The parsed JSON body of the failed response, present when a real HTTP
   *  response carried parseable JSON (any shape). Absent on network / timeout
   *  / cancelled / invalid failures and on non-JSON / empty bodies.
   *
   *  SECURITY: server-controlled content, same trust level as `error` —
   *  validate the shape before reading fields, and render any text from it
   *  via textContent, never innerHTML. */
  readonly body?: unknown;
  /** Response headers, present only when an HTTP response was actually
   *  received (a non-2xx error, or a 2xx whose body failed decoding). Absent
   *  on network / timeout / cancelled / invalid failures, the same rule that
   *  makes {@link ApiOk.headers} always present. */
  readonly headers?: Headers;
}

/** Discriminated union returned by `requestRaw` and the `*Raw` verb helpers. */
export type ApiResult<T> = ApiOk<T> | ApiErr;

/** The options every request takes, whatever its 2xx body is read as. */
interface RequestOptionsBase {
  /** JSON-encoded and sent on a non-GET request unless it is `null` or
   *  `undefined`, so a JSON `null` body is never sent. Ignored on GET. */
  body?: unknown;
  /** Pre-encoded request body for non-GET requests, sent as-is with NO JSON
   *  encoding and NO automatic Content-Type — the caller owns the type via
   *  `headers`. Mutually exclusive with `body` (both set is a client-side
   *  `"invalid"` failure). */
  rawBody?: BodyInit;
  /** Caller cancellation signal, composed with the request timeout. */
  signal?: AbortSignal;
  /** Per-request headers, merged before the global `prepareHeaders` hook. */
  headers?: Record<string, string> | Headers;
  /** Overrides the default request timeout (`API_TIMEOUT_MS`) for this request. */
  timeoutMs?: number;
}

/** Options for a request whose 2xx body is read as JSON, the default. */
export interface RequestOptions<T = unknown> extends RequestOptionsBase {
  as?: "json";
  /** Optional runtime validation applied to a 2xx body. */
  decoder?: Decoder<T>;
  /** Skip reading a 2xx response body entirely: resolves ok with
   *  `data: undefined` and any `decoder` is not invoked. Non-2xx error bodies
   *  are still parsed. For endpoints whose success body is irrelevant or
   *  non-JSON. */
  ignoreBody?: boolean;
}

/** Options for a request whose 2xx body, a 204 included, is read whole as a
 *  `Blob` under `maxResponseBytes`. Its `type` is the response's
 *  `Content-Type`, lowercased, or empty when there is none or it holds a
 *  character outside printable ASCII. A non-2xx body is still read as JSON. */
export interface BlobRequestOptions extends RequestOptionsBase {
  as: "blob";
  decoder?: never;
  ignoreBody?: never;
}

/** What the one request implementation accepts behind the overloads.
 *  @internal */
export type AnyRequestOptions<T = unknown> = RequestOptions<T> | BlobRequestOptions;

/** Admits only `Blob` itself as a Blob read's `T`: a subtype such as `File`
 *  would claim fields the read never sets. */
type ExactlyBlob<T> = [Blob] extends [T] ? unknown : never;

/** The non-throwing request core: always resolves to an {@link ApiResult},
 *  never throws. */
export interface RequestRawFn {
  <T>(method: HttpMethod, path: string, opts?: RequestOptions<T>): Promise<ApiResult<T>>;
  <T extends Blob = Blob>(
    method: HttpMethod,
    path: string,
    opts: BlobRequestOptions & ExactlyBlob<T>,
  ): Promise<ApiResult<T>>;
}

/** The null-collapsing request: the decoded body, or `null` on any error or
 *  empty JSON body. */
export interface RequestFn {
  <T>(method: HttpMethod, path: string, opts?: RequestOptions<T>): Promise<T | null>;
  <T extends Blob = Blob>(
    method: HttpMethod,
    path: string,
    opts: BlobRequestOptions & ExactlyBlob<T>,
  ): Promise<T | null>;
}

/** A GET or DELETE helper returning the data or `null`. */
export interface ReadVerb {
  <T>(path: string, opts?: RequestOptions<T>): Promise<T | null>;
  <T extends Blob = Blob>(
    path: string,
    opts: BlobRequestOptions & ExactlyBlob<T>,
  ): Promise<T | null>;
}

/** A GET or DELETE helper returning the full {@link ApiResult}. */
export interface ReadVerbRaw {
  <T>(path: string, opts?: RequestOptions<T>): Promise<ApiResult<T>>;
  <T extends Blob = Blob>(
    path: string,
    opts: BlobRequestOptions & ExactlyBlob<T>,
  ): Promise<ApiResult<T>>;
}

/** A helper sending a JSON body and returning the data or `null`. */
export interface WriteVerb {
  <T>(path: string, body?: unknown, opts?: RequestOptions<T>): Promise<T | null>;
  <T extends Blob = Blob>(
    path: string,
    body: unknown,
    opts: BlobRequestOptions & ExactlyBlob<T>,
  ): Promise<T | null>;
}

/** A helper sending a JSON body and returning the full {@link ApiResult}. */
export interface WriteVerbRaw {
  <T>(path: string, body?: unknown, opts?: RequestOptions<T>): Promise<ApiResult<T>>;
  <T extends Blob = Blob>(
    path: string,
    body: unknown,
    opts: BlobRequestOptions & ExactlyBlob<T>,
  ): Promise<ApiResult<T>>;
}
