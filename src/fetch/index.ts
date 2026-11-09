/** Typed HTTP requests that never throw: each resolves to a result envelope, or to `null` on failure. @module */

export { createFetch } from "./instance.js";
export type { FetchInstance } from "./instance.js";

export { API_TIMEOUT_MS, withTimeout } from "./timeout.js";

export type {
  ApiErr,
  ApiOk,
  ApiResult,
  BlobRequestOptions,
  Decoder,
  FailedRequest,
  FetchConfig,
  HttpMethod,
  RequestOptions,
} from "./types.js";
