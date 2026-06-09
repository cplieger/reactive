// bind-list.ts — two-tier render binding for a reactive list source.
//
// Tier 1 (structure): one effect tracks `source.ids` and runs `reconcile`
// over the id list, so add/remove/reorder touch the DOM minimally.
// Tier 2 (content): each row owns a private effect that tracks ONLY its own
// entity signal, so a per-entity update repaints just that row without a
// structural reconcile. The engine isolates nested-effect tracking
// (evalContext save/restore in signal.ts), so the per-row effect's reads never
// leak into the structural effect.
//
// The source is a `ListSource<T>` — anything exposing a structure signal
// (`ids`) plus a per-id content signal lookup (`signalFor`). A `Collection<T>`
// satisfies it directly; a filtered/sorted/paginated view is just a `computed`
// id-list paired with the collection's `signalFor` (so pagination is a sliced
// view, not a separate primitive).

import { reconcile } from "./reconcile.js";
import { effect, type ReadonlySignal } from "./signal.js";

/** The minimal reactive surface `bindList` renders: a structure signal (the
 *  ordered ids) and a per-id content-signal lookup. `Collection<T>` satisfies
 *  this; so does `{ ids: computed(...), signalFor: collection.signalFor }`. */
export interface ListSource<T> {
  readonly ids: ReadonlySignal<readonly string[]>;
  signalFor(id: string): ReadonlySignal<T> | undefined;
}

/** Row lifecycle for `bindList`. */
export interface ListSpec<T> {
  /** Create the row element for a new entity. Receives the entity's current
   *  value and id. Keep this to structural shell creation; let `update` fill
   *  reactive content (it runs once at mount and on every later change). */
  mount: (item: T, id: string) => HTMLElement;
  /** Update a row when its entity changes. Runs immediately at mount and again
   *  on every per-entity change (the content tier). Omit for immutable rows
   *  whose `mount` renders everything. */
  update?: (el: HTMLElement, item: T, id: string) => void;
  /** Optional cleanup when a row leaves the list (fires before the element is
   *  removed from the DOM). */
  onRemove?: (el: HTMLElement, id: string) => void;
}

/** Bind a list source to a parent node with two-tier reactivity. Returns a
 *  dispose function that tears down the structural effect and every row
 *  effect. */
export function bindList<T>(
  parent: ParentNode,
  source: ListSource<T>,
  spec: ListSpec<T>,
): () => void {
  const rowDisposers = new Map<string, () => void>();

  const disposeStructural = effect(() => {
    const ids = source.ids.value; // structure tier: re-runs on add/remove/reorder only
    reconcile<string>(parent, ids, {
      key: (id) => id,
      mount: (id) => {
        const sig = source.signalFor(id);
        const el = spec.mount((sig === undefined ? undefined : sig.peek()) as T, id);
        if (spec.update !== undefined) {
          const update = spec.update;
          // content tier: isolated per-row effect; runs now (fills content)
          // and on every later change to THIS entity.
          rowDisposers.set(
            id,
            effect(() => {
              const cur = source.signalFor(id);
              if (cur !== undefined) {
                update(el, cur.value, id);
              }
            }),
          );
        }
        return el;
      },
      // No structural `update`: content is owned entirely by the per-row effect.
      onRemove: (el, id) => {
        rowDisposers.get(id)?.();
        rowDisposers.delete(id);
        spec.onRemove?.(el, id);
      },
    });
  });

  return () => {
    disposeStructural();
    for (const dispose of rowDisposers.values()) {
      dispose();
    }
    rowDisposers.clear();
  };
}
