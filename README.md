# reactive

[![npm](https://img.shields.io/npm/v/@cplieger/reactive)](https://www.npmjs.com/package/@cplieger/reactive) [![JSR](https://jsr.io/badges/@cplieger/reactive)](https://jsr.io/@cplieger/reactive) [![Mutation (TS)](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/reactive/badges/mutation-ts.json)](https://github.com/cplieger/reactive/issues?q=label%3Astryker-tracker)

`@cplieger/reactive` lets you build a TypeScript browser app without a framework, from signals, keyed DOM rendering, typed JSON requests and server actions.

It replaces the change listeners, list re-renders, `try`/`catch` blocks and loading flags you would otherwise write between state, the server and the page. It has no runtime dependencies and ships as ESM-only TypeScript source, so it needs a bundler or runtime that compiles TypeScript 6 or later. It ships no widgets, icons or stylesheets; those are in [`@cplieger/ui`](https://github.com/cplieger/ui). It is licensed under Apache-2.0.

## Why use it

`@cplieger/reactive` is built for apps that draw their interface with plain DOM code.

- A signal write runs every effect that depends on it before it returns, and every subpath shares that one signal graph.
- `createCollection` and `bindList` render a keyed list: a changed item repaints only its row, and a reorder keeps the existing rows.
- `el` builds elements without HTML strings, and `patch` updates a subtree in place, so focus and scroll position survive a re-render.
- Requests never throw, and actions add optimistic updates, rollback and retry for failures you mark as transient.
- No subpath touches the DOM at import, so each one loads under Node, Deno, Bun or Workers.

Consider [Solid](https://github.com/solidjs/solid) if you want components, JSX and server-side rendering. Consider [TanStack Query](https://tanstack.com/query/latest) if you also need a server-state cache.

## Install

```sh
npx jsr add @cplieger/reactive
# or
npm i @cplieger/reactive
```

## Usage

A signal holds a value, and an effect re-runs when what it read changes. `el` builds the elements:

```typescript
import { effect, el, signal } from "@cplieger/reactive";

const count = signal(0);
const label = el("output");
const button = el("button", { onclick: () => count.value++ }, "Add one");
document.body.append(button, label);

effect(() => {
  label.textContent = `Clicked ${count.value} times`;
});
```

Connect your notifications to the actions once at startup, then define each action at module scope and dispatch it from your event handlers:

```typescript
import { apiAction, configure, retryNetwork } from "@cplieger/reactive/actions";

// Your app's own notifications, such as @cplieger/ui's toasts.
configure({ success: notifySuccess, error: notifyError });

const deleteItem = apiAction<string>({
  name: "items.delete",
  request: (id) => ({ method: "DELETE", path: `/api/items/${id}` }),
  error: "Could not delete the item",
  retryable: retryNetwork,
  retry: { count: 2, delay: 300 },
});

await deleteItem.dispatch("item-1"); // the result, or null after the error notification
```

To call a JSON API directly, create one instance per backend and branch on the result:

```typescript
import { createFetch } from "@cplieger/reactive/fetch";

const api = createFetch({ baseUrl: "https://api.example.com/v1" });

const res = await api.apiGetRaw<{ name: string }>("/users/me");
if (res.ok) console.log(res.data.name);
else console.error(res.status, res.code, res.error);
```

## Subpaths

Import each part from its own subpath. Code that imports these from `@cplieger/ui` 1.x moves by the table in [Moving to reactive 2.4](docs/migrating.md).

| Import from | What it holds |
| --- | --- |
| `@cplieger/reactive` | everything in `/signal` and `/dom` |
| `@cplieger/reactive/signal` | signals, computed values, effects, owners, resources, stores, collections and the event bus |
| `@cplieger/reactive/dom` | `el`, `reconcile`, `bindList`, `patch` and `trackHandler` |
| `@cplieger/reactive/fetch` | typed JSON requests |
| `@cplieger/reactive/actions` | server actions |
| `@cplieger/reactive/actions/testing` | `resetActionFramework` for tests |

`package.json` sets `"sideEffects": false`, so a bundler drops every subpath you do not import.

## API

- Signals, from `/signal` or the root: `signal`, `computed`, `effect`, `batch`, `untracked`, `touch`, `on`, `subscribe`, `isSignal`, `isComputed`, `setEffectErrorHandler`, `createRoot`, `runWithOwner` and `resource`.
- State, from `/signal` or the root: `createStore`, `SignalMap`, `createCollection` and `createBus`.
- DOM, from `/dom` or the root: `el`, `reconcile`, `KEY_ATTR`, `bindList`, `patch` and `trackHandler`.
- Requests, from `/fetch`: `createFetch` with its `apiGet`, `apiPost`, `apiPut`, `apiPatch` and `apiDelete` helpers, `withTimeout` and `API_TIMEOUT_MS`.
- Actions, from `/actions`: `configure`, `configureApi`, `configureTransport`, `defineAction`, `apiAction`, `transportAction`, the errors and retry policy `ActionError`, `hasErrorString`, `classifyFetchError`, `retryNetwork` and `RETRY_STANDARD`, the idempotency names `IDEMPOTENCY_HEADER` and `IDEMPOTENCY_COMMAND_FIELD`, the helpers `debouncedDispatch`, `pollAction`, `pollUntil`, `bindLoadingState`, `withAsyncFeedback` and `registerCleanup`, and the state reads `isPending`, `pendingCount`, `subscribeToActions`, `subscribeByName` and `getActionLog`.

The full reference, generated from the doc comments, is on [JSR](https://jsr.io/@cplieger/reactive/doc).

## A write runs its effects before it returns

When `count.value = 1` returns, every effect that depends on `count` has already run, so the next line reads the DOM those effects wrote. There is no queue and no pending state to wait for.

`batch(fn)` is the only way to defer. Writes inside it coalesce, and the held effects run once, synchronously, when the outermost batch returns, even when the body throws. To run effects on a later task, make the write on a later task. [Signals, stores and collections](docs/signals.md) has the full rules.

## Server text is untrusted

- With an absolute `baseUrl`, a request path cannot reach another origin. Without one, the path goes to `fetch()` unchanged, so never build a whole path from untrusted text.
- An error message can carry text from the server's response. Your `configure` adapter renders it as text, never as HTML.
- A failed response's `body` and `code` come from the server. Check their shape and the `status` before you act on them.
- Set `sensitive: true` on an action whose arguments or result carry a secret, a token or personal data, so the action log keeps none of them.

[Base URLs and untrusted responses](docs/security-model.md) and [Sensitive actions](docs/lifecycle.md#sensitive-actions) cover each rule.

## Unsupported by design

- The signal and DOM modules leave out ownership outside a root, an `onMount` lifecycle, server-side rendering, Suspense, a custom scheduler, a flush barrier such as `flushSync`, and controlled form inputs. [What the signal and DOM modules leave out](docs/signal-non-goals.md) gives the reasons.
- The fetch module leaves out retries, interceptor chains, response caching, global settings and streamed responses. [What the fetch module leaves out](docs/fetch-non-goals.md) gives the reasons.
- The actions module leaves out a query cache, framework adapters, a throttle helper and batch dispatch. [What the actions module leaves out](docs/actions-non-goals.md) gives the reasons.

## Documentation

- [Signals, stores and collections](docs/signals.md) and [Building and updating the DOM](docs/dom.md) give the exact rules of `/signal` and `/dom`.
- [Results and errors](docs/results.md), [Requests, timeouts and runtimes](docs/requests.md) and [Base URLs and untrusted responses](docs/security-model.md) cover `/fetch`.
- [Dispatch lifecycle](docs/lifecycle.md), [HTTP and streaming actions](docs/http.md) and [UI and polling helpers](docs/helpers.md) cover `/actions`.
- [Moving to reactive 2.4](docs/migrating.md) maps each import from `@cplieger/ui` 1.x and lists what changed since reactive 2.3.

## Credits

- The signal engine follows the design of [@preact/signals-core](https://github.com/preactjs/signals) in its dependency graph, its glitch-free computed refresh, its run-on-write effects and its untracked `subscribe` callback.
- The `on()` helper follows [Solid](https://github.com/solidjs/solid)'s `on()`, and `untracked()` is Solid's `untrack()` under the name Preact gives it. `createRoot`, `runWithOwner` and owned nested effects follow Solid's ownership model.
- `onSuccess`, `onError` and `onSettled` follow TanStack Query's mutation callbacks, and `configureApi` follows RTK Query's `fetchBaseQuery`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This project is built with care and follows security best practices, but it is intended for personal / self-hosted use. No guarantees of fitness for production environments. Use at your own risk.

This project was built with AI assistance. The human maintainer defines architecture, supervises implementation, and makes all final decisions.

## License

Apache-2.0. See [LICENSE](LICENSE).

Third-party attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
