// el.ts — CSP-safe DOM element factory. The build half of the DOM layer; pairs
// with reconcile/patch (the commit half). `on*` handlers are assigned as
// properties AND registered via trackHandler, so patch() reconciles them across
// re-renders. No innerHTML, no string templating — safe under a strict CSP.

import { trackHandler } from "./reconcile-tree.js";

/** A value for an element attribute/property/handler. Functions are treated as
 *  event handlers when the key starts with `on`. */
export type AttrValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ((...args: never[]) => unknown);

// Keys set as DOM *properties* (not attributes) because the attribute form
// either doesn't reflect (value/checked) or is awkward (boolean presence).
const BOOL_PROPS = new Set([
  "hidden",
  "disabled",
  "checked",
  "selected",
  "multiple",
  "readOnly",
  "required",
  "open",
  "default",
]);
const VALUE_PROPS = new Set(["value", "colSpan", "rowSpan", "tabIndex", "htmlFor"]);

/** Create an element: `el("button", { className: "x", onclick: fn }, "Label")`.
 *  - `className` → the class property
 *  - `on*` → handler property + `trackHandler` (reconciled by patch)
 *  - boolean DOM props (hidden/disabled/checked/selected/…) → property
 *  - value/colSpan/rowSpan/tabIndex/htmlFor → property
 *  - everything else → `setAttribute` (incl. `data-*`, `aria-*`, `style`, `id`)
 *  Null/undefined attrs and children are skipped. String children become text
 *  nodes (never parsed as HTML). */
export function el(
  tag: string,
  attrs?: Record<string, AttrValue> | null,
  ...children: (string | Node | null | undefined)[]
): HTMLElement {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) {
        continue;
      }
      if (k === "className") {
        e.className = v as string;
      } else if (k.startsWith("on")) {
        (e as unknown as Record<string, unknown>)[k] = v;
        trackHandler(e, k);
      } else if (BOOL_PROPS.has(k)) {
        (e as unknown as Record<string, unknown>)[k] = v;
      } else if (VALUE_PROPS.has(k)) {
        (e as unknown as Record<string, unknown>)[k] = v;
      } else {
        e.setAttribute(k, String(v));
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) {
      continue;
    }
    e.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return e;
}
