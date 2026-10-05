# reactive

[![npm](https://img.shields.io/npm/v/@cplieger/reactive)](https://www.npmjs.com/package/@cplieger/reactive) [![JSR](https://jsr.io/badges/@cplieger/reactive)](https://jsr.io/@cplieger/reactive) [![Mutation (TS)](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/reactive/badges/mutation-ts.json)](https://github.com/cplieger/reactive/issues?q=label%3Astryker-tracker)

reactive lets you build a framework-free TypeScript browser UI with signals, keyed list rendering and in-place DOM updates, in one package with no runtime dependencies.

It replaces the change listeners, list re-renders and element builder you would otherwise write between state and the page. It ships as ESM TypeScript source rather than compiled JavaScript, so it needs a bundler or runtime that compiles TypeScript. Releases follow semantic versioning, and it is licensed under Apache-2.0.

## Why use it

reactive is built for a small browser app in plain TypeScript that needs no component framework.

- Signals, computed values and effects track their dependencies on their own. When a write returns, every effect that depends on it has already run.
- `createCollection` and `bindList` render a keyed list. Changing one item repaints only its row, and a reorder keeps the existing rows.
- `el` builds elements without HTML strings, so it works under a strict Content Security Policy. `patch` updates a subtree by reusing the elements on the page, so focus and scroll position survive a re-render.
- The signals, stores, collections and event bus need no DOM, so they also run under Node, Deno, Bun or Workers.

Consider [Solid](https://github.com/solidjs/solid) if you want a full UI framework, with components, JSX, Suspense for async data and server-side rendering.

## Install

```sh
npx jsr add @cplieger/reactive
# or
npm i @cplieger/reactive
```

## Usage

A signal holds a value, a computed value derives from signals, and an effect re-runs when what it read changes:

```typescript
import { signal, computed, effect, batch } from "@cplieger/reactive";

const count = signal(0);
const doubled = computed(() => count.value * 2);

const dispose = effect(() => {
  console.log(count.value, doubled.value);
  return undefined; // an effect returns undefined or a cleanup function
});

batch(() => {
  count.value = 1;
  count.value = 2;
}); // the effect ran once, with 2 and 4, before batch returned

dispose();
```

A collection and `bindList` render a list. Updating one item repaints only its row:

```typescript
import { bindList, createCollection, el } from "@cplieger/reactive";

interface Todo {
  id: string;
  title: string;
  done: boolean;
}

const todos = createCollection<Todo>((todo) => todo.id);
const list = el("ul");
document.body.append(list);

bindList(list, todos, {
  mount: () => el("li"),
  update: (row, todo) => {
    row.textContent = todo.done ? `${todo.title} (done)` : todo.title;
  },
});

todos.setAll([
  { id: "a", title: "Write docs", done: false },
  { id: "b", title: "Ship", done: false },
]);
todos.update("a", (todo) => ({ ...todo, done: true })); // only the first row repaints
```

`patch` takes freshly built elements and applies them to a subtree, keeping the elements already on the page:

```typescript
import { effect, el, patch, signal } from "@cplieger/reactive";

const name = signal("world");
const header = el("header");
document.body.append(header);

effect(() => {
  patch(header, el("h1", { className: "title" }, `Hello, ${name.value}`));
  return undefined;
});

name.value = "reactive"; // the same <h1> stays on the page with its new text
```

## API

- Signals: `signal`, `computed`, `effect`, `batch`, `untracked`, `touch`, `on`, `subscribe`, `isSignal`, `isComputed` and `setEffectErrorHandler`.
- State: `createStore` for a fixed set of typed keys, `SignalMap` for keys known only at run time, and `createCollection` for an ordered list of keyed items.
- DOM: `el` builds elements, `reconcile` and `bindList` render keyed lists, and `patch` updates a subtree in place. `trackHandler` registers an `on*` handler on an element you built without `el`, so `patch` keeps it in step.
- Events: `createBus` for typed events that hold no value.

The full reference is on [JSR](https://jsr.io/@cplieger/reactive/doc). [Signals, stores and collections](docs/signals.md) and [Building and updating the DOM](docs/dom.md) describe how each one behaves.

## A write runs its effects before it returns

When `count.value = 1` returns, every effect that depends on `count` has already run, so the next line reads the DOM those effects wrote. There is no queue and no pending state to wait for.

`batch(fn)` is the only way to defer. Writes inside it coalesce, and the held effects run once, synchronously, when the outermost batch returns, even when the body throws. To run effects on a later task, make the write on a later task:

```typescript
queueMicrotask(() => {
  count.value = next; // effects run inside this microtask
});
```

This is the contract [@preact/signals-core](https://github.com/preactjs/signals/blob/main/packages/core/README.md) documents too. The package has no `flushSync()` or `nextTick()`, because it never holds work, so there is nothing to flush.

## Correctness guarantees

- Effects downstream of a `computed` run only when its value changes, compared with `Object.is` unless you pass `equals`. A diamond-shaped dependency graph never shows a half-updated value.
- Reading a `computed` while it is computing throws `Error("Cycle detected")`.
- When a computed function throws, every read rethrows that error until a dependency changes.
- Setting `.value` on a `computed` throws `Error("Cannot set a computed signal")`.
- `batch()` runs the held effects synchronously at the end of the outermost batch, as @preact/signals-core and solid-js do.

## Unsupported by design

The package leaves these out on purpose. [Non-goals](docs/non-goals.md) gives the reason for each.

- An ownership tree or `createRoot`, and automatic disposal of nested effects.
- Lazy activation and an `onMount` lifecycle.
- `Signal.subtle.Watcher` and notify-on-dirty.
- Introspection APIs, and explicit disposal of a computed.
- Server-side rendering and per-request isolation.
- Async signals and resources.
- Transactions, a custom scheduler, and a flush barrier such as `flushSync` or `nextTick`.
- Controlled form inputs. `patch` syncs form values, so if a view can re-render while a user types, drive that field from an effect instead.
- Writing a signal from inside a computed. The computed's own subscribers are not woken, so make that write in an effect.

## Documentation

- [Signals, stores and collections](docs/signals.md) covers the flush model, effects, stores, collections and the event bus, for a reader writing state code.
- [Building and updating the DOM](docs/dom.md) covers how `el`, `reconcile`, `bindList` and `patch` decide what to keep, for a reader rendering with them.
- [Non-goals](docs/non-goals.md) lists what the package leaves out and why.

## Credits

- The signal engine follows the design of [@preact/signals-core](https://github.com/preactjs/signals) in its dependency graph, its glitch-free computed refresh, its run-on-write effects and its untracked `subscribe` callback.
- The `on()` helper follows [Solid](https://github.com/solidjs/solid)'s `on()`, and `untracked()` is Solid's `untrack()` under the name Preact gives it.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This project is built with care and follows security best practices, but it is intended for personal / self-hosted use. No guarantees of fitness for production environments. Use at your own risk.

This project was built with AI-assisted tooling using [Claude](https://claude.com), [GPT](https://openai.com), and [Kiro](https://kiro.dev). The human maintainer defines architecture, supervises implementation, and makes all final decisions.

## License

Apache-2.0. See [LICENSE](LICENSE).

Third-party attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
