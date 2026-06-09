// collection.ts — reactive ordered collection of keyed entities.
//
// Generalizes the "list of entities, each independently reactive, plus a
// separate structure signal" model: a per-entity content update touches only
// that entity's subscribers, while add/remove/reorder bumps the `ids` signal.
// This is the data half of the two-tier list pattern (see `bindList` for the
// render half). Built on `signal` + `SignalMap` — no separate engine.

import { signal, batch, type ReadonlySignal } from "./signal.js";
import { SignalMap } from "./signal-map.js";

/** A reactive, ordered, keyed collection of entities of type T. */
export interface Collection<T> {
  /** Replace the whole collection (e.g. initial load). Entities no longer
   *  present are dropped; the order becomes exactly `items`. */
  setAll(items: readonly T[]): void;
  /** Add a new entity or replace an existing one (keyed by `keyOf`). New
   *  entities are appended to the order. */
  upsert(item: T): void;
  /** Add new entities to the FRONT of the order (e.g. loading older items for
   *  scroll-up pagination). Existing ids are updated in place without moving. */
  prepend(items: readonly T[]): void;
  /** Update one entity in place (no-op if absent). Pass a value or an
   *  updater. Does not change order. */
  update(id: string, next: T | ((cur: T) => T)): void;
  /** Remove one entity (no-op if absent). */
  remove(id: string): void;
  /** Remove every entity. */
  clear(): void;
  /** Current value of one entity (untracked peek), or undefined. */
  get(id: string): T | undefined;
  /** Whether an entity is present (untracked). */
  has(id: string): boolean;
  /** Reactive per-entity signal, or undefined if absent. Read inside an effect
   *  to react only when THIS entity changes (the content tier). */
  signalFor(id: string): ReadonlySignal<T> | undefined;
  /** Reactive ordered id list — changes on add/remove/reorder, NOT on a
   *  per-entity content update (the structure tier). */
  readonly ids: ReadonlySignal<readonly string[]>;
  /** Ordered snapshot of entity values. Reactive: reading this inside an
   *  effect tracks order AND every entity (coarse — use `ids` + `signalFor`
   *  for the two-tier split). */
  items(): T[];
  /** Entity count (untracked). */
  readonly size: number;
}

/** Create a reactive ordered keyed collection. `keyOf` derives a stable
 *  string id from an entity. */
export function createCollection<T>(keyOf: (item: T) => string): Collection<T> {
  // Shallow-equal so the structure tier fires only when the id sequence
  // actually changes (a same-order setAll updates entities without a
  // spurious structural re-render).
  const order = signal<readonly string[]>([], {
    equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  });
  const sigs = new SignalMap<T>();

  function setAll(items: readonly T[]): void {
    // Atomic: batch the per-entity writes + the order swap so effects (and any
    // row update that cross-reads siblings) only run once the whole collection
    // is consistent, not mid-mutation.
    batch(() => {
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        const id = keyOf(item);
        ids.push(id);
        seen.add(id);
        sigs.ensure(id, item).value = item;
      }
      for (const id of order.peek()) {
        if (!seen.has(id)) {
          sigs.clear(id);
        }
      }
      order.value = ids;
    });
  }

  function upsert(item: T): void {
    const id = keyOf(item);
    const existing = sigs.get(id);
    if (existing === undefined) {
      sigs.ensure(id, item);
      order.value = [...order.peek(), id];
    } else {
      existing.value = item;
    }
  }

  function prepend(items: readonly T[]): void {
    batch(() => {
      const newIds: string[] = [];
      for (const item of items) {
        const id = keyOf(item);
        const existing = sigs.get(id);
        if (existing === undefined) {
          sigs.ensure(id, item);
          newIds.push(id);
        } else {
          existing.value = item;
        }
      }
      if (newIds.length > 0) {
        order.value = [...newIds, ...order.peek()];
      }
    });
  }

  function update(id: string, next: T | ((cur: T) => T)): void {
    const s = sigs.get(id);
    if (s === undefined) {
      return;
    }
    s.value = typeof next === "function" ? (next as (cur: T) => T)(s.peek()) : next;
  }

  function remove(id: string): void {
    if (sigs.get(id) === undefined) {
      return;
    }
    sigs.clear(id);
    order.value = order.peek().filter((x) => x !== id);
  }

  function clear(): void {
    sigs.clearAll();
    order.value = [];
  }

  function get(id: string): T | undefined {
    return sigs.get(id)?.peek();
  }

  function has(id: string): boolean {
    return sigs.get(id) !== undefined;
  }

  function signalFor(id: string): ReadonlySignal<T> | undefined {
    return sigs.get(id);
  }

  function items(): T[] {
    const result: T[] = [];
    for (const id of order.value) {
      const s = sigs.get(id);
      if (s !== undefined) {
        result.push(s.value);
      }
    }
    return result;
  }

  return {
    setAll,
    upsert,
    prepend,
    update,
    remove,
    clear,
    get,
    has,
    signalFor,
    items,
    get ids(): ReadonlySignal<readonly string[]> {
      return order;
    },
    get size(): number {
      return order.peek().length;
    },
  };
}
