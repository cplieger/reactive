import { el } from "../dom/el.js";

const RESET_MS = 1200;

const DEFAULT_ANNOUNCE = { success: "Action completed", error: "Action failed" } as const;

const SVG_NS = "http://www.w3.org/2000/svg";

/** A default outcome glyph, built with the DOM API so a page that enforces
 *  Trusted Types does not throw. `svgAttrs` follow the shared ones in order. */
function glyph(
  svgAttrs: readonly (readonly [string, string])[],
  shape: string,
  shapeAttrs: readonly (readonly [string, string])[],
): Element {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of [
    ["class", "btn-async-glyph"],
    ["width", "14"],
    ["height", "14"],
    ["viewBox", "0 0 24 24"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "3"],
    ["stroke-linecap", "round"],
    ...svgAttrs,
    ["aria-hidden", "true"],
  ] as const) {
    svg.setAttribute(name, value);
  }
  const child = document.createElementNS(SVG_NS, shape);
  for (const [name, value] of shapeAttrs) {
    child.setAttribute(name, value);
  }
  svg.append(child);
  return svg;
}

const defaultRenderPending = (): Node =>
  el("span", { className: "spinner-sm btn-async-spinner", "aria-hidden": "true" });
const defaultRenderSuccess = (): Node =>
  glyph([["stroke-linejoin", "round"]], "polyline", [["points", "20 6 9 17 4 12"]]);
const defaultRenderError = (): Node => glyph([], "path", [["d", "M18 6L6 18M6 6l12 12"]]);

/** A fragment empties into the button and leaves nothing to track, so its
 *  nodes go into one wrapper that lays out as if it were not there. */
function asOneNode(node: Node): Node {
  if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    return node;
  }
  const wrapper = document.createElement("span");
  wrapper.style.display = "contents";
  wrapper.append(node);
  return wrapper;
}

// The restore of a cycle whose outcome glyph is still up, in its timed hold
// or persisted, so the next cycle starts from the button's own content.
const held = new WeakMap<HTMLButtonElement, () => void>();

// Keyed on this, not `data-async-status`, so a persisted outcome glyph
// (resetMs<=0) can't permanently block re-dispatch.
const inFlight = new WeakSet<HTMLButtonElement>();

let liveRegion: HTMLElement | null = null;

function announce(message: string): void {
  // A region that left the document, such as when the app replaced <body>'s
  // children, is rebuilt, or no screen reader would hear the message.
  if (!liveRegion?.isConnected) {
    liveRegion = el("span", {
      className: "sr-only",
      "aria-live": "polite",
      "aria-atomic": "true",
    });
    // Visually hidden on its own, so a page with no `.sr-only` rule does not
    // show the announcement as text.
    Object.assign(liveRegion.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      margin: "-1px",
      padding: "0",
      border: "0",
      overflow: "hidden",
      clipPath: "inset(50%)",
      whiteSpace: "nowrap",
    });
    document.body.appendChild(liveRegion);
  }
  const region = liveRegion;
  // Clear then set: re-announces an identical message.
  region.textContent = "";
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}

/** Options for {@link withAsyncFeedback}. All fields are optional; the glyph
 *  renderers default to built-in inline SVGs. */
export interface AsyncFeedbackOptions {
  /** Post-completion glyph hold in ms before content reverts. Default 1200;
   *  `<= 0` persists the glyph indefinitely (button still re-enables, but
   *  `data-async-status` keeps its terminal value). */
  resetMs?: number;
  /** When true, prepend the pending node before the existing content (e.g.
   *  "⟳ Cloning…") instead of replacing the content with just that node.
   *  Default false (icon-only replace). Ignored when {@link target} is set. */
  keepLabel?: boolean;
  /** Drive a single child slot via element replacement
   *  (`current.replaceWith(next)`) instead of the button's whole content;
   *  other children of `btn` are untouched. The original node is restored at
   *  the reset, or by the next call when the glyph persists. Each renderer
   *  returns one element or text node; a fragment is refused. Expected to be
   *  a descendant of `btn` (not validated). `keepLabel` is ignored when set. */
  target?: HTMLElement;
  /** Pending-state node factory. Returns a fresh node per call. */
  renderPending?: () => Node;
  /** Success-glyph node factory. Returns a fresh node per call. */
  renderSuccess?: () => Node;
  /** Error-glyph node factory. Returns a fresh node per call. */
  renderError?: () => Node;
  /** Live-region announcement text, or `false` to disable announcing. */
  announce?: { readonly success: string; readonly error: string } | false;
}

/** Run an async function with consistent button feedback. The button is
 *  disabled during the call. A call made while `fn` runs is ignored; a call
 *  made while the previous outcome glyph is up takes it down first. The
 *  button's own nodes go back at the end, the same nodes, unless the app has
 *  written its own content over the glyph. */
export async function withAsyncFeedback(
  btn: HTMLButtonElement,
  fn: () => Promise<unknown>,
  opts: AsyncFeedbackOptions = {},
): Promise<void> {
  // `data-async-status` would deadlock the persist path, whose terminal
  // status is never cleared.
  if (inFlight.has(btn)) {
    return;
  }
  inFlight.add(btn);

  // A glyph still up from the previous cycle comes down first, so this cycle
  // reads the button's own content and state as its original.
  const prev = held.get(btn);
  if (prev !== undefined) {
    held.delete(btn);
    prev();
  }

  const renderPending = opts.renderPending ?? defaultRenderPending;
  const renderSuccess = opts.renderSuccess ?? defaultRenderSuccess;
  const renderError = opts.renderError ?? defaultRenderError;
  const announceCfg = opts.announce ?? DEFAULT_ANNOUNCE;

  // `originalTarget` keeps the exact node so a non-persist reset restores it;
  // `currentSlot` tracks whichever node currently occupies the slot.
  const target = opts.target;
  const useTarget = target !== undefined;
  const originalTarget: ChildNode | null = useTarget ? target : null;
  let currentSlot: ChildNode | null = useTarget ? target : null;

  // The slot holds one node, so a fragment, which empties into the page and
  // leaves nothing to swap next, is refused before anything changes.
  const swapSlot = (next: Node): void => {
    if (currentSlot === null) {
      return;
    }
    if (next.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      throw new TypeError("a target renderer must return an element or a text node");
    }
    currentSlot.replaceWith(next);
    currentSlot = next as ChildNode;
  };

  const origNodes = useTarget ? [] : [...btn.childNodes];
  const origDisabled = btn.disabled;
  const origAriaBusy = btn.getAttribute("aria-busy");
  // Captured before disabling: `btn.disabled = true` below blurs the button.
  const hadFocus = document.activeElement === btn;

  const restoreAriaBusy = (): void => {
    if (origAriaBusy === null) {
      btn.removeAttribute("aria-busy");
    } else {
      btn.setAttribute("aria-busy", origAriaBusy);
    }
  };

  // Only restores if focus has not since moved to a competing element.
  const restoreFocus = (): void => {
    if (hadFocus && btn.isConnected && !btn.disabled) {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        btn.focus();
      }
    }
  };

  // The node this cycle last put in the button, if any. The button's own
  // nodes go back only while it is still there: content the app wrote since
  // is the app's.
  let shownNode: Node | null = null;

  // Puts the button's own nodes back, as they were before the call. A former
  // child that now contains the button cannot go back inside it, so the
  // content then stays as it is.
  const restoreContent = (): void => {
    if (useTarget) {
      if (currentSlot !== null && originalTarget !== null) {
        currentSlot.replaceWith(originalTarget);
        currentSlot = originalTarget;
      }
    } else if (
      shownNode !== null &&
      shownNode.parentNode === btn &&
      !origNodes.some((n) => n.contains(btn))
    ) {
      btn.replaceChildren(...origNodes);
    }
  };

  btn.dataset["asyncStatus"] = "pending";
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    const pending = useTarget ? renderPending() : asOneNode(renderPending());
    if (useTarget) {
      swapSlot(pending);
    } else if (opts.keepLabel === true) {
      btn.prepend(pending, document.createTextNode(" "));
    } else {
      btn.replaceChildren(pending);
    }
    shownNode = pending;
  } catch (e) {
    // The call still runs; the button shows its own content meanwhile.
    console.error("[actions] withAsyncFeedback renderPending threw", e);
  }

  let ok = true;
  try {
    await fn();
  } catch {
    ok = false;
  }

  // The async op may have removed btn from the DOM (e.g. a re-rendered list).
  // The new DOM already reflects the result, so no outcome shows, but the
  // button is left as it was, in case the app puts it back.
  if (!btn.isConnected) {
    inFlight.delete(btn);
    restoreContent();
    btn.disabled = origDisabled;
    restoreAriaBusy();
    delete btn.dataset["asyncStatus"];
    return;
  }

  btn.dataset["asyncStatus"] = ok ? "success" : "error";
  let shown = true;
  try {
    const rendered = ok ? renderSuccess() : renderError();
    const outcome = useTarget ? rendered : asOneNode(rendered);
    if (useTarget) {
      swapSlot(outcome);
    } else {
      btn.replaceChildren(outcome);
    }
    shownNode = outcome;
  } catch (e) {
    shown = false;
    console.error(`[actions] withAsyncFeedback ${ok ? "renderSuccess" : "renderError"} threw`, e);
  }
  restoreAriaBusy();
  inFlight.delete(btn);
  if (announceCfg !== false) {
    announce(ok ? announceCfg.success : announceCfg.error);
  }

  // With no glyph to hold, the button goes back to its content at once.
  if (!shown) {
    restoreContent();
    btn.disabled = origDisabled;
    delete btn.dataset["asyncStatus"];
    restoreFocus();
    return;
  }

  // `resetMs <= 0` persists: no revert timer, but re-enable now since no
  // later callback will.
  const reset = opts.resetMs ?? RESET_MS;
  if (reset <= 0) {
    btn.disabled = origDisabled;
    held.set(btn, restoreContent);
    restoreFocus();
    return;
  }

  const finish = (): void => {
    restoreContent();
    btn.disabled = origDisabled;
    delete btn.dataset["asyncStatus"];
  };
  // A button the app removed during the hold is restored too, in case it is
  // put back; restoreFocus does nothing while it is out of the document.
  const timerId = setTimeout(() => {
    held.delete(btn);
    finish();
    restoreFocus();
  }, reset);
  held.set(btn, () => {
    clearTimeout(timerId);
    finish();
    restoreFocus();
  });
}
