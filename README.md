# reactive

[![CI](https://github.com/cplieger/reactive/actions/workflows/ci.yaml/badge.svg)](https://github.com/cplieger/reactive/actions/workflows/ci.yaml)
[![npm](https://img.shields.io/npm/v/@cplieger/reactive)](https://www.npmjs.com/package/@cplieger/reactive)
[![JSR](https://jsr.io/badges/@cplieger/reactive)](https://jsr.io/@cplieger/reactive)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

> Signals + collections + DOM-reconciliation micro-framework for TypeScript

A standalone reactive app-skeleton: fine-grained signals with automatic dependency tracking and synchronous batched effects, a typed per-key reactive store, a dynamic per-id signal registry (`SignalMap`), a reactive ordered keyed `Collection`, a two-tier list render binding (`bindList`), a CSP-safe element factory (`el`), keyed-list DOM reconciliation, structural tree-diffing, and a typed event bus (`createBus`). The store, `SignalMap`, and `Collection` are thin facades over the single signal engine — one reactive core, not several. The bus is the deliberate counterpart for discrete events (state lives in signals; events go on the bus). Zero dependencies beyond the DOM API.

Mirrors semantics from @preact/signals-core and solid-js reactivity.

## Install

```sh
npx jsr add @cplieger/reactive
# or
npm i @cplieger/reactive
```

## Usage

```typescript
import {
  signal,
  effect,
  batch,
  computed,
  untracked,
  subscribe,
  isSignal,
  isComputed,
} from "@cplieger/reactive";

const count = signal(0);
const doubled = computed(() => count.value * 2);

effect(() => {
  console.log("count:", count.value, "doubled:", doubled.value);
  return undefined;
});

batch(() => {
  count.value = 1;
  count.value = 2; // effect fires once with value 2, synchronously at batch end
});

// Read without tracking
effect(() => {
  const tracked = count.value;
  const notTracked = untracked(() => doubled.value);
  console.log(tracked, notTracked);
  return undefined;
});

// Subscribe utility
const dispose = subscribe(count, (v) => console.log("count changed:", v));
dispose();

// Type guards
isSignal(count); // true
isComputed(doubled); // true
```

## API

### Signals

- `signal<T>(initial, options?): Signal<T>` — reactive value with `.value` getter/setter and `.peek()`. Options: `{ equals?: false | ((prev, next) => boolean) }`
- `computed<T>(fn, options?): ReadonlySignal<T>` — lazy cached derived signal (glitch-free, equality-deduped). Options: `{ equals?: false | ((prev, next) => boolean) }`
- `effect(fn: () => Cleanup): () => void` — auto-tracking side-effect with cleanup support. `fn` must return `undefined` or a cleanup function.
- `batch(fn)` — coalesce signal writes; effects flush synchronously at end of outermost batch
- `flushSync()` — synchronously drain pending effects (no-op inside batch)
- `untracked<T>(fn): T` — run fn without tracking signal reads (like Preact `untracked()` / Solid `untrack()`)
- `on(deps, fn, options?): () => U | undefined` — explicit dependency declaration helper (like Solid `on()`). Pass into `effect()` or `computed()`.
- `subscribe(signal, cb): () => void` — subscribe to a signal, calling cb immediately and on every change
- `isSignal(value): boolean` — type guard for signals created by `signal()`
- `isComputed(value): boolean` — type guard for computed signals
- `setEffectErrorHandler(handler): EffectErrorHandler` — set global error handler for effects; returns the previous handler

### DOM building & reconciliation

- `el(tag, attrs?, ...children)` — CSP-safe element factory (the build half; `reconcile`/`patch` are the commit half). `className` → class; `on*` → handler property + `trackHandler` (so `patch` reconciles handlers); boolean DOM props (`hidden`/`disabled`/`checked`/`selected`/…) and `value`/`colSpan`/`rowSpan`/`tabIndex`/`htmlFor` → properties; everything else (`data-*`, `aria-*`, `style`, `id`) → `setAttribute`. String children become text nodes (never parsed as HTML); null/undefined attrs and children are skipped.
- `reconcile<T>(parent, items, spec)` — keyed-list DOM reconciliation with mount/update/onRemove lifecycle
- `patch(parent, ...children)` — structural tree-diff, replacing a parent's children with reconciled new nodes. Element nodes are keyed by their first `data-col` or `*-id` attribute (so reorders/re-patches reuse the matched node); unkeyed nodes match by position.
- `reconcileChildren(parent, newChildren)` — low-level child reconciliation against existing DOM
- `trackHandler(el, key)` — register an `on*` property for handler reconciliation during tree-diff

### Store

`createStore` and `SignalMap` are thin facades over the one signal engine — there is no second reactivity implementation. `createStore` lazily backs each key with a signal; `SignalMap` is a registry of signals keyed by a runtime string id.

- `createStore<M>(): Store<M>` — typed, fixed-key reactive store with `get`, `set`, `subscribe`, `effect`, `computed`, and `batch`. `subscribe` notifies on change only (not immediately on subscribe). A `computed` key whose fn reads its own output throws `Error("Cycle detected")` rather than looping.
- `SignalMap<V>` — dynamic per-id signal registry: `get(id)`, `ensure(id, initial)`, `clear(id)`, `clearAll()`. For reactive state whose key set isn't known at the type level (per-message streaming text, per-row state, …); complements `createStore`'s fixed key set.

### Collections

A reactive ordered collection of keyed entities — the data half of the two-tier list pattern. A per-entity content update touches only that entity's subscribers; add/remove/reorder bumps the structure signal (`ids`). Built on `signal` + `SignalMap`.

- `createCollection<T>(keyOf: (item: T) => string): Collection<T>` — returns a collection with:
  - `setAll(items)` — replace everything (same-order replacement does not bump `ids`)
  - `upsert(item)` — add/replace one (appends new ids); `prepend(items)` — add to the front (scroll-up/load-older pagination)
  - `update(id, next | updater)` / `remove(id)` / `clear()`
  - `get(id)` / `has(id)` (untracked), `signalFor(id)` (reactive per-entity), `size`
  - `ids: ReadonlySignal<readonly string[]>` — structure tier (add/remove/reorder only)
  - `items()` — ordered reactive snapshot (tracks order + every entity)

### List rendering

- `bindList<T>(parent, source, spec): () => void` — two-tier render binding. `source` is a `ListSource<T>` = `{ ids, signalFor }`; a `Collection` satisfies it directly, and a filtered/sorted/paginated view is just `{ ids: computed(...), signalFor: collection.signalFor }` (pagination = a sliced view, not a separate primitive). One structural effect tracks `source.ids` and `reconcile`s the row list; each row owns a private effect tracking only its own entity signal, so a per-entity change repaints just that row with no structural reconcile. `spec`: `{ mount(item, id) => HTMLElement; update?(el, item, id); onRemove?(el, id) }` (`update` runs at mount and on every later change). Returns a dispose that tears down the structural effect and every row effect.

### Event bus

State lives in signals; discrete events go on a bus. `createBus` is the typed event primitive (not reactive state — no retained value).

- `createBus<EventMap>(options?): Bus<EventMap>` — `on`/`once`/`off`/`emit`/`clear`. Handlers are snapshot-cached (rebuilt only on mutation; a handler unsubscribed mid-emit still fires for that emit). Events whose payload type is `undefined` emit with no payload argument. A throwing handler is isolated via `options.onError` (default `console.error`).

## Correctness guarantees

- **Glitch-freedom**: Computed signals use equality dedup (`Object.is`) — downstream effects only fire when the computed value actually changes. Diamond dependency graphs are handled correctly.
- **Cycle detection**: Reading a computed that is currently being computed throws `Error("Cycle detected")`.
- **Error caching**: If a computed's fn throws, the error is cached and rethrown on subsequent reads until dependencies change.
- **Computed is read-only**: Setting `.value` on a computed throws `Error("Cannot set a computed signal")`.
- **Synchronous batch**: `batch()` flushes effects synchronously at the end of the outermost batch (matching @preact/signals-core and solid-js).

## Design Decisions — Unsupported by Design

The following features are intentionally NOT implemented:

| Feature                                       | Reason                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Effect ownership tree / `createRoot`**      | Consumers manage disposal explicitly. Adding ownership adds ~150 LOC of complexity and changes the mental model.   |
| **Nested effect auto-disposal**               | Each effect is independent and returns its own dispose function. Compose with arrays or helper functions.          |
| **Lazy activation / `onMount` lifecycle**     | Signals are always active. Resource management is the consumer's responsibility.                                   |
| **`Signal.subtle.Watcher` / notify-on-dirty** | This library IS the framework layer. The Watcher pattern is for frameworks that sit on top of a signals primitive. |
| **Introspection APIs**                        | Dev-tools concern. Not needed for production.                                                                      |
| **Explicit computed disposal**                | Computed signals are GC'd when unreferenced. No explicit teardown needed.                                          |
| **SSR / server-side isolation**               | Client-side library. Server usage should instantiate fresh signal graphs per request.                              |
| **Async signals / resources**                 | Out of scope. Use effects + manual signal writes for async data loading.                                           |
| **Transactions**                              | Framework-level concern. Not a signals primitive.                                                                  |
| **Custom scheduler / `setScheduler()`**       | Batch is synchronous. No scheduler needed.                                                                         |

## License

GPL-3.0 — see [LICENSE](LICENSE).
