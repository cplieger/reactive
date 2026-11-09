/** Default request timeout in milliseconds. */
export const API_TIMEOUT_MS = 30_000;

/**
 * Compose an optional caller signal with a fresh timeout signal: the result
 * aborts on whichever fires first, with that signal's `reason`. Throws the
 * `TypeError` of `AbortSignal.timeout` for an out-of-range `ms`.
 */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (signal === undefined) {
    return timeout;
  }
  // Preferred where present: the native composite lets a finished request be
  // collected at once instead of when its timeout fires.
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, timeout]);
  }
  return firstAbort(signal, timeout);
}

/** @internal Which source aborted a request's signal first. */
export type AbortSource = "caller" | "timeout";

/** @internal {@link withTimeout}'s signal, plus the source that won it: set
 *  once when the signal aborts, `undefined` while it has not. */
export function requestSignal(
  caller: AbortSignal | undefined,
  ms: number,
): { readonly signal: AbortSignal; readonly winner: () => AbortSource | undefined } {
  const signal = withTimeout(caller, ms);
  let winner: AbortSource | undefined;
  // Hooked before `signal` is handed out, so it runs before any code that sees
  // the abort could abort the caller: here `caller.aborted` means the caller won.
  // Write-once on the real abort: an "abort" event anyone dispatches on the
  // handed-out signal, before it aborted or after the winner is set, is ignored.
  const record = (): void => {
    if (winner === undefined && signal.aborted) {
      winner = caller?.aborted === true ? "caller" : "timeout";
    }
  };
  record();
  signal.addEventListener("abort", record);
  return { signal, winner: () => winner };
}

/** `AbortSignal.any` for the runtimes without it (Chrome before 116, Safari
 *  before 17.4, Firefox before 124, Node before 20.3). */
function firstAbort(a: AbortSignal, b: AbortSignal): AbortSignal {
  const out = new AbortController();
  for (const source of [a, b]) {
    if (source.aborted) {
      out.abort(source.reason);
      return out.signal;
    }
  }
  // The first abort unhooks both listeners, so a long-lived caller signal holds
  // a finished request's controller only until that request's timeout fires.
  const unhook = new AbortController();
  const forward = (source: AbortSignal) => () => {
    out.abort(source.reason);
    unhook.abort();
  };
  a.addEventListener("abort", forward(a), { signal: unhook.signal });
  b.addEventListener("abort", forward(b), { signal: unhook.signal });
  return out.signal;
}
