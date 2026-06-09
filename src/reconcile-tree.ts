// Structural tree-diff: reconcile a parent's children against new nodes.
// Handles attribute patching, text node updates, element reordering,
// and recursive child reconciliation. Keying via data-* or *-id attrs.

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

/** Replace a parent's children with the given nodes/strings, reconciling against existing DOM. */
export function patch(
  parent: Node,
  ...children: (string | Node | DocumentFragment | null | undefined)[]
): void {
  const newChildren: Node[] = [];
  for (const child of children) {
    if (child == null) {
      continue;
    }
    if ((child as Node).nodeType === 11) {
      newChildren.push(...Array.from((child as Node).childNodes));
    } else if (typeof child === "string") {
      newChildren.push(document.createTextNode(child));
    } else {
      newChildren.push(child);
    }
  }
  reconcileChildren(parent, newChildren);
}

/** Reconcile a parent node's children against a new set of child nodes, patching in place. */
export function reconcileChildren(parent: Node, newChildren: Node[]): void {
  const oldChildren = Array.from(parent.childNodes);
  const oldByKey = new Map<string, Node>();
  for (const child of oldChildren) {
    const key = nodeKey(child);
    if (key) {
      oldByKey.set(key, child);
    }
  }

  let oldIdx = 0;
  for (let i = 0; i < newChildren.length; i++) {
    const newChild = newChildren[i];
    if (newChild === undefined) {
      continue;
    }
    const newKey = nodeKey(newChild);

    let matched = newKey ? (oldByKey.get(newKey) ?? null) : null;
    if (matched) {
      oldByKey.delete(newKey);
    } else if (!newKey) {
      while (oldIdx < oldChildren.length) {
        const oc = oldChildren[oldIdx];
        if (oc === undefined || nodeKey(oc)) {
          break;
        }
        oldIdx++;
      }
      if (oldIdx < oldChildren.length) {
        matched = oldChildren[oldIdx] ?? null;
        oldIdx++;
      }
    }

    if (!matched) {
      const ref = parent.childNodes.item(i);
      parent.insertBefore(newChild, ref);
      continue;
    }

    if (!canPatch(matched, newChild)) {
      parent.replaceChild(newChild, matched);
      continue;
    }

    const ref = parent.childNodes.item(i);
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
  }

  while (parent.childNodes.length > newChildren.length) {
    const last = parent.lastChild;
    if (last === null) {
      break;
    }
    last.remove();
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
  for (const attr of (node as Element).attributes) {
    if (attr.name === "data-col" || attr.name.endsWith("-id")) {
      return `${attr.name}=${attr.value}`;
    }
  }
  return "";
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
  if (oldEl.hidden !== newEl.hidden) {
    oldEl.hidden = newEl.hidden;
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
