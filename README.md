# reactive

> Signals + DOM-reconciliation micro-framework for TypeScript

A standalone reactive primitives library providing fine-grained signals with automatic dependency tracking, batched effects via MessageChannel scheduling, keyed-list DOM reconciliation, structural tree-diffing, and a typed per-key reactive store. Zero dependencies beyond the DOM API.

## Install

<!-- TODO: registry/pull link -->

TS: `npx jsr add @cplieger/reactive` or `npm i @cplieger/reactive`

## Usage

```typescript
import { signal, effect, batch, reconcile } from "@cplieger/reactive";

const count = signal(0);
effect(() => {
  console.log("count:", count.value);
});
batch(() => {
  count.value = 1;
  count.value = 2; // effect fires once with value 2
});
```

## API

- `signal<T>(initial): Signal<T>` — reactive value with `.value` getter/setter and `.peek()`
- `effect(fn): dispose` — auto-tracking side-effect with cleanup support
- `batch(fn)` — coalesce signal writes; effects flush via MessageChannel
- `flushSync()` — synchronously drain pending effects
- `setEffectErrorHandler(handler)` — global error handler for effects
- `reconcile(parent, items, spec)` — keyed-list DOM reconciliation
- `patch(parent, ...children)` — structural tree-diff
- `reconcileChildren(parent, newChildren)` — low-level child reconciliation
- `createStore<M>()` — typed per-key reactive store with effect/computed/batch

## License

GPL-3.0 — see [LICENSE](LICENSE).
