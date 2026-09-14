// Keyed-list DOM reconciliation with mount/update/onRemove lifecycle.
// Identity-preserving: existing elements survive across renders.

/** Attribute name used to store reconciliation keys on elements. */
export const KEY_ATTR = "data-reconcile-key";

/** Specification for keyed-list reconciliation lifecycle callbacks. */
export interface ReconcileSpec<T> {
  key: (item: T) => string;
  mount: (item: T) => HTMLElement;
  update?: (el: HTMLElement, item: T) => void;
  onRemove?: (el: HTMLElement, key: string) => void;
}

/** Reconcile a keyed list of items into a parent node, preserving existing elements by key. */
export function reconcile<T>(
  parent: ParentNode,
  items: readonly T[],
  spec: ReconcileSpec<T>,
): void {
  const existing = new Map<string, HTMLElement>();
  for (let n = parent.firstChild; n !== null; n = n.nextSibling) {
    if (n.nodeType !== 1) {
      continue;
    }
    const el = n as HTMLElement;
    const k = el.getAttribute(KEY_ATTR);
    if (k !== null) {
      existing.set(k, el);
    }
  }

  // DEPARTING ELEMENTS GO FIRST, before anything is placed. The walk below runs
  // backwards and skips an element already sitting before the last one it placed; a
  // departing element still in the tree makes every PREDECESSOR's `nextSibling` point at
  // a node about to vanish, so the guard sees a mismatch and re-seats a row nothing
  // changed — which restarts its animations and drops `:hover` and focus. So `onRemove`
  // fires before the survivors are placed, holding its own intact element; only the
  // siblings' positions are not yet final. `key` is still called exactly once per item,
  // and the pairs carry it into the walk so neither loop indexes an array.
  const pairs: [T, string][] = [];
  const wanted = new Set<string>();
  for (const item of items) {
    const k = spec.key(item);
    pairs.push([item, k]);
    wanted.add(k);
  }
  for (const [k, el] of existing) {
    if (!wanted.has(k)) {
      spec.onRemove?.(el, k);
      el.remove();
      existing.delete(k);
    }
  }

  let target: Node | null = null;
  for (const [item, k] of pairs.reverse()) {
    let el = existing.get(k);
    if (el === undefined) {
      el = spec.mount(item);
      el.setAttribute(KEY_ATTR, k);
    } else {
      existing.delete(k);
      if (spec.update) {
        spec.update(el, item);
      }
    }
    // Skip the move when el is already at its target position: re-inserting a node
    // that is already correctly placed still detaches+reattaches it in the DOM,
    // which blurs a focused input / drops a text selection inside that row.
    if (el.parentNode !== parent || el.nextSibling !== target) {
      parent.insertBefore(el, target);
    }
    target = el;
  }
}
