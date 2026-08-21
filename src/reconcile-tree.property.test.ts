// reconcile-tree.property.test.ts -- model-based coverage for reconcileChildren.
// The example suites pin specific keyed/unkeyed shapes; this property generalizes
// over randomized old/new child lists so a regression in the positional skip-loop,
// keyed reuse, or the tag-mismatch (!canPatch) replacement path is caught too.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { reconcileChildren } from "./index.js";

interface ChildSpec {
  tag: string;
  key: string | null;
  text: string;
}

// Leaf children with UNIQUE keys (keyed ones get k0, k1, ... in order), so old and
// new lists overlap on keys without duplicate-key ambiguity; mixed tags let the
// tag-mismatch branch trigger.
const listArb = fc
  .array(
    fc.record({
      tag: fc.constantFrom("div", "span", "p"),
      text: fc.string({ maxLength: 2 }),
      keyed: fc.boolean(),
    }),
    { maxLength: 5 },
  )
  .map((specs): ChildSpec[] => {
    let n = 0;
    return specs.map((s) => ({
      tag: s.tag,
      text: s.text,
      key: s.keyed ? `k${n++}` : null,
    }));
  });

function toNode(s: ChildSpec): HTMLElement {
  const e = document.createElement(s.tag);
  if (s.key !== null) {
    e.setAttribute("data-id", s.key);
  }
  e.textContent = s.text;
  return e;
}

describe("reconcileChildren: model-based property (leaf children)", () => {
  it("the reconciled DOM equals the target list by tag, key, and text in order", () => {
    fc.assert(
      fc.property(fc.tuple(listArb, listArb), ([oldSpecs, newSpecs]) => {
        const parent = document.createElement("div");
        parent.append(...oldSpecs.map(toNode));

        reconcileChildren(parent, newSpecs.map(toNode));

        expect(parent.children.length).toBe(newSpecs.length);
        newSpecs.forEach((s, i) => {
          const child = parent.children[i]!;
          expect(child.tagName).toBe(s.tag.toUpperCase());
          expect(child.getAttribute("data-id")).toBe(s.key);
          expect(child.textContent).toBe(s.text);
        });
      }),
    );
  });
});

// Second and third properties use an EXTERNAL oracle rather than a positional
// walk of the target specs: reconciling an arbitrary old list into an arbitrary
// new one must leave exactly the DOM that building the new list from scratch
// produces, and every key present in BOTH lists must still be backed by its
// original node. Attributes are part of the model, so the oracle also covers
// attribute sync in every direction (added, changed, no longer present).

// The wide model: element, text and comment children mixed freely, keys drawn
// from a small pool so duplicate-key siblings occur, mixed tags so the
// tag-mismatch replacement path triggers, and an optional attribute so a node
// reused by key must shed what the replacement dropped. This is the
// combinatorial space the example suites cannot enumerate by hand.
type MixedSpec =
  | { kind: "el"; tag: string; key: string | null; cls: string; title: string | null; text: string }
  | { kind: "text"; text: string }
  | { kind: "comment"; text: string };

const mixedListArb = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant("el" as const),
      tag: fc.constantFrom("div", "span", "p"),
      key: fc.option(fc.constantFrom("k0", "k1", "k2"), { nil: null }),
      cls: fc.constantFrom("alpha", "beta"),
      title: fc.option(fc.constantFrom("t1", "t2"), { nil: null }),
      text: fc.string({ maxLength: 2 }),
    }),
    fc.record({ kind: fc.constant("text" as const), text: fc.string({ maxLength: 2 }) }),
    fc.record({ kind: fc.constant("comment" as const), text: fc.string({ maxLength: 2 }) }),
  ),
  { maxLength: 8 },
);

function toMixedNode(s: MixedSpec): Node {
  if (s.kind === "text") {
    return document.createTextNode(s.text);
  }
  if (s.kind === "comment") {
    return document.createComment(s.text);
  }
  const e = document.createElement(s.tag);
  if (s.key !== null) {
    e.setAttribute("data-id", s.key);
  }
  e.setAttribute("class", s.cls);
  if (s.title !== null) {
    e.setAttribute("title", s.title);
  }
  e.textContent = s.text;
  return e;
}

interface NodeShape {
  type: number;
  name: string;
  attrs: string[];
  text: string | null;
}

// Attribute PAIRS, sorted: a node reused by key keeps its original attribute
// order while a fresh one appends in spec order, and that ordering is not part
// of the contract — the attribute set is.
function nodeShapes(parent: Node): NodeShape[] {
  return Array.from(parent.childNodes).map((c) => ({
    type: c.nodeType,
    name: c.nodeName,
    attrs:
      c.nodeType === 1
        ? Array.from((c as Element).attributes)
            .map((a) => `${a.name}=${a.value}`)
            .sort()
        : [],
    text: c.textContent,
  }));
}

interface AttrSpec {
  key: string | null;
  cls: string;
  text: string;
}

// The identity model is narrower on purpose: every child is a <div> and keys are
// UNIQUE (k0, k1, … in order), so a key present in both lists is always
// patchable and identity preservation is unconditional.
const attrListArb = fc
  .array(
    fc.record({
      keyed: fc.boolean(),
      cls: fc.constantFrom("alpha", "beta"),
      text: fc.string({ maxLength: 2 }),
    }),
    { maxLength: 5 },
  )
  .map((specs): AttrSpec[] => {
    let n = 0;
    return specs.map((s) => ({
      key: s.keyed ? `k${n++}` : null,
      cls: s.cls,
      text: s.text,
    }));
  });

function toAttrNode(s: AttrSpec): HTMLElement {
  const e = document.createElement("div");
  if (s.key !== null) {
    e.setAttribute("data-id", s.key);
  }
  e.setAttribute("class", s.cls);
  e.textContent = s.text;
  return e;
}

describe("reconcileChildren: property — equivalence with a from-scratch build", () => {
  it("leaves the same DOM as building the new list from scratch", () => {
    fc.assert(
      fc.property(fc.tuple(mixedListArb, mixedListArb), ([oldSpecs, newSpecs]) => {
        const parent = document.createElement("div");
        parent.append(...oldSpecs.map(toMixedNode));

        reconcileChildren(parent, newSpecs.map(toMixedNode));

        const fresh = document.createElement("div");
        fresh.append(...newSpecs.map(toMixedNode));
        expect(nodeShapes(parent)).toEqual(nodeShapes(fresh));
      }),
    );
  });

  it("preserves the original node for every key present in both lists", () => {
    fc.assert(
      fc.property(fc.tuple(attrListArb, attrListArb), ([oldSpecs, newSpecs]) => {
        const parent = document.createElement("div");
        const oldNodes = oldSpecs.map(toAttrNode);
        parent.append(...oldNodes);
        const oldByKey = new Map<string, HTMLElement>();
        oldSpecs.forEach((s, i) => {
          if (s.key !== null) {
            oldByKey.set(s.key, oldNodes[i]!);
          }
        });

        reconcileChildren(parent, newSpecs.map(toAttrNode));

        const carried = newSpecs
          .map((s, i) => ({ key: s.key, node: parent.children[i] }))
          .filter((r) => r.key !== null && oldByKey.has(r.key));
        expect(carried.map((r) => r.node)).toEqual(carried.map((r) => oldByKey.get(r.key!)));
      }),
    );
  });
});
