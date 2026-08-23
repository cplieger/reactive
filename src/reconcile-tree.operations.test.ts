// @vitest-environment happy-dom
// Structural tree-diff — the WORK a reconcile does, not just the tree it leaves.
//
// The point of reusing a node instead of recreating it is that the DOM is not
// touched: a node that is re-inserted loses focus and selection, a text node
// rewritten with the same string still wakes every MutationObserver watching it,
// an attribute rewritten with the same value restarts a CSS transition, and a
// live `value`/`checked`/`selected` written even with the identical value takes
// permanent ownership of that state away from the content attribute (the DOM's
// dirty-value / dirty-checkedness / dirtiness flags). All of that is invisible
// in the resulting tree, so these tests observe the operations instead: a spy on
// the parent's insertBefore (two of them, each declared at its site), a
// MutationObserver's records, and — for the unreflected properties — the
// attribute-reflection the flags switch off.
//
// The last case is the mirror image: `patch` must reconcile the handlers it was
// told about via trackHandler and leave every other property alone, including a
// handler a consumer assigned directly after `patch` stopped tracking one.
import { describe, it, expect, vi } from "vitest";
import { el, patch, trackHandler } from "./index.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function keyedRow(key: string, text: string): HTMLElement {
  const el = document.createElement("li");
  el.setAttribute("data-col", key);
  el.textContent = text;
  return el;
}

describe("patch: an unchanged re-patch does no DOM work", () => {
  it("moves no node when a keyed list is re-rendered in the same order", () => {
    const parent = host();
    patch(parent, keyedRow("a", "A"), keyedRow("b", "B"), keyedRow("c", "C"));
    const reused = Array.from(parent.children);
    expect(reused).toHaveLength(3);

    const moves = vi.spyOn(parent, "insertBefore");
    patch(parent, keyedRow("a", "A"), keyedRow("b", "B"), keyedRow("c", "C"));

    // Every node was already at its target index, so nothing may be re-inserted:
    // in a browser each re-insert costs the node its focus and its selection.
    expect(moves).not.toHaveBeenCalled();
    expect(Array.from(parent.children)).toEqual(reused);
    moves.mockRestore();
  });

  it("moves no node when the caller hands back its own children in the same order", () => {
    // The operations-level statement of what identity matching buys. Handing a
    // parent its own children unchanged is what a re-render after a no-op state
    // change looks like; every node is already seated, so nothing may be touched.
    // Second spy, declared: `insertBefore(node, node)` emits no MutationObserver
    // record under happy-dom and preserves focus, so there is no behavioural
    // instrument for "it did not move a node that was already in place".
    const parent = host();
    patch(parent, el("div", null, "A"), el("div", null, "B"), el("div", null, "C"));
    const own = Array.from(parent.childNodes);
    expect(own).toHaveLength(3);

    const moves = vi.spyOn(parent, "insertBefore");
    patch(parent, ...own);

    expect(moves).not.toHaveBeenCalled();
    expect(Array.from(parent.childNodes)).toEqual(own);
    moves.mockRestore();
  });

  it("writes nothing to a text node whose content is unchanged", () => {
    const parent = host();
    patch(parent, "same");
    const observer = new MutationObserver(() => {
      // records are read synchronously via takeRecords()
    });
    observer.observe(parent, { characterData: true, childList: true, subtree: true });

    patch(parent, "same");

    const records = observer.takeRecords();
    observer.disconnect();
    expect(records.map((r) => r.type)).toEqual([]);
    expect(parent.textContent).toBe("same");
  });

  it("still rewrites a text node whose content changed", () => {
    const parent = host();
    patch(parent, "before");
    const first = parent.firstChild;
    const observer = new MutationObserver(() => {
      // records are read synchronously via takeRecords()
    });
    observer.observe(parent, { characterData: true, childList: true, subtree: true });

    patch(parent, "after");

    const records = observer.takeRecords();
    observer.disconnect();
    expect(records.map((r) => r.type)).toEqual(["characterData"]);
    expect(parent.textContent).toBe("after");
    // In place: the same text node, not a replacement.
    expect(parent.firstChild).toBe(first);
  });

  it("writes no attribute whose value is unchanged, and writes the one that changed", () => {
    const parent = host();
    const before = document.createElement("span");
    before.setAttribute("data-col", "only");
    before.setAttribute("class", "chip");
    before.setAttribute("title", "old");
    patch(parent, before);
    const reused = parent.firstElementChild;

    const observer = new MutationObserver(() => {
      // records are read synchronously via takeRecords()
    });
    observer.observe(parent, { attributes: true, subtree: true });

    const same = document.createElement("span");
    same.setAttribute("data-col", "only");
    same.setAttribute("class", "chip");
    same.setAttribute("title", "old");
    patch(parent, same);
    expect(observer.takeRecords()).toEqual([]);

    const changed = document.createElement("span");
    changed.setAttribute("data-col", "only");
    changed.setAttribute("class", "chip");
    changed.setAttribute("title", "new");
    patch(parent, changed);

    const records = observer.takeRecords();
    observer.disconnect();
    expect(records.map((r) => r.attributeName)).toEqual(["title"]);
    expect(parent.firstElementChild).toBe(reused);
    expect(reused?.getAttribute("title")).toBe("new");
  });
});

// The DOM's dirty flags are the reason each unreflected-property sync is guarded.
// Writing `.checked` / `.value` / `.selected` — even the value already there —
// severs the property from its content attribute for the rest of the element's
// life, so a re-patch that changed nothing must not write.
describe("patch: an unchanged re-patch does not take ownership of live state", () => {
  function checkbox(checked: boolean): HTMLInputElement {
    const el = document.createElement("input");
    el.setAttribute("type", "checkbox");
    if (checked) {
      el.setAttribute("checked", "");
    }
    return el;
  }

  it("leaves a checkbox still following its checked attribute", () => {
    const parent = host();
    const box = checkbox(true);
    patch(parent, box);
    expect(box.checked).toBe(true);

    patch(parent, checkbox(true)); // identical: nothing to sync

    box.removeAttribute("checked");
    expect(box.checked).toBe(false);
  });

  it("still turns a reused checkbox off when the new render says so", () => {
    const parent = host();
    const box = checkbox(true);
    patch(parent, box);
    box.checked = true;

    patch(parent, checkbox(false));

    expect(box.checked).toBe(false);
  });

  it("leaves a text input still following its value attribute", () => {
    const parent = host();
    const field = document.createElement("input");
    field.setAttribute("value", "keep");
    patch(parent, field);
    expect(field.value).toBe("keep");

    const same = document.createElement("input");
    same.setAttribute("value", "keep");
    patch(parent, same); // identical: nothing to sync

    field.setAttribute("value", "later");
    expect(field.value).toBe("later");
  });

  it("leaves a textarea still following its child text", () => {
    const parent = host();
    const area = document.createElement("textarea");
    area.textContent = "keep";
    patch(parent, area);
    expect(area.value).toBe("keep");

    const same = document.createElement("textarea");
    same.textContent = "keep";
    patch(parent, same); // identical: nothing to sync

    area.textContent = "later";
    expect(area.value).toBe("later");
  });

  it("leaves an option still following its selected attribute", () => {
    const parent = host();
    const option = document.createElement("option");
    option.setAttribute("selected", "");
    patch(parent, option);
    expect(option.selected).toBe(true);

    const same = document.createElement("option");
    same.setAttribute("selected", "");
    patch(parent, same); // identical: nothing to sync

    option.removeAttribute("selected");
    expect(option.selected).toBe(false);
  });
});

describe("patch: handler reconciliation is limited to tracked keys", () => {
  it("does not clear a handler assigned after patch stopped tracking one", () => {
    const parent = host();
    const tracked = document.createElement("button");
    const first = vi.fn();
    tracked.onclick = first;
    trackHandler(tracked, "onclick");
    patch(parent, tracked);
    expect(parent.firstElementChild).toBe(tracked);

    // A render with no handler at all: the tracked key is cleared AND forgotten.
    patch(parent, document.createElement("button"));
    expect(tracked.onclick).toBeNull();

    // The consumer now owns this handler; `patch` was never told about it.
    const own = vi.fn();
    tracked.onclick = own;

    patch(parent, document.createElement("button"));
    patch(parent, document.createElement("button"));

    expect(tracked.onclick).toBe(own);
    tracked.dispatchEvent(new Event("click"));
    expect(own).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe("patch: reconciling a parent against a child it already has", () => {
  it("keeps the tracked handlers on a node patched against itself", () => {
    const parent = host();
    const button = document.createElement("button");
    const handler = vi.fn();
    button.onclick = handler;
    trackHandler(button, "onclick");
    patch(parent, button);
    expect(parent.firstElementChild).toBe(button);

    // Re-rendering with the very node already in place. The caller handed back a
    // node this parent already has, so it is its own match: it is seated where it
    // already sits and never reconciled against itself, which is why its tracked
    // handler cannot be cleared by a pass that would then copy it back from
    // itself. (Before identity matching this went through patchAttrs with
    // oldEl === newEl sharing one tracked-key set, and the guard on the clearing
    // loop was what saved it.)
    patch(parent, button);
    patch(parent, button);

    expect(button.onclick).toBe(handler);
    button.dispatchEvent(new Event("click"));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("patch: the option-only property sync is scoped to options", () => {
  it("does not move a `selected` property between two reused list items", () => {
    // `el()` assigns `selected` as a DOM *property* whatever the tag is (it is
    // in its boolean-property set), so a non-option carrying one is a shape this
    // library's own factory produces. Only <option> has a `selected` the DOM
    // owns; anywhere else it is consumer state and patch must leave it alone.
    const parent = host();
    const row = el("li", { selected: true }, "one");
    patch(parent, row);
    expect((row as unknown as Record<string, unknown>)["selected"]).toBe(true);

    patch(parent, el("li", {}, "one"));

    expect(parent.firstElementChild).toBe(row);
    expect((row as unknown as Record<string, unknown>)["selected"]).toBe(true);
  });
});
