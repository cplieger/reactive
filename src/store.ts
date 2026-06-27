// Typed per-key reactive store — a thin facade over the signal engine.
//
// Each key is backed by a lazily-created signal, so the store inherits the
// engine's glitch-freedom, cycle detection, batching, and error handling.
// There is NO separate reactivity implementation here: get/set read and
// write signals, effect/batch are the engine's own, and auto-tracking falls
// out of reading `signal.value` inside an effect.
//
// Usage:
//   import { createStore } from './store.js';
//   interface MyMap { count: number; name: string }
//   const { get, set, subscribe, effect, computed, batch } = createStore<MyMap>();

import { signal, effect, batch, type Signal, type Cleanup } from "./signal.js";

/** A typed per-key reactive store with auto-tracked effects, computed, and batching. */
export interface Store<M> {
  get<K extends keyof M & string>(key: K): M[K];
  set<K extends keyof M & string>(key: K, value: M[K]): void;
  subscribe<K extends keyof M & string>(key: K, cb: (value: M[K]) => void): () => void;
  effect(fn: () => Cleanup): () => void;
  computed<K extends keyof M & string>(outputKey: K, fn: () => M[K]): () => void;
  batch(fn: () => void): void;
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
      cb(v);
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

  return { get, set, subscribe, effect, computed, batch };
}
