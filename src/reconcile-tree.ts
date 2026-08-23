// Structural tree-diff: reconcile a parent's children against new nodes.
// Handles attribute patching, text node updates, element reordering,
// and recursive child reconciliation.
//
// Correspondence between a child the parent HAS and a child the caller ASKED
// for is decided in one order, strongest notion of "the same child" first:
//
//   1. the same NODE   — the caller handed back a node already in this parent
//   2. the same KEY    — a specific `*-id` attribute wins over the generic
//                        `data-col`; siblings sharing a key queue in document
//                        order, so they pair first-with-first
//   3. the same POSITION — the next unclaimed unkeyed child
//
// Position is last because it is the only one that is not really identity. It
// is the fallback for a caller that supplies no keys, and every child is
// claimed at most once so the three tiers cannot disagree about a node.

const handlerKeysMap = new WeakMap<HTMLElement, Set<string>>();

/** Register an on* handler property key for reconciliation tracking. */
export function trackHandler(el: HTMLElement, key: string): void {
  let keys = handlerKeysMap.get(el);
  if (!keys) {
    keys = new Set();
    handlerKeysMap.set(el, keys);
  }
  keys.add(key);
}

/** Replace a parent's children with the given nodes/strings, reconciling against existing DOM.
 *
 * Strings become text nodes, a `DocumentFragment` contributes its children,
 * and `null`/`undefined` are skipped. Afterwards `parent`'s children are
 * exactly what was passed, in order, with existing children reused wherever
 * one corresponds to a requested child — so focus, selection, scroll position
 * and live input state survive a re-render.
 *
 * Two things a caller has to know:
 *
 * - **A node that is already a child of `parent` is placed at the index it was
 *   passed at, unmodified.** Handing a parent its own children reordered is a
 *   supported operation (a drag-and-drop, a sort).
 * - **Any other node is a TEMPLATE.** Its tag, attributes and content may be
 *   copied into a reused child and the node itself never inserted, so a
 *   reference to a freshly built node is not a reference to something in the
 *   DOM. This is what reuse costs, and it is why the point above is worth
 *   stating separately.
 */
export function patch(
  parent: Node,
  ...children: (string | Node | DocumentFragment | null | undefined)[]
): void {
  const newChildren: Node[] = [];
  for (const child of children) {
    if (child == null) {
      continue;
    }
    if (typeof child === "string") {
      newChildren.push(document.createTextNode(child));
    } else if (child.nodeType === 11) {
      newChildren.push(...Array.from(child.childNodes));
    } else {
      newChildren.push(child);
    }
  }
  reconcileChildren(parent, newChildren);
}

/** Reconcile a parent node's children against a new set of child nodes, patching in place.
 *
 * @internal Not on the package's `exports` map. `patch(parent, ...nodes)` is
 * the same call for a `Node[]`, with string, fragment and nullish handling on
 * top.
 */
export function reconcileChildren(parent: Node, newChildren: Node[]): void {
  // A node the caller NAMED is reserved for itself. This is the one fact that
  // keeps the three tiers disjoint: a node already in this parent is seated as
  // itself (tier 1), so tiers 2 and 3 must never hand it to a different child.
  // Without the reservation a node can be claimed twice, and the second claim
  // either removes it as a tag mismatch or patches another child's content into
  // it — which also means reading out of a live sibling this loop has already
  // mutated.
  const named = new Set<Node>(newChildren);

  // Partition the current children ONCE, before any mutation, by the tier
  // allowed to claim them: a keyed child only ever through its key's FIFO queue,
  // an unkeyed one only ever through the positional cursor. Nothing is in both,
  // so tiers 2 and 3 cannot collide, and neither can yield a node twice — a
  // queue consumes by shift, the cursor only moves forward.
  const byKey = new Map<string, Node[]>();
  const positional: Node[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    const key = nodeKey(node);
    if (key) {
      const queue = byKey.get(key);
      if (queue === undefined) {
        byKey.set(key, [node]);
      } else {
        queue.push(node);
      }
    } else {
      positional.push(node);
    }
  }

  // The node currently at the index being resolved. Every branch below seats the
  // resolved child at exactly that index, so the children before it are final
  // and the next reference node is the seated child's next sibling — O(1), where
  // a childNodes.item(i) lookup per step is not. That invariant is also what
  // makes the sweep at the end of the loop exact.
  let ref: Node | null = parent.firstChild;
  let cursor = 0;

  for (const newChild of newChildren) {
    // Tier 1 — the same NODE. A child the caller handed back needs no lookup and
    // no reconciliation: it already IS the requested child, so it falls straight
    // through to being seated as itself below. Short-circuiting the other two
    // tiers is what stops a sibling being claimed as its host — with duplicate
    // keys, the key queue would otherwise skip the reserved node, reach the next
    // one, find it patchable on the shared tag, and let the sweep delete the node
    // the caller actually named.
    let matched: Node | null = null;
    if (newChild.parentNode !== parent) {
      const key = nodeKey(newChild);
      if (key) {
        // Tier 2 — the same KEY.
        const queue = byKey.get(key);
        while (queue !== undefined && queue.length > 0) {
          const candidate = queue.shift();
          if (candidate !== undefined && !named.has(candidate)) {
            matched = candidate;
            break;
          }
        }
      } else {
        // Tier 3 — the same POSITION.
        while (cursor < positional.length) {
          const candidate = positional[cursor++];
          if (candidate !== undefined && !named.has(candidate)) {
            matched = candidate;
            break;
          }
        }
      }
    }

    if (matched !== null && canPatch(matched, newChild)) {
      // An existing child hosts this one: seat it, then patch it to match. The
      // requested node is a template and is not inserted.
      //
      // Re-inserting a node that is already in place still detaches and
      // reattaches it, which blurs a focused input and drops a text selection
      // inside it, so move only when the position actually differs.
      if (ref !== matched) {
        parent.insertBefore(matched, ref);
      }
      if (matched.nodeType === 3) {
        if (matched.textContent !== newChild.textContent) {
          matched.textContent = newChild.textContent;
        }
      } else if (matched.nodeType === 1) {
        patchAttrs(matched as HTMLElement, newChild as HTMLElement);
        reconcileChildren(matched, Array.from(newChild.childNodes));
      }
      ref = matched.nextSibling;
    } else {
      // Nothing to reconcile: either the caller handed back a node this parent
      // already has, or nothing corresponds to it, or the tags disagree. Either
      // way the requested node itself is seated here. A child that was matched
      // but not patchable is NOT removed at this point — it now sits at or after
      // `ref`, was consumed so no later index can claim it, and the sweep below
      // takes it. One removal path, not two.
      if (ref !== newChild) {
        parent.insertBefore(newChild, ref);
      }
      ref = newChild.nextSibling;
    }
  }

  // Everything from `ref` on is a child the caller did not ask for. The
  // invariant above makes that exact where comparing counts cannot be: pass one
  // node twice and the requested count exceeds what a tree can hold, leaving a
  // stale sibling behind.
  while (ref !== null) {
    const next = ref.nextSibling;
    parent.removeChild(ref);
    ref = next;
  }
}

function canPatch(oldNode: Node, newNode: Node): boolean {
  if (oldNode.nodeType !== newNode.nodeType) {
    return false;
  }
  if (oldNode.nodeType === 3) {
    return true;
  }
  if (oldNode.nodeType !== 1) {
    return false;
  }
  return oldNode.nodeName === newNode.nodeName;
}

function nodeKey(node: Node): string {
  if (node.nodeType !== 1) {
    return "";
  }
  // A specific entity id (`*-id`, e.g. data-cov-id / data-act-id) takes
  // precedence over the generic column key (`data-col`), so an element
  // carrying both keys by its entity identity — a generic first-in-attribute-
  // order `data-col` must not shadow it.
  //
  // The `data-col` scan is last-wins. The DOM keys attributes by (namespace,
  // localName), so `setAttributeNS` with a foreign namespace and no prefix can
  // put a second attribute whose `.name` is also "data-col" on the element;
  // first-wins would key the node off the foreign one and refuse to match the
  // author's own, destroying and recreating the node instead of reusing it.
  let colKey = "";
  for (const attr of (node as Element).attributes) {
    if (attr.name.endsWith("-id")) {
      return `${attr.name}=${attr.value}`;
    }
    if (attr.name === "data-col") {
      colKey = `${attr.name}=${attr.value}`;
    }
  }
  return colKey;
}

function patchAttrs(oldEl: HTMLElement, newEl: HTMLElement): void {
  for (const attr of newEl.attributes) {
    if (oldEl.getAttribute(attr.name) !== attr.value) {
      oldEl.setAttribute(attr.name, attr.value);
    }
  }
  for (const attr of Array.from(oldEl.attributes)) {
    if (!newEl.hasAttribute(attr.name)) {
      oldEl.removeAttribute(attr.name);
    }
  }

  // Unreflected live state. `checked` (input), `selected` (option) and the
  // `value` of an input/textarea are dirty-flag IDL properties: their content
  // attributes are the DEFAULTS (`defaultChecked` / `defaultSelected` /
  // `defaultValue`), so the two loops above equalise the default and never the
  // live value. Without this, a keyed re-patch could not turn a checkbox off,
  // move a selection, or replace the text in a field, ever.
  //
  // Syncing `value` overwrites whatever a user has typed, and it moves the caret
  // to the end. That is correct only where a re-render cannot land mid-keystroke,
  // which is a property of the CONSUMER, not of this function: a form re-rendered
  // by a click (open, save, reset) is safe, one re-rendered by a timer or a server
  // push is not. The README records the obligation; a consumer in the second shape
  // must drive the field from an effect instead of re-rendering over it.
  //
  // Not covered here: `value` on an <option>/<progress>/<li> DOES reflect, so the
  // loops above already carry it. A <select>'s value is derived from its options,
  // which the OPTION branch below reconciles. `indeterminate` is unreflected too,
  // but el() cannot set it, so it is outside patch()'s reach.
  //
  // canPatch has already established that both nodes share a nodeName, so one
  // side decides the branch.
  //
  // Each `!==` guard is deliberate: assigning the same string to `.value` is a
  // no-op through the DOM, but in a real browser it sets the dirty flag and moves
  // the caret to the end, so an unconditional write would jump the caret on every
  // re-render even when nothing changed. happy-dom 20.11.6 models the dirty-value,
  // dirty-checkedness and dirtiness flags, so "the re-patch did not write" is
  // observable as "the element still follows its content attribute" — all four
  // guards are pinned behaviourally, with no spy and no caret.
  if (oldEl.nodeName === "INPUT") {
    const oldInput = oldEl as HTMLInputElement;
    const newInput = newEl as HTMLInputElement;
    if (oldInput.checked !== newInput.checked) {
      oldInput.checked = newInput.checked;
    }
    if (oldInput.value !== newInput.value) {
      oldInput.value = newInput.value;
    }
  } else if (oldEl.nodeName === "TEXTAREA") {
    const oldArea = oldEl as HTMLTextAreaElement;
    const newArea = newEl as HTMLTextAreaElement;
    if (oldArea.value !== newArea.value) {
      oldArea.value = newArea.value;
    }
  } else if (oldEl.nodeName === "OPTION") {
    const oldOption = oldEl as HTMLOptionElement;
    const newOption = newEl as HTMLOptionElement;
    if (oldOption.selected !== newOption.selected) {
      oldOption.selected = newOption.selected;
    }
  }

  // Reconcile on* event handler properties (not reflected as attributes).
  const newKeys = handlerKeysMap.get(newEl);
  const oldKeys = handlerKeysMap.get(oldEl);
  if (oldKeys) {
    for (const key of oldKeys) {
      if (!newKeys?.has(key)) {
        (oldEl as unknown as Record<string, unknown>)[key] = null;
      }
    }
  }
  if (newKeys) {
    const oldRec = oldEl as unknown as Record<string, unknown>;
    const newRec = newEl as unknown as Record<string, unknown>;
    for (const key of newKeys) {
      oldRec[key] = newRec[key];
    }
    handlerKeysMap.set(oldEl, new Set(newKeys));
  } else if (oldKeys) {
    handlerKeysMap.delete(oldEl);
  }
}
