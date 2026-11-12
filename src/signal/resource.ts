import {
  createRoot,
  effect,
  requireOwner,
  runWithOwner,
  signal,
  type ReadonlySignal,
} from "./signal.js";

/** The state of an async value: loading, ready or failed. `stale` is the last
 *  ready value, kept while a later run loads or after it fails. */
export type Loadable<T, E = unknown> =
  | { readonly state: "loading"; readonly stale?: T }
  | { readonly state: "ready"; readonly data: T }
  | { readonly state: "error"; readonly error: E; readonly stale?: T };

/** A signal of the latest run's `Loadable`, with `refetch` to start a new run. */
export interface Resource<T, E = unknown> extends ReadonlySignal<Loadable<T, E>> {
  /** Start a new run for the current source value, superseding the running
   *  one. Does nothing once the resource's owner is being disposed. */
  refetch(): void;
}

/** Options for `resource`. */
export interface ResourceOptions<S> {
  /** Source equality; an equal new source value starts no run. Defaults to
   *  `Object.is`. */
  readonly equals?: (a: S, b: S) => boolean;
}

/** Load `load(source(), signal)` now and again whenever the tracked `source`
 *  changes, owned by the current owner. Each run has its own owner, whose
 *  `signal` is the one passed to `load` and which is current while `load`
 *  runs: a new source value, `refetch()` or the resource's disposal disposes
 *  the previous run, and a disposed run's settlement writes nothing. `E` is
 *  whatever `load` throws or rejects with. A throw from `source` goes to the
 *  effect error handler and starts no run. Throws outside an owner, or under
 *  one being disposed. */
export function resource<S, T, E = unknown>(
  source: () => S,
  load: (source: S, signal: AbortSignal) => Promise<T>,
  options?: ResourceOptions<S>,
): Resource<T, E> {
  const owner = requireOwner("a resource");
  const equals = options?.equals ?? Object.is;
  const state = signal<Loadable<T, E>>({ state: "loading" });
  let good: { readonly data: T } | undefined;
  let current: { readonly value: S } | undefined;
  let disposeRun: (() => void) | undefined;

  const start = (value: S): void => {
    runWithOwner(owner, () => {
      disposeRun?.();
      createRoot((dispose, run) => {
        disposeRun = dispose;
        state.value =
          good === undefined ? { state: "loading" } : { state: "loading", stale: good.data };
        // The async wrapper turns a synchronous throw from `load` into a rejection.
        const pending = (async (): Promise<T> => load(value, run.signal))();
        pending.then(
          (data) => {
            if (!run.signal.aborted) {
              good = { data };
              state.value = { state: "ready", data };
            }
          },
          (error: unknown) => {
            if (!run.signal.aborted) {
              state.value =
                good === undefined
                  ? { state: "error", error: error as E }
                  : { state: "error", error: error as E, stale: good.data };
            }
          },
        );
      });
    });
  };

  effect(() => {
    const value = source();
    const prev = current;
    current = { value };
    if (prev === undefined || !equals(prev.value, value)) {
      start(value);
    }
  });

  return {
    get value(): Loadable<T, E> {
      return state.value;
    },
    peek(): Loadable<T, E> {
      return state.peek();
    },
    refetch(): void {
      if (current !== undefined) {
        start(current.value);
      }
    },
  };
}
