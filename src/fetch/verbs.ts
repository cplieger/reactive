import type { RequestCore, RequestRawCore } from "./request.js";
import type {
  AnyRequestOptions,
  ApiResult,
  Decoder,
  ReadVerb,
  ReadVerbRaw,
  RequestOptions,
  WriteVerb,
  WriteVerbRaw,
} from "./types.js";

/** The bundle of 12 verb helpers a fetch instance exposes. */
export interface FetchVerbs {
  /** GET; returns the decoded body or `null` on any error. */
  apiGet: ReadVerb;
  /** POST a JSON body; returns the decoded body or `null` on any error. */
  apiPost: WriteVerb;
  /** PUT a JSON body; returns the decoded body or `null` on any error. */
  apiPut: WriteVerb;
  /** PATCH a JSON body; returns the decoded body or `null` on any error. */
  apiPatch: WriteVerb;
  /** DELETE; returns the decoded body or `null` on any error. */
  apiDelete: ReadVerb;
  /** GET with runtime validation; returns the decoded body or `null` on any error. */
  apiGetTyped: <T>(
    path: string,
    decoder: Decoder<T>,
    opts?: RequestOptions<T>,
  ) => Promise<T | null>;
  /** POST with runtime validation; returns the decoded body or `null` on any error. */
  apiPostTyped: <T>(
    path: string,
    body: unknown,
    decoder: Decoder<T>,
    opts?: RequestOptions<T>,
  ) => Promise<T | null>;
  /** GET; returns the full {@link ApiResult} envelope. */
  apiGetRaw: ReadVerbRaw;
  /** POST a JSON body; returns the full {@link ApiResult} envelope. */
  apiPostRaw: WriteVerbRaw;
  /** PUT a JSON body; returns the full {@link ApiResult} envelope. */
  apiPutRaw: WriteVerbRaw;
  /** PATCH a JSON body; returns the full {@link ApiResult} envelope. */
  apiPatchRaw: WriteVerbRaw;
  /** DELETE; returns the full {@link ApiResult} envelope. */
  apiDeleteRaw: ReadVerbRaw;
}

/** Bind the 12 verb helpers to a `(request, requestRaw)` pair. */
export function makeVerbs(request: RequestCore, requestRaw: RequestRawCore): FetchVerbs {
  return {
    apiGet<T>(path: string, opts?: AnyRequestOptions<T>): Promise<T | null> {
      return request<T>("GET", path, opts);
    },
    apiPost<T>(path: string, body?: unknown, opts?: AnyRequestOptions<T>): Promise<T | null> {
      return request<T>("POST", path, { ...opts, body });
    },
    apiPut<T>(path: string, body?: unknown, opts?: AnyRequestOptions<T>): Promise<T | null> {
      return request<T>("PUT", path, { ...opts, body });
    },
    apiPatch<T>(path: string, body?: unknown, opts?: AnyRequestOptions<T>): Promise<T | null> {
      return request<T>("PATCH", path, { ...opts, body });
    },
    apiDelete<T>(path: string, opts?: AnyRequestOptions<T>): Promise<T | null> {
      return request<T>("DELETE", path, opts);
    },
    apiGetTyped<T>(path: string, decoder: Decoder<T>, opts?: RequestOptions<T>): Promise<T | null> {
      return request<T>("GET", path, { ...opts, decoder });
    },
    apiPostTyped<T>(
      path: string,
      body: unknown,
      decoder: Decoder<T>,
      opts?: RequestOptions<T>,
    ): Promise<T | null> {
      return request<T>("POST", path, { ...opts, body, decoder });
    },
    apiGetRaw<T>(path: string, opts?: AnyRequestOptions<T>): Promise<ApiResult<T>> {
      return requestRaw<T>("GET", path, opts);
    },
    apiPostRaw<T>(
      path: string,
      body?: unknown,
      opts?: AnyRequestOptions<T>,
    ): Promise<ApiResult<T>> {
      return requestRaw<T>("POST", path, { ...opts, body });
    },
    apiPutRaw<T>(path: string, body?: unknown, opts?: AnyRequestOptions<T>): Promise<ApiResult<T>> {
      return requestRaw<T>("PUT", path, { ...opts, body });
    },
    apiPatchRaw<T>(
      path: string,
      body?: unknown,
      opts?: AnyRequestOptions<T>,
    ): Promise<ApiResult<T>> {
      return requestRaw<T>("PATCH", path, { ...opts, body });
    },
    apiDeleteRaw<T>(path: string, opts?: AnyRequestOptions<T>): Promise<ApiResult<T>> {
      return requestRaw<T>("DELETE", path, opts);
    },
  };
}
