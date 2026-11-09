// Typed per-key store: a facade over the signal engine with one lazily-created
// signal per key, and no reactivity of its own.
//
// A Store member exists only where it does something the engine's namesake
// does not: `subscribe` skips the initial call and runs untracked, `computed`
// is an eager key-writing effect. `batch` and `effect` stay off the store,
// because `store.batch(…)` reads as store-scoped while it batches the whole
// graph, a scope the flush model does not have.

import { signal, effect, untracked, type Signal } from "./signal.js";

/** A typed per-key reactive store: lazily signal-backed keys, change-only
 *  subscriptions, and eager derived keys. Effects and batching are the engine's
 *  own `effect` / `batch`, imported from the package root. */
export interface Store<M> {
  get<K extends keyof M & string>(key: K): M[K];
  set<K extends keyof M & string>(key: K, value: M[K]): void;
  subscribe<K extends keyof M & string>(key: K, cb: (value: M[K]) => void): () => void;
  /** Derive `outputKey` from other keys. NOT a lazy engine `computed`: this is
   *  an EAGER effect that re-runs `fn` on dependency change and WRITES the
   *  result to `outputKey`. Consequences of that shape: `fn` runs whether or
   *  not anyone reads `outputKey`; a throwing `fn` is isolated by the effect
   *  error handler (not cached and rethrown at the read site like an engine
   *  computed); `set(outputKey, …)` still works between recomputes; and a
   *  self-reading `fn` behaves as documented on the implementation below.
   *  Returns the effect's dispose function. */
  computed<K extends keyof M & string>(outputKey: K, fn: () => M[K]): () => void;
}

/** Create a typed reactive store. Keys are lazily backed by signals; reading a
 *  key inside an effect auto-tracks it, and writes notify through the engine. */
export function createStore<M>(): Store<M> {
  const sigs = new Map<string, Signal<unknown>>();

  function sigFor<K extends keyof M & string>(key: K): Signal<M[K]> {
    let s = sigs.get(key);
    if (s === undefined) {
      // Unset keys read as `undefined` (matching a sparse record) until first set.
      s = signal<unknown>(undefined);
      sigs.set(key, s);
    }
    return s as Signal<M[K]>;
  }

  function get<K extends keyof M & string>(key: K): M[K] {
    return sigFor(key).value;
  }

  function set<K extends keyof M & string>(key: K, value: M[K]): void {
    sigFor(key).value = value;
  }

  // Notify on change only (not immediately on subscribe) — the engine's
  // `subscribe` fires immediately, so skip the initial effect run.
  function subscribe<K extends keyof M & string>(key: K, cb: (value: M[K]) => void): () => void {
    const s = sigFor(key);
    let primed = false;
    return effect(() => {
      const v = s.value;
      if (!primed) {
        primed = true;
        return;
      }
      // Untracked, mirroring the engine's `subscribe`: a callback that reads
      // other keys must not become a dependency of this subscription.
      untracked(() => {
        cb(v);
      });
    });
  }

  // A derived key: an effect that writes `outputKey` from `fn`. A `fn` that reads
  // `outputKey` and yields a new value each run trips the engine's batch-iteration
  // guard after ~100 re-runs, surfacing Error("Cycle detected") through the effect
  // error handler (effects isolate errors, so it is NOT rethrown to the caller); a
  // self-read that returns a stable value settles via Object.is dedup without looping.
  function computed<K extends keyof M & string>(outputKey: K, fn: () => M[K]): () => void {
    return effect(() => {
      set(outputKey, fn());
    });
  }

  return { get, set, subscribe, computed };
}
