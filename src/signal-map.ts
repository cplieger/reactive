// SignalMap — a registry of lazily-created signals keyed by string ID.
//
// For dynamic, per-entity reactive state where the key set isn't known ahead
// of time (per-message streaming text, per-tool-call, per-row state, …). This
// complements `createStore`, whose typed key set is fixed at the type level.
// Like everything else here it's a facade over `signal` — no separate engine.

import { signal, type Signal } from "./signal.js";

/** A typed map of lazily-created signals keyed by string ID. Provides
 *  get / ensure / clear / clearAll over any value type. */
export class SignalMap<V> {
  private readonly map = new Map<string, Signal<V>>();

  /** The signal for `id`, or undefined if none has been created yet. */
  get(id: string): Signal<V> | undefined {
    return this.map.get(id);
  }

  /** The signal for `id`, creating it with `initial` on first access. */
  ensure(id: string, initial: V): Signal<V> {
    let sig = this.map.get(id);
    if (sig === undefined) {
      sig = signal(initial);
      this.map.set(id, sig);
    }
    return sig;
  }

  /** Drop the signal for `id` (e.g. when the entity is removed). */
  clear(id: string): void {
    this.map.delete(id);
  }

  /** Drop every signal — e.g. on a wholesale context switch. */
  clearAll(): void {
    this.map.clear();
  }
}
