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
