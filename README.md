# reactive

[![npm](https://img.shields.io/npm/v/@cplieger/reactive)](https://www.npmjs.com/package/@cplieger/reactive)
[![JSR](https://jsr.io/badges/@cplieger/reactive)](https://jsr.io/@cplieger/reactive)
[![Test coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/reactive/badges/coverage.json)](https://github.com/cplieger/reactive/actions/workflows/coverage.yml)
[![Mutation (TS)](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/reactive/badges/mutation-ts.json)](https://github.com/cplieger/reactive/issues?q=label%3Astryker-tracker)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13218/badge)](https://www.bestpractices.dev/projects/13218)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/cplieger/reactive/badge)](https://scorecard.dev/viewer/?uri=github.com/cplieger/reactive)

> Signals + collections + DOM-reconciliation micro-framework for TypeScript

A standalone reactive app-skeleton:

- fine-grained signals with automatic dependency tracking and synchronous batched effects
- a typed per-key reactive store
- a dynamic per-id signal registry (`SignalMap`)
- a reactive ordered keyed `Collection`
- a two-tier list render binding (`bindList`)
- a CSP-safe element factory (`el`)
- keyed-list DOM reconciliation
- structural tree-diffing
- a typed event bus (`createBus`)

The store, `SignalMap`, and `Collection` are thin facades over a single signal engine: one reactive core, not several. Zero dependencies beyond the DOM API.

Mirrors semantics from @preact/signals-core and solid-js reactivity.

## Flush model

One phase, and this is the whole of it.

**A write flushes.** When `sig.value = x` returns, every effect that depends on
`sig` has already re-run. The setter notifies and drains before it returns, so
there is no pending-effect state a caller can observe and no queue to drain. Read
the DOM on the next statement and you are reading what the effects wrote. Same
contract as [@preact/signals-core](https://github.com/preactjs/signals/blob/main/packages/core/README.md),
this engine's baseline.

**`batch(fn)` is the only deferral.** Inside a batch, writes coalesce and effects
are held; they run once, synchronously, when the _outermost_ batch returns. A
nested batch defers to its outermost, and a throwing body still flushes.

**Deferral beyond that is yours.** To get effects on a later task, write on a
later task:

```typescript
queueMicrotask(() => {
  count.value = next; // effects run inside this microtask
});
```

There is deliberately **no flush barrier** — no `flushSync()`, no `nextTick()`.
A barrier is the API a _deferred_ model owes its callers (Vue's `nextTick`,
React's `flushSync`); an eager model never holds work, so it has nothing to
report on and nothing to force. `flushSync()` existed through v1.x, could never
find work pending, and refused to act when work was pending inside a batch; it
was removed in v2.0.0. If you were calling it, delete the call — it was a no-op.

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

- `signal<T>(initial, options?): Signal<T>`: reactive value with `.value` getter/setter and `.peek()`. Options: `{ equals?: false | ((prev, next) => boolean) }`
- `computed<T>(fn, options?): ReadonlySignal<T>`: lazy cached derived signal (glitch-free, equality-deduped). Options: `{ equals?: false | ((prev, next) => boolean) }`
- `effect(fn: () => Cleanup): () => void`: auto-tracking side-effect with cleanup support. `fn` must return `undefined` or a cleanup function.
- `batch(fn)`: coalesce signal writes; effects flush synchronously at end of outermost batch. The only deferral — see [Flush model](#flush-model)
- `untracked<T>(fn): T`: run fn without tracking signal reads (like Preact `untracked()` / Solid `untrack()`)
- `on(deps, fn, options?): () => U`: explicit dependency declaration helper (like Solid `on()`); pass into `effect()` or `computed()`. With `{ defer: true }` the accessor returns `() => U | undefined`: the deferred first call yields `undefined`.
- `subscribe(signal, cb): () => void`: subscribe to a signal, calling cb immediately and on every change. The callback runs untracked: signals read inside it do not become dependencies of the subscription
- `isSignal(value): boolean`: type guard for signals created by `signal()`
- `isComputed(value): boolean`: type guard for computed signals
- `setEffectErrorHandler(handler): EffectErrorHandler`: set global error handler for effects; returns the previous handler

### DOM building & reconciliation

- `el(tag, attrs?, ...children)`: CSP-safe element factory (the build half; `reconcile`/`patch` are the commit half). `className` → class; `on*` → handler property + `trackHandler` (so `patch` reconciles handlers); boolean DOM props (`hidden`/`disabled`/`checked`/`selected`/…) and `value`/`colSpan`/`rowSpan`/`tabIndex`/`htmlFor` → properties; everything else (`data-*`, `aria-*`, `style`, `id`) → `setAttribute`. String children become text nodes (never parsed as HTML); null/undefined attrs and children are skipped.
- `reconcile<T>(parent, items, spec)`: keyed-list DOM reconciliation with mount/update/onRemove lifecycle
- `patch(parent, ...children)`: structural tree-diff, replacing a parent's children with reconciled new nodes. Element nodes are keyed by a `*-id` attribute (a specific entity id, which takes precedence) or, failing that, `data-col`, so reorders and re-patches reuse the matched node; duplicate-key siblings match in document order; unkeyed nodes match by position. A reused element takes the new node's attributes, its tracked `on*` handlers, and the unreflected live properties the attribute pass cannot reach: `checked` (input), `selected` (option) and the `value` of an `input`/`textarea`. Those reflect to `defaultChecked`/`defaultSelected`/`defaultValue`, so without this a re-render could never turn a checkbox off or replace the text in a field. Syncing `value` overwrites what a user has typed and moves the caret to the end, which is correct only where a re-render cannot land mid-keystroke: a form re-rendered by a click is safe, one re-rendered by a timer or a server push is not, and that shape must drive the field from an effect instead (see [Unsupported by Design](#unsupported-by-design)).
- `reconcileChildren(parent, newChildren)`: low-level child reconciliation against existing DOM
- `trackHandler(el, key)`: register an `on*` property for handler reconciliation during tree-diff

### Store

`createStore` and `SignalMap` are thin facades over the one signal engine. `createStore` lazily backs each key with a signal; `SignalMap` is a registry of signals keyed by a runtime string id.

- `createStore<M>(): Store<M>`: typed, fixed-key reactive store with `get`, `set`, `subscribe`, and `computed`. A member exists here only where it does something the engine's namesake does not, so `effect` and `batch` are **not** on the store (removed in v2.0.0) — import them from the package root; `store.batch(…)` read as "batch this store's writes" while batching the whole graph. `subscribe` notifies on change only (not immediately on subscribe), and its callback runs untracked. `computed(outputKey, fn)` is an eager effect, not a lazy engine computed: it writes `outputKey` on every dependency change. So `fn` runs whether or not anyone reads the key; a throwing `fn` routes to the effect error handler instead of being cached and rethrown at the read site; `set(outputKey, …)` still works between recomputes. A `computed` key whose fn reads its own output does not loop unbounded: a self-read that keeps yielding new values surfaces `Error("Cycle detected")` through the effect error handler, while a stable self-read settles. The guard re-arms per write: a key that is still cyclic reports again on the next write to it rather than reporting once and going quiet, and effects merely queued alongside the cycle (a `subscribe` on the same key, say) stay reactive.
- `SignalMap<V>`: dynamic per-id signal registry: `get(id)`, `ensure(id, initial)`, `clear(id)`, `clearAll()`. For reactive state whose key set isn't known at the type level (per-message streaming text, per-row state, …); complements `createStore`'s fixed key set.

### Collections

A reactive ordered collection of keyed entities: the data half of the two-tier list pattern. A per-entity content update touches only that entity's subscribers; add/remove/reorder bumps the structure signal (`ids`). Built on `signal` + `SignalMap`.

- `createCollection<T>(keyOf: (item: T) => string): Collection<T>`: returns a collection with:
  - `setAll(items)`: replace everything (same-order replacement does not bump `ids`; duplicate keys deduplicate: first occurrence keeps the position, last value wins)
  - `upsert(item)`: add/replace one (appends new ids); `prepend(items)`: add to the front (scroll-up/load-older pagination)
  - `update(id, next | updater)` / `remove(id)` / `clear()`
  - `get(id)` / `has(id)` (untracked), `signalFor(id)` (reactive per-entity), `size`
  - `ids: ReadonlySignal<readonly string[]>`: structure tier (add/remove/reorder only)
  - `items()`: ordered reactive snapshot (tracks order + every entity)

### List rendering

- `bindList<T>(parent, source, spec): () => void`: two-tier render binding. `source` is a `ListSource<T>` = `{ ids, signalFor }`; a `Collection` satisfies it directly, and a filtered/sorted/paginated view is just `{ ids: computed(...), signalFor: collection.signalFor }` (pagination is a sliced view, not a separate primitive). A structural effect tracks `source.ids` and reconciles the row list; each row's own effect tracks only its entity signal, so a per-entity change repaints just that row with no structural reconcile. An id whose `signalFor` is `undefined` (an inconsistent source) is skipped rather than rendered. `spec`: `{ mount(item, id) => HTMLElement; update?(el, item, id); onRemove?(el, id) }` (`update` runs at mount and on every later change). Returns a dispose that tears down the structural effect and every row effect.

### Event bus

State lives in signals; discrete events go on a bus. `createBus` is the typed event primitive (not reactive state; no retained value).

- `createBus<EventMap>(options?): Bus<EventMap>`: `on`/`once`/`off`/`emit`/`clear`. Handlers are snapshot-cached (rebuilt only on mutation; a handler unsubscribed mid-emit still fires for that emit). Events whose payload type is `undefined` emit with no payload argument. A throwing handler is isolated via `options.onError` (default `console.error`).

## Correctness guarantees

- **Glitch-freedom**: Computed signals use equality dedup (`Object.is`), so downstream effects only fire when the computed value actually changes. Diamond dependency graphs are handled correctly.
- **Cycle detection**: Reading a computed that is currently being computed throws `Error("Cycle detected")`.
- **Error caching**: If a computed's fn throws, the error is cached and rethrown on subsequent reads until dependencies change.
- **Computed is read-only**: Setting `.value` on a computed throws `Error("Cannot set a computed signal")`.
- **Synchronous batch**: `batch()` flushes effects synchronously at the end of the outermost batch (matching @preact/signals-core and solid-js). It is the only deferral the library has; a bare write flushes before it returns. See [Flush model](#flush-model).

## Unsupported by Design

The following features are intentionally NOT implemented:

| Feature                                           | Reason                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Effect ownership tree / `createRoot`**          | Consumers manage disposal explicitly. Adding ownership changes the mental model.                                                                                                                                                                                                                                               |
| **Nested effect auto-disposal**                   | Each effect is independent and returns its own dispose function. Compose with arrays or helper functions.                                                                                                                                                                                                                      |
| **Lazy activation / `onMount` lifecycle**         | Signals are always active. Resource management is the consumer's responsibility.                                                                                                                                                                                                                                               |
| **`Signal.subtle.Watcher` / notify-on-dirty**     | This library IS the framework layer. The Watcher pattern is for frameworks that sit on top of a signals primitive.                                                                                                                                                                                                             |
| **Introspection APIs**                            | Dev-tools concern. Not needed for production.                                                                                                                                                                                                                                                                                  |
| **Explicit computed disposal**                    | Computed signals are GC'd when unreferenced. No explicit teardown needed.                                                                                                                                                                                                                                                      |
| **SSR / server-side isolation**                   | Client-side library. Server usage should instantiate fresh signal graphs per request.                                                                                                                                                                                                                                          |
| **Async signals / resources**                     | Out of scope. Use effects + manual signal writes for async data loading.                                                                                                                                                                                                                                                       |
| **Transactions**                                  | Framework-level concern. Not a signals primitive.                                                                                                                                                                                                                                                                              |
| **Custom scheduler / `setScheduler()`**           | Batch is synchronous and a write flushes before it returns, so there is no queue to schedule. Deferral is the caller's: write on a later task. See [Flush model](#flush-model).                                                                                                                                                |
| **A flush barrier (`flushSync`, `nextTick`)**     | A barrier is what a deferred model owes its callers; this model never holds work, so a barrier has nothing to report on. `flushSync()` shipped through v1.x and was a no-op from every position a caller could occupy; removed in v2.0.0.                                                                                      |
| **Controlled form inputs**                        | `patch()` syncs `checked`, `selected` and `input`/`textarea` `value`, so the render owns them. It has no change routing or state ownership, so a surface re-rendered while a user types must own the field itself.                                                                                                             |
| **Waking subscribers of a self-writing computed** | A computed that writes a signal it reads is re-read correctly (it is marked stale so the next read re-runs it), but its own subscribers are not woken, so an effect depending on it does not re-run until something else notifies it. Writing a source from a computed body is outside the intended shape; do it in an effect. |

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
conventions and how to run the checks locally.

## Disclaimer

This project is built with care and follows security best practices, but it is intended for personal / self-hosted use. No guarantees of fitness for production environments. Use at your own risk.

This project was built with AI-assisted tooling using [Claude](https://claude.com), [GPT](https://openai.com), and [Kiro](https://kiro.dev). The human maintainer defines architecture, supervises implementation, and makes all final decisions.

## License

Apache-2.0. See [LICENSE](LICENSE).
