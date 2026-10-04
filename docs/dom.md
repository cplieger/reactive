# Building and updating the DOM

This page describes the DOM half of reactive: `el`, `reconcile`, `bindList`, `patch` and `trackHandler`. It is for a developer rendering with them who needs to know which elements are kept, which are copied and which are replaced.

## What needs a DOM

Only `el`, `bindList`, `reconcile`, `patch` and `trackHandler` need a DOM. The engine and the state functions do not: `signal`, `effect`, `computed`, `batch`, `untracked`, `createStore`, `SignalMap`, `createCollection` and `createBus`. Nothing touches the DOM when the package is imported. So importing it under Node, Deno, Bun or Workers succeeds, and only the DOM functions throw when called there.

## Building elements with el

`el(tag, attrs?, ...children)` creates an element without parsing HTML, so it works under a strict Content Security Policy. `el` builds the elements, and `reconcile` and `patch` put them on the page.

Each attribute key is applied one of four ways:

- `className` sets the `class`.
- A key starting with `on` sets the handler property and registers it with `trackHandler`, so `patch` keeps handlers in step across re-renders.
- `hidden`, `disabled`, `checked`, `selected`, `multiple`, `readOnly`, `required`, `open`, `default`, `value`, `colSpan`, `rowSpan`, `tabIndex` and `htmlFor` are set as properties.
- Every other key, `data-*`, `aria-*`, `style` and `id` included, is set with `setAttribute`.

String children become text nodes and are never parsed as HTML. A `null` or `undefined` attribute or child is skipped.

Text goes in the children, never in the attributes. A key such as `textContent` or `innerText` is not on the property list. So `el("span", { textContent: "i" })` type-checks, sets an attribute named `textcontent` and leaves the span empty, with no error. Write `el("span", null, "i")` instead.

## Rendering a keyed list with reconcile

`reconcile(parent, items, spec)` makes the children of `parent` match `items`, keeping the existing element for each key. `spec` has four members:

- `key(item)` returns the item's key. It is called once per item.
- `mount(item)` creates the element for a new key. `reconcile` stores the key on the element in the attribute named by the exported `KEY_ATTR`, which is `data-reconcile-key`.
- `update(el, item)` is optional and runs for each element that stays.
- `onRemove(el, key)` is optional and runs for each element that leaves.

Elements that leave are removed before the others are placed. `onRemove` therefore receives its element intact, while the positions of its siblings are not final yet. An element already in its final position is not moved. A focused input or a text selection inside that row survives, and so do the row's animations and hover state.

## Binding a list source with bindList

`bindList(parent, source, spec)` renders a list in two tiers and returns a dispose function that stops both.

- The structure tier is one effect that tracks `source.ids` and runs `reconcile` over the ids. Adding, removing or reordering items touches only the rows involved.
- The content tier is one effect per row that tracks only that row's item signal. A change to one item repaints that row and nothing else.

`source` is a `ListSource<T>`, meaning `{ ids, signalFor }`. A collection from `createCollection` is one directly. A filtered, sorted or paged view is `{ ids: computed(...), signalFor: collection.signalFor }`. Pagination is therefore a sliced view of the ids, not a separate primitive. An id whose `signalFor` returns `undefined` is skipped. It can render after a later `ids` change reruns the structural effect.

`spec` has three members:

- `mount(item, id)` returns the row element. Keep it to the row's structure and let `update` fill the content.
- `update(el, item, id)` is optional. It runs when the row mounts and again on every change to its item.
- `onRemove(el, id)` is optional and runs when the row leaves, before the element is removed.

## Updating a subtree with patch

`patch(parent, ...children)` makes the children of `parent` exactly the nodes passed, in order. A string becomes a text node, a `DocumentFragment` contributes its children, and `null` or `undefined` is skipped. Where an existing child corresponds to a requested one, `patch` keeps it and changes it to match. Focus, selection and scroll position survive.

It decides which existing child corresponds to which requested child in this order, strongest first:

1. The same node. A node that is already a child of `parent` is placed at the index you passed it at, unchanged. Handing a parent its own children in a new order is supported.
2. The same key. An attribute whose name ends in `-id` is the key and wins over `data-col`. Siblings with the same key pair up in document order.
3. The same position, among the children that carry no key.

A requested node that is not already a child of `parent` is a template. Its tag, attributes and content may be copied into a kept child, and the template itself is never inserted. A reference to a freshly built node is therefore not a reference to something on the page.

A kept element takes the template's attributes and its `on*` handlers registered with `trackHandler`. It also takes three live properties that attributes cannot reach: `checked` on an input, `selected` on an option, and `value` on an input or a textarea. Those attributes set only `defaultChecked`, `defaultSelected` and `defaultValue`. Without the property sync, a re-render could never turn a checkbox off or replace the text in a field. Each property is written only when it differs.

Writing `value` replaces what a user has typed and moves the caret to the end. That is safe where a re-render cannot happen mid-keystroke, as with a form re-rendered by a click. A form re-rendered by a timer or a server push is not safe, so drive that field from an effect instead of re-rendering over it.

### Handlers that hold nodes from their own render

`patch` copies a template's `on*` handlers into the kept element. After a re-render, the handler on the page is the newest one, and any node it captured from its own render was never inserted. A handler that writes into such a node writes into a detached subtree, so the user sees no change and no error. The same applies to an effect or a promise callback that captures a node the same render built.

A listener attached with `addEventListener` is invisible to `patch`, which gives the opposite result. The kept element keeps the first render's listener, and every later render's listener is thrown away with its template.

Two fixes work. Look the node up through the live parent when the handler runs. Or install the subtree with `replaceChildren` instead of `patch`, which gives up reuse along with focus and scroll position. `reconcile` does not have this obligation, because it inserts the elements its `mount` returns.

## Tracking handlers

`trackHandler(el, key)` registers an `on*` property of an element. `patch` then copies it from a template, and clears it when a later template no longer sets it. `el` calls it for every `on*` key, so only an element you build another way needs it.
