# Non-goals

This page lists what reactive leaves out on purpose, with the reason for each. It is for a developer deciding whether the package fits, or about to propose one of these as a feature.

- An effect ownership tree, or `createRoot`. You manage disposal yourself, and ownership would change the mental model.
- Automatic disposal of nested effects. Each effect is independent and returns its own dispose function, so compose them with arrays or helper functions.
- Lazy activation, or an `onMount` lifecycle. Signals are always active, and managing resources is the caller's job.
- `Signal.subtle.Watcher`, or notify-on-dirty. This package is the framework layer, and a watcher is for frameworks built on a bare signals primitive.
- Introspection APIs. They are a developer-tools concern and are not needed in production.
- Explicit disposal of a computed. A computed is garbage-collected once nothing references it.
- Server-side rendering, or per-request isolation. This is a client-side library. On a server, create a fresh signal graph per request.
- Async signals and resources. Load async data with an effect and plain signal writes.
- Transactions. They are a framework-level concern, not a signals primitive.
- A custom scheduler, or `setScheduler()`. A write flushes before it returns and `batch` is synchronous, so there is no queue to schedule. To defer, write on a later task.
- A flush barrier, such as `flushSync` or `nextTick`. A barrier is what a deferred model owes its callers. This model never holds work, so a barrier would have nothing to report.
- Controlled form inputs. See the section below.
- Waking the subscribers of a computed that writes a signal it reads. See the section below.

## Controlled form inputs

`patch()` syncs the live `checked`, `selected` and `value` properties of an input, an option or a textarea, so the render owns them. It does not route changes back or own the field's state. A view that re-renders while a user types must therefore own that field itself, by driving it from an effect. [Updating a subtree with patch](dom.md#updating-a-subtree-with-patch) gives the detail.

## A computed that writes a signal it reads

Such a computed is re-read correctly, because the write marks it stale and the next read runs it again. Its own subscribers are not woken, though, so an effect that depends on it does not re-run until something else notifies that effect. Writing a source from a computed body is outside the intended shape, so do that write in an effect.
