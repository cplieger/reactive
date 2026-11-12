// Identity-first matching: a node the caller hands back is its own match.
//
// The measured fault these pin is not "a child goes missing" — the overlap
// family also produces a WRONG TREE with the right number of children. When two
// same-tag siblings are handed back swapped, positional matching patches each
// requested node's content into whichever node happens to sit at that index, so
// index 1 reads its content out of the live sibling index 0 already mutated:
// [div(A), div(B)] -> [b, a] left DIV[B] DIV[B], and three children reversed
// left DIV[C] DIV[B] DIV[C].
//
// The oracle throughout is the from-scratch render: whatever `patch` leaves must
// be what building the same list into an empty parent leaves. It is the
// strongest oracle available for a reconciler, because it IS the contract —
// "make this parent's children be exactly these" — rather than a restatement of
// the algorithm. The generalized form lives in reconcile-tree.property.test.ts.
import { describe, it, expect } from "vitest";
import { patch, reconcileChildren } from "./reconcile-tree.js";

function div(text: string): HTMLElement {
  const d = document.createElement("div");
  d.textContent = text;
  return d;
}

/** Structure of a parent's children: node type, name, sorted attributes, text.
 *  Node identity is deliberately absent — reuse means a reconciled tree and a
 *  from-scratch one hold different objects, and only their shape must agree. */
function shape(parent: Node): string[] {
  return Array.from(parent.childNodes).map((c) => {
    const attrs =
      c.nodeType === 1
        ? Array.from((c as Element).attributes)
            .map((a) => `${a.name}=${a.value}`)
            .sort()
            .join(",")
        : "";
    return `${String(c.nodeType)}:${c.nodeName}[${attrs}]${c.textContent ?? ""}`;
  });
}

describe("reconcileChildren: a node the caller hands back is its own match", () => {
  it("swapping two same-tag children leaves each node's own content, in the order asked for", () => {
    const parent = document.createElement("div");
    const a = div("A");
    const b = div("B");
    parent.append(a, b);

    reconcileChildren(parent, [b, a]);

    // The wrong tree this replaces was DIV[B] DIV[B]: `a` was patched from `b`,
    // then `b` was patched from the already-overwritten `a`.
    expect(shape(parent)).toEqual(["1:DIV[]B", "1:DIV[]A"]);
    // And by identity, not just by shape: both nodes moved, neither was a host.
    expect(parent.childNodes[0]).toBe(b);
    expect(parent.childNodes[1]).toBe(a);
  });

  it("matches the from-scratch render for a same-tag swap", () => {
    const parent = document.createElement("div");
    const a = div("A");
    const b = div("B");
    parent.append(a, b);
    reconcileChildren(parent, [b, a]);

    const fresh = document.createElement("div");
    fresh.append(div("B"), div("A"));

    expect(shape(parent)).toEqual(shape(fresh));
  });

  it("reverses three same-tag children without reading out of a mutated sibling", () => {
    const parent = document.createElement("div");
    const a = div("A");
    const b = div("B");
    const c = div("C");
    parent.append(a, b, c);

    reconcileChildren(parent, [c, b, a]);

    // Was DIV[C] DIV[B] DIV[C]: index 2 read index 0's content after index 0
    // had been overwritten from `c`.
    expect(shape(parent)).toEqual(["1:DIV[]C", "1:DIV[]B", "1:DIV[]A"]);
    expect(Array.from(parent.childNodes)).toEqual([c, b, a]);
  });

  it("reverses through the public patch() too", () => {
    const parent = document.createElement("div");
    const a = div("A");
    const b = div("B");
    parent.append(a, b);

    patch(parent, b, a);

    expect(shape(parent)).toEqual(["1:DIV[]B", "1:DIV[]A"]);
  });

  it("keeps a handed-back node's attributes rather than equalising them against a sibling", () => {
    const parent = document.createElement("div");
    const first = document.createElement("div");
    first.setAttribute("class", "alpha");
    first.setAttribute("title", "t1");
    const second = document.createElement("div");
    second.setAttribute("class", "beta");
    parent.append(first, second);

    reconcileChildren(parent, [second, first]);

    expect(shape(parent)).toEqual(["1:DIV[class=beta]", "1:DIV[class=alpha,title=t1]"]);
  });

  it("does not descend into a handed-back node's subtree", () => {
    // A node that is already the target needs no reconciliation at any depth.
    // Observable through a MutationObserver: reusing the node as a host would
    // rewrite its text, moving it must not.
    const parent = document.createElement("div");
    const a = document.createElement("div");
    a.append(div("deep-A"));
    const b = document.createElement("div");
    b.append(div("deep-B"));
    parent.append(a, b);

    const seen: MutationRecord[] = [];
    const obs = new MutationObserver((records) => {
      seen.push(...records);
    });
    obs.observe(parent, { subtree: true, childList: true, characterData: true, attributes: true });

    reconcileChildren(parent, [b, a]);

    const records = [...seen, ...obs.takeRecords()];
    obs.disconnect();
    // Only the two reorder moves at the top level; nothing inside either subtree.
    expect(records.every((r) => r.target === parent)).toBe(true);
    expect(a.textContent).toBe("deep-A");
    expect(b.textContent).toBe("deep-B");
  });

  it("moves a handed-back node without touching the one it displaces", () => {
    // The narrowest shape: one own child moved to the front past a fresh sibling
    // of the same tag. The fresh node is the template for the remaining old
    // child; the handed-back node is not available as a host.
    const parent = document.createElement("div");
    const own = div("OWN");
    const other = div("OTHER");
    parent.append(own, other);

    reconcileChildren(parent, [own, div("FRESH")]);

    expect(shape(parent)).toEqual(["1:DIV[]OWN", "1:DIV[]FRESH"]);
    expect(parent.childNodes[0]).toBe(own);
    // `other` was the only candidate left, so it hosted the fresh content.
    expect(parent.childNodes[1]).toBe(other);
  });

  it("reserves a keyed node for itself rather than letting a fresh node with the same key claim it", () => {
    // The caller asks for both a fresh node carrying key k1 AND the live node
    // that currently holds k1. Reserving the live node for itself means the
    // fresh one is inserted, so the caller gets both children it asked for.
    const parent = document.createElement("div");
    const live = document.createElement("div");
    live.setAttribute("data-id", "k1");
    live.textContent = "LIVE";
    parent.append(live);

    const fresh = document.createElement("div");
    fresh.setAttribute("data-id", "k1");
    fresh.textContent = "FRESH";

    reconcileChildren(parent, [fresh, live]);

    expect(parent.childNodes.length).toBe(2);
    expect(parent.childNodes[0]?.textContent).toBe("FRESH");
    expect(parent.childNodes[1]).toBe(live);
    expect(live.textContent).toBe("LIVE");
  });

  it("hands back one of two duplicate-key siblings without letting the other host it", () => {
    // The witness that tier 1 has to run BEFORE the key lookup. Both children
    // carry k1; the caller asks for the first one back. Consulting the key queue
    // first would skip the reserved node, reach the second, find it patchable on
    // the shared tag, host the request in it and let the sweep delete the very
    // node the caller named.
    const parent = document.createElement("div");
    const first = document.createElement("div");
    first.setAttribute("data-id", "k1");
    first.textContent = "FIRST";
    const second = document.createElement("div");
    second.setAttribute("data-id", "k1");
    second.textContent = "SECOND";
    parent.append(first, second);

    reconcileChildren(parent, [first]);

    expect(Array.from(parent.childNodes)).toEqual([first]);
    expect(first.textContent).toBe("FIRST");
  });

  it("hands back a comment node without removing it", () => {
    // A comment cannot be patched (canPatch covers only elements and text), so
    // a design that asked "is this patchable?" before "is this the node itself?"
    // would insert the comment and then remove the very node it just inserted.
    // Settling identity first makes the node type irrelevant.
    const parent = document.createElement("div");
    const comment = document.createComment("c");
    const d = div("D");
    parent.append(d, comment);

    reconcileChildren(parent, [comment, d]);

    expect(parent.childNodes.length).toBe(2);
    expect(parent.childNodes[0]).toBe(comment);
    expect(parent.childNodes[1]).toBe(d);
  });

  it("leaves one child, as the DOM does, when the same node is asked for twice", () => {
    // `parent.replaceChildren(a, a)` yields [a]: a tree cannot hold one node
    // twice. Removing exactly the children past the last one seated agrees with
    // that; comparing counts against the requested length does not, and left a
    // stale sibling behind.
    const parent = document.createElement("div");
    const a = div("A");
    const b = div("B");
    const c = div("C");
    parent.append(a, b, c);

    reconcileChildren(parent, [a, a]);

    expect(Array.from(parent.childNodes)).toEqual([a]);
  });
});
