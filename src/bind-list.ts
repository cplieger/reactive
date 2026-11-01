// Two-tier render binding for a reactive list source. One structural effect
// tracks `source.ids` and reconciles the id list; each row owns an effect that
// tracks only its entity signal, so an entity update repaints just that row.
// The engine saves and restores evalContext around nested effects, so a row
// effect's reads never leak into the structural effect. A `Collection<T>` is a
// `ListSource<T>`; a filtered, sorted or paginated view is a `computed` id
// list paired with the collection's `signalFor`.

import { reconcile } from "./reconcile.js";
import { createRoot, createRootUnder, effect, type Owner, type ReadonlySignal } from "./signal.js";

/** The minimal reactive surface `bindList` renders: a structure signal (the
 *  ordered ids) and a per-id content-signal lookup. `Collection<T>` satisfies
 *  this; so does `{ ids: computed(...), signalFor: collection.signalFor }`.
 *  An id with no matching signal (an inconsistent source) is skipped — no row
 *  is rendered for it until the source becomes consistent. */
export interface ListSource<T> {
  readonly ids: ReadonlySignal<readonly string[]>;
  signalFor(id: string): ReadonlySignal<T> | undefined;
}

/** Row lifecycle for `bindList`. Each row has its own owner, so effects and
 *  roots created in `mount` and `update` are disposed when the row leaves. */
export interface ListSpec<T> {
  /** Create the row element for a new entity. Receives the entity's current
   *  value, its id and the row's owner, whose `signal` aborts when the row
   *  leaves or the list is disposed. Keep this to structural shell creation;
   *  let `update` fill reactive content (it runs once at mount and on every
   *  later change). */
  mount: (item: T, id: string, owner: Owner) => HTMLElement;
  /** Update a row when its entity changes. Runs immediately at mount and again
   *  on every per-entity change (the content tier). Omit for immutable rows
   *  whose `mount` renders everything. */
  update?: (el: HTMLElement, item: T, id: string) => void;
  /** Optional cleanup when a row leaves the list, after its owner is disposed
   *  and before the element is removed from the DOM. */
  onRemove?: (el: HTMLElement, id: string) => void;
}

/** Bind a list source to a parent node with two-tier reactivity, in a root
 *  owned by the current owner when there is one. Returns a dispose function
 *  that tears down the structural effect and every row. */
export function bindList<T>(
  parent: ParentNode,
  source: ListSource<T>,
  spec: ListSpec<T>,
): () => void {
  return createRoot((dispose, listOwner) => {
    const rowDisposers = new WeakMap<HTMLElement, () => void>();

    effect(() => {
      // Structure tier: re-runs on add/remove/reorder only. An id whose entity
      // signal is missing (an inconsistent ListSource) is skipped instead of
      // mounting a row with a manufactured `undefined as T` value; it renders
      // once the source becomes consistent (the next `ids` change).
      const ids = source.ids.value.filter((id) => source.signalFor(id) !== undefined);
      reconcile<string>(parent, ids, {
        key: (id) => id,
        mount: (id) => {
          const sig = source.signalFor(id);
          if (sig === undefined) {
            // Unreachable via the structural filter above (same synchronous
            // pass); reachable only by a source whose signalFor is not stable
            // within one read — surface that loudly instead of manufacturing
            // an entity value. Routed to the effect error handler.
            throw new Error(`bindList: no entity signal for id "${id}"`);
          }
          // A row belongs to the list, not to this structural run, whose
          // scope is disposed on every add, remove or reorder.
          return createRootUnder(listOwner, (disposeRow, rowOwner) => {
            const el = spec.mount(sig.peek(), id, rowOwner);
            rowDisposers.set(el, disposeRow);
            if (spec.update !== undefined) {
              const update = spec.update;
              // content tier: isolated per-row effect; runs now (fills content)
              // and on every later change to THIS entity.
              effect(() => {
                const cur = source.signalFor(id);
                if (cur !== undefined) {
                  update(el, cur.value, id);
                }
              });
            }
            return el;
          });
        },
        // No structural `update`: content is owned entirely by the per-row effect.
        onRemove: (el, id) => {
          rowDisposers.get(el)?.();
          spec.onRemove?.(el, id);
        },
      });
    });

    return dispose;
  });
}
