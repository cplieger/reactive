# Contributing to reactive

The [shared rules](https://github.com/cplieger/.github/blob/main/CONTRIBUTING.md) for commits, releases, synced files and checks apply here.

## Rules

- Build new reactive state on the engine in `src/signal.ts`, as `createStore`, `SignalMap` and `createCollection` are. A second subscriber list skips the engine's glitch-free updates, cycle detection and `batch` coalescing, and the engine's tests do not cover it.
- A change to what `src/index.ts` exports also updates the README `## API` list and the page for that group, `docs/signals.md` or `docs/dom.md`. No check compares those lists with the exports, so they drift unnoticed.
- The graph and scheduler in `src/signal.ts` port [@preact/signals-core](https://github.com/preactjs/signals/tree/main/packages/core), last compared with version 1.14.4. Port an upstream engine fix with a regression test. Raise that version only after checking all of a newer release, because the next comparison starts there.
- Keep these deliberate deltas from upstream, each pinned by a test:
  - Equality is `Object.is`, so `NaN` equals `NaN`. Upstream compares with `!==`.
  - `signal` and `computed` take an `equals` option, or `equals: false`. Upstream has neither.
  - An effect that throws is isolated. Its error goes to `setEffectErrorHandler`'s handler and the other effects keep running. Upstream disposes the effect and rethrows.
  - The cycle guard lives in `endBatch`'s drain and un-notifies the chain it drops. Upstream guards only in the signal setter, before the write, so it never drops a chain.
  - The drain is re-entrant, so a write from inside an effect starts a nested drain. Upstream keeps one drain per outermost batch. A running effect that a nested drain reaches is marked to re-run once its run returns.
  - `createRoot`, `runWithOwner` and `resource` have no upstream counterpart.
- Leave out this upstream machinery, which the port does not need:
  - The `watched` and `unwatched` hooks, `createModel` and `action`.
  - The batch snapshot that skips an A to B to A revert.
  - The `globalVersion` fast skip in `refreshComputed`. This port never unsubscribes a computed from its sources, so `DIRTY` is a complete staleness signal. Upstream needs the epoch for a computed with no live edges.
  - The error capture and rethrow in `endBatch`. `runEffect` isolates effect errors, so nothing throws out of the drain.
