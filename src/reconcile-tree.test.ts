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

describe("reconcileChildren: mixed keyed/unkeyed siblings", () => {
  function keyedDiv(id: string, text: string): HTMLDivElement {
    const d = document.createElement("div");
    d.setAttribute("data-id", id);
    d.textContent = text;
    return d;
  }
  function plainDiv(text: string): HTMLDivElement {
    const d = document.createElement("div");
    d.textContent = text;
    return d;
  }

  it("an unkeyed new node never matches (corrupts) a keyed old node", () => {
    // Old: a single keyed div. New: an unkeyed div FOLLOWED by that keyed div.
    // The unkeyed new node must be inserted as its own node while the keyed old
    // node is reused by key — not patched onto by the unkeyed node (which would
    // strip the key and drop the unkeyed node entirely).
    const parent = document.createElement("div");
    const keyed = keyedDiv("k", "K");
    parent.appendChild(keyed);

    reconcileChildren(parent, [plainDiv("X"), keyedDiv("k", "K2")]);

    expect(parent.children.length).toBe(2);
    expect(parent.children[0]!.textContent).toBe("X");
    expect(parent.children[0]!.hasAttribute("data-id")).toBe(false);
    // Keyed node reused by key (identity preserved), patched, key retained.
    expect(parent.children[1]).toBe(keyed);
    expect(parent.children[1]!.getAttribute("data-id")).toBe("k");
    expect(parent.children[1]!.textContent).toBe("K2");
  });

  it("unkeyed nodes match the next unkeyed old node by position, skipping keyed ones", () => {
    // Old: [unkeyed A, keyed K, unkeyed B]. New: [unkeyed X, keyed K, unkeyed Y].
    // X reuses A, Y reuses B (skipping the keyed node between them), K reused by
    // key — every node's identity is preserved and only content is patched.
    const parent = document.createElement("div");
    const a = plainDiv("A");
    const k = keyedDiv("k", "K");
    const b = plainDiv("B");
    parent.append(a, k, b);

    reconcileChildren(parent, [plainDiv("X"), keyedDiv("k", "K2"), plainDiv("Y")]);

    expect(parent.children.length).toBe(3);
    expect(parent.children[0]).toBe(a);
    expect(parent.children[0]!.textContent).toBe("X");
    expect(parent.children[1]).toBe(k);
    expect(parent.children[1]!.textContent).toBe("K2");
    expect(parent.children[2]).toBe(b);
    expect(parent.children[2]!.textContent).toBe("Y");
  });

  it("reuses an unkeyed node in place by position (identity preserved, content patched)", () => {
    const parent = document.createElement("div");
    const orig = plainDiv("A");
    parent.appendChild(orig);

    reconcileChildren(parent, [plainDiv("B")]);

    // Positional reuse: same node kept and content patched, not replaced.
    expect(parent.children[0]).toBe(orig);
    expect(parent.children[0]!.textContent).toBe("B");
  });
});

describe("reconcileChildren: mixed keyed/unkeyed reorder and removal", () => {
  // __mark tags each node with a stable identity label so a single hardcoded
  // snapshot asserts BOTH node reuse (identity) and the patched content.
  type Marked = Element & { __mark?: string };
  interface Row {
    tag: string;
    key: string | null;
    text: string | null;
    mark: string;
  }
  function keyedDiv(id: string, text: string, mark: string): HTMLDivElement {
    const d = document.createElement("div");
    d.setAttribute("data-id", id);
    d.textContent = text;
    (d as Marked).__mark = mark;
    return d;
  }
  function plainDiv(text: string, mark: string): HTMLDivElement {
    const d = document.createElement("div");
    d.textContent = text;
    (d as Marked).__mark = mark;
    return d;
  }
  function snapshot(parent: Element): Row[] {
    return Array.from(parent.children).map((c) => ({
      tag: c.tagName,
      key: c.getAttribute("data-id"),
      text: c.textContent,
      mark: (c as Marked).__mark ?? "FRESH",
    }));
  }

  const cases = [
    {
      name: "unkeyed positional match moves to front when a keyed sibling reorders behind it",
      build: (): HTMLDivElement[] => [keyedDiv("k", "K", "o0"), plainDiv("A", "o1")],
      next: (): HTMLDivElement[] => [plainDiv("A2", "n0"), keyedDiv("k", "K2", "n1")],
      expected: [
        { tag: "DIV", key: null, text: "A2", mark: "o1" },
        { tag: "DIV", key: "k", text: "K2", mark: "o0" },
      ],
    },
    {
      name: "skip-loop reuses first unkeyed old node, keyed reused, surplus unkeyed removed",
      build: (): HTMLDivElement[] => [
        plainDiv("A", "o0"),
        plainDiv("B", "o1"),
        keyedDiv("k", "K", "o2"),
      ],
      next: (): HTMLDivElement[] => [plainDiv("X", "n0"), keyedDiv("k", "K2", "n1")],
      expected: [
        { tag: "DIV", key: null, text: "X", mark: "o0" },
        { tag: "DIV", key: "k", text: "K2", mark: "o2" },
      ],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const parent = document.createElement("div");
      parent.append(...c.build());
      reconcileChildren(parent, c.next());
      expect(snapshot(parent)).toEqual(c.expected);
    });
  }
});

describe("reconcileChildren: recursive reconcile through a reused unkeyed subtree", () => {
  it("reorders mixed keyed/unkeyed grandchildren inside a positionally-reused unkeyed parent", () => {
    const parent = document.createElement("div");
    const wrapper = document.createElement("div");
    const childKeyed = document.createElement("div");
    childKeyed.setAttribute("data-id", "c");
    childKeyed.textContent = "C";
    const childPlain = document.createElement("div");
    childPlain.textContent = "U";
    wrapper.append(childKeyed, childPlain);
    parent.appendChild(wrapper);

    const nWrapper = document.createElement("div");
    const nPlain = document.createElement("div");
    nPlain.textContent = "U2";
    const nKeyed = document.createElement("div");
    nKeyed.setAttribute("data-id", "c");
    nKeyed.textContent = "C2";
    nWrapper.append(nPlain, nKeyed);

    reconcileChildren(parent, [nWrapper]);

    // Top-level unkeyed wrapper reused by position.
    expect(parent.children[0]).toBe(wrapper);
    // Grandchildren: unkeyed U reused and moved to front, keyed C reused; both patched.
    expect(wrapper.children[0]).toBe(childPlain);
    expect(wrapper.children[0]!.textContent).toBe("U2");
    expect(wrapper.children[0]!.hasAttribute("data-id")).toBe(false);
    expect(wrapper.children[1]).toBe(childKeyed);
    expect(wrapper.children[1]!.getAttribute("data-id")).toBe("c");
    expect(wrapper.children[1]!.textContent).toBe("C2");
  });
});

describe("reconcileChildren: !canPatch on a positionally-displaced match (cycle-3 regression)", () => {
  it("unkeyed type-mismatched new node lands at index 0 and the stale keyed node it sits behind is dropped: [div#k, span] -> [div]", () => {
    const parent = document.createElement("div");
    const keyed = document.createElement("div");
    keyed.setAttribute("data-id", "k");
    keyed.textContent = "K";
    const span = document.createElement("span");
    span.textContent = "S";
    parent.append(keyed, span);

    const fresh = document.createElement("div");
    fresh.textContent = "D";
    reconcileChildren(parent, [fresh]);

    // Pre-fix replaceChild left the new <div> at the span's DOM index (1), where the
    // trailing-removal loop then deleted it -- dropping the new node and keeping the
    // stale keyed node. The fix inserts at index 0 and removes the stale node.
    expect(parent.children.length).toBe(1);
    expect(parent.children[0]).toBe(fresh);
    expect(parent.children[0]!.tagName).toBe("DIV");
    expect(parent.children[0]!.hasAttribute("data-id")).toBe(false);
    expect(parent.children[0]!.textContent).toBe("D");
  });

  it("unkeyed mismatched replacement lands at index 0 while a following keyed node is reused at a later index: [div#k, span] -> [p, div#k]", () => {
    const parent = document.createElement("div");
    const keyedNode = document.createElement("div");
    keyedNode.setAttribute("data-id", "k");
    keyedNode.textContent = "K";
    const span = document.createElement("span");
    span.textContent = "S";
    parent.append(keyedNode, span);

    const p = document.createElement("p");
    p.textContent = "P";
    const nKeyed = document.createElement("div");
    nKeyed.setAttribute("data-id", "k");
    nKeyed.textContent = "K2";
    reconcileChildren(parent, [p, nKeyed]);

    expect(parent.children.length).toBe(2);
    expect(parent.children[0]!.tagName).toBe("P");
    expect(parent.children[0]!.textContent).toBe("P");
    expect(parent.children[0]!.hasAttribute("data-id")).toBe(false);
    expect(parent.children[1]).toBe(keyedNode);
    expect(parent.children[1]!.getAttribute("data-id")).toBe("k");
    expect(parent.children[1]!.textContent).toBe("K2");
  });

  it("keyed type-change reorder + trailing surplus: [div#a, span#k, p] -> [div#k, div#a]", () => {
    const parent = document.createElement("div");
    const a = document.createElement("div");
    a.setAttribute("data-id", "a");
    a.textContent = "A";
    const spanK = document.createElement("span");
    spanK.setAttribute("data-id", "k");
    spanK.textContent = "K";
    const p = document.createElement("p");
    parent.append(a, spanK, p);

    const divK = document.createElement("div");
    divK.setAttribute("data-id", "k");
    divK.textContent = "K2";
    const nA = document.createElement("div");
    nA.setAttribute("data-id", "a");
    nA.textContent = "A2";
    reconcileChildren(parent, [divK, nA]);

    expect(parent.children.length).toBe(2);
    expect(parent.children[0]).toBe(divK);
    expect(parent.children[0]!.textContent).toBe("K2");
    expect(parent.children[1]).toBe(a);
    expect(parent.children[1]!.getAttribute("data-id")).toBe("a");
    expect(parent.children[1]!.textContent).toBe("A2");
  });
});

describe("reconcileChildren: nodeKey precedence and duplicate keys", () => {
  it("a specific *-id attribute wins over a preceding generic data-col", () => {
    // Live pattern: a cell carrying BOTH keys (data-col="badges" +
    // data-cov-id="<entity>") must key by entity id — a different entity's
    // cell must not key-match it just because the column matches.
    const parent = document.createElement("tr");
    const cell = document.createElement("td");
    cell.setAttribute("data-col", "badges");
    cell.setAttribute("data-cov-id", "movie-1");
    cell.textContent = "one";
    parent.appendChild(cell);

    const other = document.createElement("td");
    other.setAttribute("data-col", "badges");
    other.setAttribute("data-cov-id", "movie-2");
    other.textContent = "two";
    reconcileChildren(parent, [other]);

    // Pre-fix both keyed as data-col=badges, so movie-2 patched onto
    // movie-1's node. Now the entity id decides: no match, node replaced.
    expect(parent.children.length).toBe(1);
    expect(parent.children[0]).toBe(other);
    expect(parent.children[0]!.getAttribute("data-cov-id")).toBe("movie-2");

    // Same entity id across a re-patch → matched, identity preserved.
    const update = document.createElement("td");
    update.setAttribute("data-col", "badges");
    update.setAttribute("data-cov-id", "movie-2");
    update.textContent = "two!";
    reconcileChildren(parent, [update]);
    expect(parent.children[0]).toBe(other);
    expect(other.textContent).toBe("two!");
  });

  it("duplicate-key siblings match in document order — identity preserved, no churn", () => {
    // Live pattern: two data-col="meta" cells (year + language) in one row.
    const parent = document.createElement("tr");
    const year = document.createElement("td");
    year.setAttribute("data-col", "meta");
    year.textContent = "2001";
    const lang = document.createElement("td");
    lang.setAttribute("data-col", "meta");
    lang.textContent = "English";
    parent.append(year, lang);

    const nYear = document.createElement("td");
    nYear.setAttribute("data-col", "meta");
    nYear.textContent = "2002";
    const nLang = document.createElement("td");
    nLang.setAttribute("data-col", "meta");
    nLang.textContent = "French";
    reconcileChildren(parent, [nYear, nLang]);

    // Pre-fix the last-wins map paired the first new cell with the LAST old
    // cell (year text patched onto the language node) and destroyed the other.
    expect(parent.children.length).toBe(2);
    expect(parent.children[0]).toBe(year);
    expect(parent.children[1]).toBe(lang);
    expect(year.textContent).toBe("2002");
    expect(lang.textContent).toBe("French");
  });
});
