// Structural tree-diff: patch / reconcileChildren / trackHandler.
import { describe, it, expect, vi } from "vitest";
import { patch, reconcileChildren, trackHandler } from "./index.js";

describe("patch", () => {
  it("patches text content", () => {
    expect.assertions(1);
    const parent = document.createElement("div");
    parent.appendChild(document.createTextNode("old"));
    patch(parent, "new");
    expect(parent.textContent).toBe("new");
  });

  it("patches attributes", () => {
    expect.assertions(2);
    const parent = document.createElement("div");
    const child = document.createElement("span");
    child.setAttribute("class", "a");
    parent.appendChild(child);
    const newChild = document.createElement("span");
    newChild.setAttribute("class", "b");
    patch(parent, newChild);
    expect(parent.children[0]!.getAttribute("class")).toBe("b");
    expect(parent.children.length).toBe(1);
  });

  it("adds and removes children", () => {
    expect.assertions(2);
    const parent = document.createElement("div");
    patch(parent, document.createElement("p"), document.createElement("p"));
    expect(parent.children.length).toBe(2);
    patch(parent, document.createElement("p"));
    expect(parent.children.length).toBe(1);
  });

  it("keys nodes by data-col (reuses matched nodes across re-patch)", () => {
    expect.assertions(3);
    const parent = document.createElement("tr");
    const title = document.createElement("td");
    title.setAttribute("data-col", "title");
    title.textContent = "T";
    const actions = document.createElement("td");
    actions.setAttribute("data-col", "actions");
    actions.textContent = "A";
    parent.append(title, actions);

    const nTitle = document.createElement("td");
    nTitle.setAttribute("data-col", "title");
    nTitle.textContent = "T2";
    const nActions = document.createElement("td");
    nActions.setAttribute("data-col", "actions");
    nActions.textContent = "A2";
    patch(parent, nTitle, nActions);

    // Matched by data-col → original nodes reused, content patched in place.
    expect(parent.children[0]).toBe(title);
    expect(parent.children[1]).toBe(actions);
    expect(title.textContent).toBe("T2");
  });
});

describe("patchAttrs handler reconciliation", () => {
  it("removes stale handlers on patch", () => {
    expect.assertions(1);
    const parent = document.createElement("div");
    const oldEl = document.createElement("button");
    const handler = vi.fn();
    (oldEl as unknown as Record<string, unknown>)["onclick"] = handler;
    trackHandler(oldEl, "onclick");
    parent.appendChild(oldEl);

    const newEl = document.createElement("button");
    // no handler registered on newEl
    patch(parent, newEl);

    expect((parent.children[0] as unknown as Record<string, unknown>)["onclick"]).toBeNull();
  });

  it("copies new handlers on patch", () => {
    expect.assertions(1);
    const parent = document.createElement("div");
    const oldEl = document.createElement("button");
    parent.appendChild(oldEl);

    const newEl = document.createElement("button");
    const handler = vi.fn();
    (newEl as unknown as Record<string, unknown>)["onmouseover"] = handler;
    trackHandler(newEl, "onmouseover");

    patch(parent, newEl);

    expect((parent.children[0] as unknown as Record<string, unknown>)["onmouseover"]).toBe(handler);
  });

  it("updates handler reference on patch", () => {
    expect.assertions(2);
    const parent = document.createElement("div");
    const oldEl = document.createElement("button");
    const oldHandler = vi.fn();
    (oldEl as unknown as Record<string, unknown>)["onclick"] = oldHandler;
    trackHandler(oldEl, "onclick");
    parent.appendChild(oldEl);

    const newEl = document.createElement("button");
    const newHandler = vi.fn();
    (newEl as unknown as Record<string, unknown>)["onclick"] = newHandler;
    trackHandler(newEl, "onclick");

    patch(parent, newEl);

    const result = (parent.children[0] as unknown as Record<string, unknown>)["onclick"];
    expect(result).toBe(newHandler);
    expect(result).not.toBe(oldHandler);
  });
});

describe("patch / reconcileChildren: edge cases", () => {
  it("null/undefined children in patch are skipped", () => {
    const parent = document.createElement("div");
    patch(parent, null, undefined, "hello", null);
    expect(parent.textContent).toBe("hello");
    expect(parent.childNodes.length).toBe(1);
  });

  it("text vs element swap", () => {
    const parent = document.createElement("div");
    parent.appendChild(document.createTextNode("old text"));
    const newEl = document.createElement("span");
    newEl.textContent = "new element";
    patch(parent, newEl);
    expect(parent.children.length).toBe(1);
    expect(parent.children[0]!.tagName).toBe("SPAN");
  });

  it("element vs text swap", () => {
    const parent = document.createElement("div");
    parent.appendChild(document.createElement("span"));
    patch(parent, "just text");
    expect(parent.childNodes.length).toBe(1);
    expect(parent.childNodes[0]!.nodeType).toBe(3); // text node
    expect(parent.textContent).toBe("just text");
  });

  it("keyed reorder preserves identity", () => {
    const parent = document.createElement("div");
    const a = document.createElement("div");
    a.setAttribute("data-id", "a");
    a.textContent = "A";
    const b = document.createElement("div");
    b.setAttribute("data-id", "b");
    b.textContent = "B";
    const c = document.createElement("div");
    c.setAttribute("data-id", "c");
    c.textContent = "C";
    parent.appendChild(a);
    parent.appendChild(b);
    parent.appendChild(c);

    // Reorder: c, a, b
    const newC = document.createElement("div");
    newC.setAttribute("data-id", "c");
    newC.textContent = "C!";
    const newA = document.createElement("div");
    newA.setAttribute("data-id", "a");
    newA.textContent = "A!";
    const newB = document.createElement("div");
    newB.setAttribute("data-id", "b");
    newB.textContent = "B!";
    reconcileChildren(parent, [newC, newA, newB]);

    // Identity preserved
    expect(parent.childNodes[0]).toBe(c);
    expect(parent.childNodes[1]).toBe(a);
    expect(parent.childNodes[2]).toBe(b);
    // Content patched
    expect(c.textContent).toBe("C!");
    expect(a.textContent).toBe("A!");
    expect(b.textContent).toBe("B!");
  });

  it("DocumentFragment children are flattened in patch", () => {
    const parent = document.createElement("div");
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode("one"));
    frag.appendChild(document.createTextNode("two"));
    patch(parent, frag);
    expect(parent.childNodes.length).toBe(2);
    expect(parent.textContent).toBe("onetwo");
  });
});

describe("patch / reconcileChildren: clearing and text updates", () => {
  it("patch with only null/undefined children clears existing content", () => {
    const parent = document.createElement("div");
    parent.textContent = "hello";
    patch(parent, null, undefined);
    expect(parent.childNodes.length).toBe(0);
  });

  it("reconcileChildren updates a text node in place", () => {
    const parent = document.createElement("div");
    parent.appendChild(document.createTextNode("old"));
    reconcileChildren(parent, [document.createTextNode("new")]);
    expect(parent.textContent).toBe("new");
  });
});
