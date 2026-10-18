# Signals, stores and collections

This page describes how the state half of reactive behaves, which covers signals, computed values, effects, owners, resources, stores, collections and the event bus. It is for a developer writing effects and stores who needs the exact rules. None of these functions needs a DOM.

## The flush model

The whole model has three rules.

- A write flushes. When `sig.value = x` returns, every effect that depends on `sig` has already re-run, except the effects still running, described below. The setter notifies and drains before it returns, so a caller never sees a pending effect and there is no queue to drain. Read the DOM on the next statement and you read what the effects wrote.
- `batch(fn)` is the only deferral. Inside a batch, writes coalesce and effects are held. They run once, synchronously, when the outermost batch returns. A nested batch defers to its outermost, and a throwing body still flushes.
- Deferral beyond that is yours. To get effects on a later task, write on a later task, with `queueMicrotask` or `requestAnimationFrame`.

An effect still running when a write lands is never interrupted. That covers the writer and every effect that started it, whether in its body or in the cleanup of its previous run. Each one whose current run had already read the written signal re-runs once that run returns, so a run is never cut in half by its own re-run.

The package has no flush barrier, meaning no `flushSync()` and no `nextTick()`. A barrier is the API a deferred model owes its callers, as with Vue's `nextTick` and React's `flushSync`. This model never holds work, so a barrier would have nothing to report and nothing to force. The same write contract is the one [@preact/signals-core](https://github.com/preactjs/signals/blob/main/packages/core/README.md) documents.

## Signals and computed values

- `signal<T>(initial, options?)` returns a value with a `.value` getter and setter and a `.peek()` that reads without tracking. A write that equals the current value does nothing. Equality is `Object.is` by default. Pass `{ equals: (prev, next) => boolean }` to compare your own way, or `{ equals: false }` to notify on every write.
- `computed<T>(fn, options?)` returns a read-only derived signal. It is lazy and cached. `fn` runs when the value is read after a dependency changed. Effects downstream run only when the result differs under the same equality rule. It takes the same `equals` option.
- A diamond-shaped graph, where two computed values read one signal and a third reads both, never shows a half-updated value.
- Reading a computed while it is computing throws `Error("Cycle detected")`.
- When `fn` throws, the computed caches the error, and every read rethrows it until a dependency changes.
- Setting `.value` on a computed throws `Error("Cannot set a computed signal")`.

## Effects

- `effect(fn)` runs `fn` at once and again whenever a signal it read changes. It returns a function that disposes the effect.
- `fn` returns `undefined` or a cleanup function. The cleanup runs before the next run and when the effect is disposed. A run that disposes its own effect, or the root holding it, has its cleanup run as soon as it returns.
- An effect that throws does not stop the other effects. The error goes to the handler set with `setEffectErrorHandler(handler)`, which returns the previous handler. The default handler calls `console.error`.
- Effects that keep writing the signals they depend on stop after 100 passes with `Error("Cycle detected")`, rather than looping forever.

## Owners

An owner disposes a tree of effects at once, such as everything a page or a dialog started. Outside any owner nothing changes, and each effect is independent and lives until you call its dispose function.

- `createRoot(fn)` runs `fn(dispose, owner)` in a new owner and returns what `fn` returns. Effects and roots created while it runs belong to the owner. A root created inside another owner is a child of it. If `fn` throws, the root is disposed and the error rethrown.
- An effect created under an owner belongs to it, and each run of the effect owns the effects and roots that run creates. They are disposed before the next run, so a parent effect that re-runs 100 times leaves one live child, not 100.
- `owner.signal` is an `AbortSignal` that aborts when the owner is disposed. Pass it to `fetch` or `addEventListener` so a disposed view stops its requests and listeners.
- `owner.onDispose(fn)` registers a callback for disposal.
- `runWithOwner(owner, fn)` runs `fn` with `owner` current, for an event handler or a continuation that creates effects later. Once the owner is being disposed or is disposed, it returns `undefined` without calling `fn`, so a handler queued by a closed view does nothing.
- Disposal has a fixed order. The owner is marked as being disposed, then its children are disposed newest first, then its callbacks run newest first, then `signal` aborts and the owner is closed. A callback or effect cleanup that throws goes to the effect error handler, and the rest of the disposal still runs.
- While an owner is being disposed, creating an effect, a root or a resource under it throws, and `onDispose` runs its callback at once. A write made by a cleanup during disposal re-runs no effect of the owner being disposed.
- `createRoot`, `runWithOwner` and disposal callbacks run untracked. A computed's function runs with no owner, because a computed runs whenever it is read.
- The current owner is not exported. Get an owner from `createRoot`'s callback or a `bindList` row.

```typescript
import { createRoot, effect, runWithOwner, signal } from "@cplieger/reactive";

const route = signal("/library");

const disposeApp = createRoot((dispose, owner) => {
  effect(() => {
    const path = route.value;
    // Owned by this run: disposed when the route changes.
    effect(() => {
      document.title = path;
    });
  });
  document.addEventListener(
    "keydown",
    () => {
      // A root created here belongs to the app's owner; this one ends at once.
      runWithOwner(owner, () =>
        createRoot((done) => {
          effect(() => console.log(route.value));
          done();
        }),
      );
    },
    { signal: owner.signal },
  );
  return dispose;
});

disposeApp(); // every effect stops, and the listener given owner.signal is removed
```

## Resources

`resource(source, load, options?)` loads async data for the current value of `source`. It needs an owner and throws when created outside one, or under one being disposed.

- `source()` is tracked. `load(value, signal)` runs at once and again whenever `source` produces a new value. A value equal to the previous one under `options.equals`, `Object.is` by default, starts no new run. A throw from `source` goes to the effect error handler and starts no run.
- Each run has its own owner. Its `signal` is the one passed to `load`, and it is current while `load` runs, untracked. A new source value, `refetch()` or the resource's owner being disposed disposes the previous run, which aborts its signal. A disposed run writes nothing when its promise settles later, so a late answer never overwrites a newer one.
- The resource is a read-only signal of a `Loadable<T, E>`: `{ state: "loading", stale? }`, `{ state: "ready", data }` or `{ state: "error", error, stale? }`. `stale` is the last ready value, kept while a later run loads and after it fails, so a failure never reads as empty. `E` is whatever `load` throws or rejects with.
- `refetch()` starts a new run for the current source value, and does nothing once the owner is being disposed.

```typescript
import { createRoot, effect, resource, signal } from "@cplieger/reactive";

const id = signal("a");

createRoot(() => {
  const item = resource(
    () => id.value,
    (value, signal) => fetch(`/items/${value}`, { signal }).then((res) => res.text()),
  );
  effect(() => {
    const s = item.value;
    console.log(s.state === "ready" ? s.data : s.state);
  });
});
```

## Reading without tracking

- `untracked(fn)` runs `fn` without recording the signals it reads, like Preact's `untracked()` and Solid's `untrack()`.
- `touch(...signals)` reads signals only to depend on them and discards the values. It is the complement of `peek()`, which reads without subscribing, while `touch` subscribes without keeping the value. It skips `undefined` entries, so a lookup that may miss, such as `collection.signalFor(id)` or `signalMap.get(id)`, can be passed straight in. `touch` adds a dependency and leaves every other read in the scope tracked.
- Use `touch` where a scope must re-run on a signal whose value it has no use for. The common case is a two-tier read, where a computed or an effect takes per-item values through `signalFor`. That scope must also depend on `collection.ids` to re-derive when the id set changes.
- `on(deps, fn, options?)` declares the dependencies of a scope explicitly, like Solid's `on()`, and returns a function to pass into `effect()` or `computed()`. Its body runs untracked, so the declared dependencies are the only ones. Reach for `touch()` instead when the rest of the scope should stay tracked. Passed to `effect()`, the body owes an explicit `return undefined` or a cleanup function, because a body with no return statement infers `() => void`, which the `Cleanup` type rejects. With `{ defer: true }` the first call returns `undefined` and the returned function is typed `() => U | undefined`.
- `subscribe(signal, cb)` calls `cb` with the current value at once and again on every change, and returns a dispose function. The callback runs untracked, so signals read inside it do not become dependencies of the subscription.
- `isSignal(value)` and `isComputed(value)` tell a signal made by `signal()` and a computed apart from any other value.

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

## Stores

`createStore` and `SignalMap` are thin layers over the same signal engine, so they keep its glitch-free updates and cycle detection.

`createStore<M>()` returns a typed store with a fixed set of keys, each backed by a signal created on first use. A key that was never set reads as `undefined`. It has four members:

- `get(key)` and `set(key, value)` read and write a key. Reading inside an effect tracks it.
- `subscribe(key, cb)` calls `cb` on each change only, not when you subscribe, and the callback runs untracked.
- `computed(outputKey, fn)` derives a key. It is an eager effect, not a lazy engine computed. It writes `outputKey` every time a dependency of `fn` changes, and it returns the effect's dispose function. So `fn` runs whether or not anyone reads the key. A throwing `fn` goes to the effect error handler instead of being cached and rethrown at the read. `set(outputKey, value)` still works between recomputes.
- A `computed` key whose `fn` reads its own output does not loop without end. A self-read that keeps producing new values reports `Error("Cycle detected")` through the effect error handler, and a self-read that settles on a stable value stops. The guard re-arms on each write, so a key that is still cyclic reports again on the next write to it. Effects queued beside the cycle, such as a `subscribe` on the same key, stay reactive.

The store has no `effect` or `batch` member. A store member exists only where it does something the engine's function of the same name does not, and `store.batch(...)` would read as "batch this store's writes" while it batched the whole graph. Import `effect` and `batch` from the package root.

`SignalMap<V>` is a registry of signals keyed by a string id that is known only at run time, such as per-message streaming text or per-row state. It complements the fixed keys of `createStore`.

- `get(id)` returns the signal for `id`, or `undefined` when none exists yet.
- `ensure(id, initial)` returns the signal for `id` and creates it with `initial` on first use.
- `clear(id)` drops one signal, and `clearAll()` drops every signal.
- `new SignalMap<V>({ equals })` gives every signal it creates that equality, so a write of an equal value notifies nothing. It is `Object.is` when omitted.

## Collections

`createCollection<T>(keyOf, options?)` returns an ordered collection of keyed items. It is the data half of a two-tier list. Each item has its own signal, and one more signal, `ids`, holds the order. An update to one item notifies only that item's readers. Adding, removing or reordering items changes `ids`. It is built on `signal` and `SignalMap`.

- `setAll(items)` replaces everything in one batch. A replacement in the same order does not change `ids`. Repeated keys collapse to one item. The first occurrence keeps its position, and a later value replaces the held one only when `options.equals` reports a change.
- `upsert(item)` adds or replaces one item, and a new id goes to the end.
- `prepend(items)` adds new items to the front, for loading older items on scroll-up. An id already present is updated where it is.
- `update(id, next)` replaces one item with a value or with the result of an updater function, and does nothing when the id is absent. `remove(id)` removes one item, and `clear()` removes all of them.
- `get(id)`, `has(id)` and `size` read without tracking.
- `signalFor(id)` returns the item's signal, or `undefined`, for a scope that should react to that item only.
- `ids` is the order signal. It changes on add, remove and reorder only.
- `items()` returns the values in order, and reading it in an effect tracks the order and every item.
- `options.equals(a, b)` decides when a write of an item is a change. `setAll`, `upsert`, `prepend` and `update` with an item equal to the current one notify nothing and keep the current value. It is `Object.is` when omitted.

`bindList` renders a collection. [Building and updating the DOM](dom.md#binding-a-list-source-with-bindlist) describes it.

## Event bus

State lives in signals, and discrete events go on a bus. A bus holds no value. It delivers "this just happened" to whoever listens, such as a navigation or a refresh request.

`createBus<EventMap>(options?)` returns a typed bus with `on`, `once`, `off`, `emit` and `clear`.

- `on(event, handler)` and `once(event, handler)` return an unsubscribe function, and `once` unsubscribes itself after the first emit.
- An event whose payload type is `undefined` is emitted with no payload, and its handlers are called with no argument.
- `emit` calls the handlers registered when it started. A handler unsubscribed during an emit still runs for that emit. The handler list is rebuilt only after a change, not on every emit.
- A handler that throws does not stop the others. The error goes to `options.onError(event, error)`, and the default writes it with `console.error`.
- The methods are plain function properties, so `const { on, emit } = bus` works without binding.
