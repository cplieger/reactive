// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";

import { el } from "./el.js";
import { patch } from "./reconcile-tree.js";

describe("el", () => {
  it("sets className, attributes, and string/Node children", () => {
    expect.assertions(5);
    const child = el("span", null, "inner");
    const e = el("div", { className: "card", id: "x", "data-role": "row" }, "text ", child);
    expect(e.tagName).toBe("DIV");
    expect(e.className).toBe("card");
    expect(e.id).toBe("x");
    expect(e.getAttribute("data-role")).toBe("row");
    expect(e.textContent).toBe("text inner");
  });

  it("sets boolean DOM props as properties, not string attributes", () => {
    expect.assertions(3);
    const btn = el("button", { disabled: true, hidden: true }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.hidden).toBe(true);
    const opt = el("option", { selected: true }) as HTMLOptionElement;
    expect(opt.selected).toBe(true);
  });

  it("wires on* handlers as properties and they fire", () => {
    expect.assertions(2);
    let clicks = 0;
    const btn = el("button", {
      onclick: () => {
        clicks++;
      },
    }) as HTMLButtonElement;
    expect(typeof btn.onclick).toBe("function");
    btn.click();
    expect(clicks).toBe(1);
  });

  it("a handler set via el() is reconciled by patch (trackHandler integration)", () => {
    expect.assertions(1);
    const parent = document.createElement("div");
    let fired = 0;
    const a = el("button", {
      "data-col": "k",
      onclick: () => {
        fired++;
      },
    });
    patch(parent, a);
    // re-patch with a NEW element (same key) carrying no handler → patch must
    // null the stale handler on the reused node.
    const b = el("button", { "data-col": "k" });
    patch(parent, b);
    parent.querySelector<HTMLButtonElement>("button")?.click();
    expect(fired).toBe(0);
  });

  it("skips null/undefined attrs and children", () => {
    expect.assertions(3);
    const e = el(
      "div",
      { className: "x", title: null, "data-y": undefined },
      null,
      "kept",
      undefined,
    );
    expect(e.hasAttribute("title")).toBe(false);
    expect(e.hasAttribute("data-y")).toBe(false);
    expect(e.textContent).toBe("kept");
  });

  it("value/colSpan are set as properties", () => {
    expect.assertions(2);
    const input = el("input", { value: "hello" }) as HTMLInputElement;
    expect(input.value).toBe("hello");
    const td = el("td", { colSpan: 3 }) as HTMLTableCellElement;
    expect(td.colSpan).toBe(3);
  });
});
