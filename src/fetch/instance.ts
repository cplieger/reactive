import { makeRequest, makeRequestRaw } from "./request.js";
import { makeVerbs } from "./verbs.js";
import type { FetchVerbs } from "./verbs.js";
import type { FetchConfig, RequestFn, RequestRawFn } from "./types.js";

/** An isolated fetch instance: its own immutable config, request core, and 12
 *  verb helpers. Returned by {@link createFetch}. */
export interface FetchInstance extends FetchVerbs {
  /** The non-throwing request core bound to this instance. */
  requestRaw: RequestRawFn;
  /** The null-collapsing request bound to this instance. */
  request: RequestFn;
}

/**
 * Create an isolated fetch instance. `config` is shallow-copied and frozen, so
 * two instances never share settings and a changed backend is a new instance;
 * read late-bound state, such as a token, inside `prepareHeaders`.
 * Throws a `TypeError` on a `maxResponseBytes` that is `NaN` or negative.
 */
export function createFetch(config: FetchConfig = {}): FetchInstance {
  const max = config.maxResponseBytes;
  if (max !== undefined && !(max >= 0)) {
    throw new TypeError(
      `createFetch: maxResponseBytes must be a byte count of 0 or more (or Infinity for no cap), not ${String(max)}`,
    );
  }
  const cfg: FetchConfig = Object.freeze({ ...config });
  const requestRaw = makeRequestRaw(cfg);
  const request = makeRequest(requestRaw);
  const verbs = makeVerbs(request, requestRaw);
  return {
    ...verbs,
    requestRaw,
    request,
  };
}
