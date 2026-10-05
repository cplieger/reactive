# Contributing to reactive

The [shared rules](https://github.com/cplieger/.github/blob/main/CONTRIBUTING.md) for commits, releases, synced files and checks apply here.

## Rules

- Build new reactive state on the engine in `src/signal.ts`, as `createStore`, `SignalMap` and `createCollection` are. A second subscriber list skips the engine's glitch-free updates, cycle detection and `batch` coalescing, and the engine's tests do not cover it.
- A change to what `src/index.ts` exports also updates the README `## API` list and the page for that group, `docs/signals.md` or `docs/dom.md`. No check compares those lists with the exports, so they drift unnoticed.
- A fix ported from `@preact/signals-core` lands with a regression test and keeps the deltas in the `src/signal.ts` header. Change the header's verified version only after you check every change in the newer release, because the next upstream comparison starts there.
