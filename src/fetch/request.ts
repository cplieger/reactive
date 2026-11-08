import type { FetchConfig } from "./types.js";
import { API_TIMEOUT_MS, requestSignal, type AbortSource } from "./timeout.js";
import type { AnyRequestOptions, ApiErr, ApiResult, FailedRequest, HttpMethod } from "./types.js";

/** The single implementation behind every `RequestRawFn` overload. */
export type RequestRawCore = <T>(
  method: HttpMethod,
  path: string,
  opts?: AnyRequestOptions<T>,
) => Promise<ApiResult<T>>;

/** The single implementation behind every `RequestFn` overload. */
export type RequestCore = <T>(
  method: HttpMethod,
  path: string,
  opts?: AnyRequestOptions<T>,
) => Promise<T | null>;

const JSON_CT = "application/json";

/** Extract a human-readable message from an unknown thrown value without
 *  risking a `[object Object]` stringification. */
function errMsg(e: unknown): string {
  if (e instanceof Error || e instanceof DOMException) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  return "unknown error";
}

/** Narrow an unknown parsed body to an indexable object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Build an ApiErr, omitting optional fields when absent
 *  (exactOptionalPropertyTypes). `headers`/`body` are passed only where a real
 *  HTTP response exists, per the ApiErr contract. */
function makeErr(
  status: number,
  error: string,
  code?: string,
  requestId?: string,
  headers?: Headers,
  body?: unknown,
): ApiErr {
  const err: {
    ok: false;
    status: number;
    error: string;
    code?: string;
    requestId?: string;
    headers?: Headers;
    body?: unknown;
  } = {
    ok: false,
    status,
    error,
  };
  if (code !== undefined) {
    err.code = code;
  }
  if (requestId !== undefined) {
    err.requestId = requestId;
  }
  if (headers !== undefined) {
    err.headers = headers;
  }
  if (body !== undefined) {
    err.body = body;
  }
  return err;
}

/** Coerce a possibly-non-numeric status (a custom fetchFn may return a
 *  malformed object) to a number, defaulting to 0. */
function statusOf(res: Response): number {
  return typeof res.status === "number" ? res.status : 0;
}

/** Neutralize a relative path's navigation syntax before it joins a base URL,
 *  so URL normalization cannot pop the base path prefix. Backslashes, and in
 *  the path part ASCII TAB/LF/CR (which the WHATWG parser strips, fusing two
 *  dots into a live `..`), are percent-encoded. Every dot-segment, encoded or
 *  not, is double-encoded to `%252E`: the parser still pops `%2E`. */
function safeSuffix(path: string): string {
  // Query (`?`) / fragment (`#`) are isolated before segment processing: the
  // URL parser does not path-normalize them and they must reach the server
  // verbatim.
  const marks = [path.indexOf("?"), path.indexOf("#")].filter((i) => i !== -1);
  const sep = marks.length > 0 ? Math.min(...marks) : -1;
  const pathPart = sep === -1 ? path : path.slice(0, sep);
  const rest = sep === -1 ? "" : path.slice(sep);
  const raw = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const encoded = raw
    .replace(/\\/g, "%5C")
    .replace(/\t/g, "%09")
    .replace(/\n/g, "%0A")
    .replace(/\r/g, "%0D")
    .split("/")
    .map((segment) => {
      const dotLike = segment.replace(/%2e/gi, ".");
      if (dotLike === "." || dotLike === "..") {
        return segment.replace(/\./g, "%2E").replace(/%/g, "%25");
      }
      return segment;
    })
    .join("/");
  return encoded + rest;
}

/**
 * Join a base URL with a relative path: strip a trailing slash from the base,
 * then append the path via {@link safeSuffix}. With no base, the path is
 * returned verbatim.
 */
function joinUrl(baseUrl: string | undefined, path: string): string {
  if (baseUrl === undefined) {
    return path;
  }
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${safeSuffix(path)}`;
}

/** Merge caller-supplied headers (object or Headers) into the target. */
function mergeHeaders(target: Headers, source: Record<string, string> | Headers | undefined): void {
  if (source === undefined) {
    return;
  }
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      target.set(key, value);
    });
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    target.set(key, value);
  }
}

/** The caller-aborted-wins envelope shared by both classifiers. */
function cancelledErr(): ApiErr {
  return makeErr(0, "request cancelled", "cancelled");
}

/**
 * Classify a throw from the BUILD phase (header construction, JSON body
 * encoding, `prepareHeaders`, timeout composition, url join). A caller that
 * already aborted classifies as "cancelled"; every other build failure is a
 * client-side "invalid" request — it never reached the network.
 */
function classifyBuildError(e: unknown, callerSignal: AbortSignal | undefined): ApiErr {
  if (callerSignal?.aborted === true) {
    return cancelledErr();
  }
  return makeErr(0, errMsg(e), "invalid");
}

/**
 * Classify a thrown error from the FETCH / response-read phase. Priority:
 * the caller's abort won the request signal → "cancelled"; DOMException
 * TimeoutError / AbortError → "timeout"; everything else → "network".
 */
function classifyThrown(e: unknown, winner: AbortSource | undefined): ApiErr {
  if (winner === "caller") {
    return cancelledErr();
  }
  if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return makeErr(0, e.message, "timeout");
  }
  return makeErr(0, errMsg(e), "network");
}

/** Start releasing a body the decided result no longer reads, without
 *  waiting: a cancel that throws, rejects or never settles cannot replace or
 *  hold that result. */
function releaseQuietly(cancel: () => Promise<void> | undefined): void {
  try {
    void cancel()?.catch(() => undefined);
  } catch {
    // A custom fetchFn's stream may throw where a platform one rejects.
  }
}

/** Read a response body's bytes, refusing more than `max`: a `content-length`
 *  over the cap is rejected up front and the streamed body is aborted the
 *  moment it exceeds the cap, so an untrusted upstream cannot force unbounded
 *  buffering. */
async function readChunks(res: Response, max: number): Promise<Uint8Array<ArrayBuffer>[]> {
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > max) {
    throw new Error(`response exceeds ${max} bytes`);
  }
  const body = res.body;
  if (body === null) {
    return [];
  }
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      return chunks;
    }
    total += result.value.byteLength;
    if (total > max) {
      releaseQuietly(() => reader.cancel());
      throw new Error(`response exceeds ${max} bytes`);
    }
    chunks.push(result.value);
  }
}

/** Read a response body as text, bounded to `max` bytes when set. */
async function readBoundedText(res: Response, max: number | undefined): Promise<string> {
  if (max === undefined) {
    return res.text();
  }
  return new Blob(await readChunks(res, max)).text();
}

/** Read a response body as a `Blob` typed by its `Content-Type`, bounded to
 *  `max` bytes when set. */
async function readBoundedBlob(res: Response, max: number | undefined): Promise<Blob> {
  const type = res.headers.get("content-type") ?? "";
  return new Blob(await readChunks(res, max ?? Number.POSITIVE_INFINITY), { type });
}

/** Parse a non-2xx response body, lifting error / code / request_id fields. */
async function parseErrorResponse(res: Response, max: number | undefined): Promise<ApiErr> {
  const status = statusOf(res);
  let error = `HTTP ${status}`;
  let code: string | undefined;
  let requestId: string | undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedText(res, max));
    if (isRecord(parsed)) {
      const errField = parsed["error"];
      if (typeof errField === "string") {
        error = errField;
      }
      const codeField = parsed["code"];
      if (typeof codeField === "string") {
        code = codeField;
      }
      const ridField = parsed["request_id"] ?? parsed["requestId"];
      if (typeof ridField === "string") {
        requestId = ridField;
      }
    }
  } catch {
    // Non-JSON / empty error body: keep the `HTTP <status>` fallback.
  }
  return makeErr(status, error, code, requestId, res.headers, parsed);
}

function logObserverError(e: unknown): void {
  try {
    console.error("@cplieger/reactive: onError threw", e);
  } catch {
    // A throwing console cannot reach the caller either.
  }
}

/** Hand a failure to the instance's observer, which must never change or
 *  delay the result its caller receives. */
function notify(
  onError: NonNullable<FetchConfig["onError"]>,
  err: ApiErr,
  req: FailedRequest,
): void {
  try {
    Promise.resolve(onError(err, req)).catch(logObserverError);
  } catch (e) {
    logObserverError(e);
  }
}

/**
 * Build the non-throwing request core bound to an immutable config, captured
 * once at instance construction ({@link createFetch}).
 */
export function makeRequestRaw(cfg: FetchConfig): RequestRawCore {
  const perform = async function perform<T>(
    method: HttpMethod,
    path: string,
    opts?: AnyRequestOptions<T>,
  ): Promise<ApiResult<T>> {
    let callerSignal: AbortSignal | undefined;
    let winner: () => AbortSource | undefined;

    // --- Build phase ------------------------------------------------------
    // A throw here is a client-side "invalid" request (or "cancelled" if the
    // caller already aborted) — never hit the network.
    const init: RequestInit = { method };
    let url: string;
    try {
      callerSignal = opts?.signal;
      const headers = new Headers();
      if (opts?.rawBody !== undefined && opts.body != null) {
        throw new TypeError("body and rawBody are mutually exclusive");
      }
      // The option types refuse this pairing; a JavaScript caller can still pass it.
      const loose: { as?: unknown; decoder?: unknown; ignoreBody?: unknown } | undefined = opts;
      if (loose?.as === "blob" && (loose.decoder !== undefined || loose.ignoreBody === true)) {
        throw new TypeError('as: "blob" excludes decoder and ignoreBody');
      }
      if (method !== "GET" && opts?.rawBody !== undefined) {
        init.body = opts.rawBody;
      } else if (method !== "GET" && opts?.body != null) {
        const encoded = JSON.stringify(opts.body) as string | undefined;
        if (encoded === undefined) {
          throw new TypeError("request body is not JSON-encodable");
        }
        headers.set("Content-Type", JSON_CT);
        init.body = encoded;
      }
      mergeHeaders(headers, opts?.headers);

      let effectiveHeaders = headers;
      if (cfg.prepareHeaders !== undefined) {
        const prepared = await cfg.prepareHeaders(headers);
        if (prepared !== undefined) {
          effectiveHeaders = prepared;
        }
      }
      init.headers = effectiveHeaders;

      if (cfg.credentials !== undefined) {
        init.credentials = cfg.credentials;
      }

      const composed = requestSignal(callerSignal, opts?.timeoutMs ?? API_TIMEOUT_MS);
      init.signal = composed.signal;
      winner = composed.winner;
      url = joinUrl(cfg.baseUrl, path);
    } catch (e) {
      return classifyBuildError(e, callerSignal);
    }

    // --- Fetch phase --------------------------------------------------------
    // A throw here is a genuine network / timeout / cancellation failure.
    let res: Response;
    try {
      const fetchImpl = cfg.fetchFn ?? fetch;
      res = await fetchImpl(url, init);
    } catch (e) {
      return classifyThrown(e, winner());
    }

    // --- Response phase -----------------------------------------------------
    // The outer try preserves the never-throw guarantee for a malformed
    // result from a custom fetchFn and for a mid-body read failure. A
    // JSON.parse / decoder throw is a "decode" error, handled by its own
    // inner try before it can reach here.
    try {
      if (!res.ok) {
        return await parseErrorResponse(res, cfg.maxResponseBytes);
      }
      const status = statusOf(res);
      if (opts?.as === "blob") {
        const blob = await readBoundedBlob(res, cfg.maxResponseBytes);
        return { ok: true, status, data: blob as T, headers: res.headers };
      }
      if (status === 204) {
        return { ok: true, status, data: undefined as T, headers: res.headers };
      }

      if (opts?.ignoreBody === true) {
        releaseQuietly(() => res.body?.cancel());
        return { ok: true, status, data: undefined as T, headers: res.headers };
      }

      const text = await readBoundedText(res, cfg.maxResponseBytes);
      if (text === "") {
        return { ok: true, status, data: undefined as T, headers: res.headers };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return makeErr(status, `response not JSON: ${errMsg(e)}`, "decode", undefined, res.headers);
      }

      if (opts?.decoder !== undefined) {
        try {
          return { ok: true, status, data: opts.decoder(parsed), headers: res.headers };
        } catch (e) {
          return makeErr(
            status,
            `response shape mismatch: ${errMsg(e)}`,
            "decode",
            undefined,
            res.headers,
            parsed,
          );
        }
      }

      return { ok: true, status, data: parsed as T, headers: res.headers };
    } catch (e) {
      return classifyThrown(e, winner());
    }
  };

  return async function requestRaw<T>(
    method: HttpMethod,
    path: string,
    opts?: AnyRequestOptions<T>,
  ): Promise<ApiResult<T>> {
    const result = await perform(method, path, opts);
    if (!result.ok && cfg.onError !== undefined) {
      notify(cfg.onError, result, { method, path });
    }
    return result;
  };
}

/**
 * Build a null-collapsing `request` over a `requestRaw`: the decoded data on a
 * successful result, or `null` on any error.
 */
export function makeRequest(raw: RequestRawCore): RequestCore {
  return async function request<T>(
    method: HttpMethod,
    path: string,
    opts?: AnyRequestOptions<T>,
  ): Promise<T | null> {
    const result = await raw<T>(method, path, opts);
    return result.ok && result.data !== undefined ? result.data : null;
  };
}
