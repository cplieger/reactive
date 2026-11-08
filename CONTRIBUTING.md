# Contributing to reactive

The [shared rules](https://github.com/cplieger/.github/blob/main/CONTRIBUTING.md) for commits, releases, synced files and checks apply here.

## Scope

The package holds state, rendering, requests and actions, and draws nothing. The actions module ships no notification display and no streaming transport. An app connects its own through `configure` and `configureTransport`, so a change that builds a toast, a widget or a default transport into `src/` is out of scope.

## Rules

- A subpath added, renamed or removed changes `exports` in both `package.json` and `jsr.json`, its `docs/` page, the README `## Subpaths` and `## API` lists, and `PURE` in `src/side-effects.node.test.ts`.
- An export, a `FetchConfig` setting, a `RequestOptions` field or a `/fetch` error code that changes also changes the README `## API` list and its `docs/` page table. No check compares them.
- No module touches the DOM or installs a listener at import, so `package.json` keeps `"sideEffects": false`. `src/side-effects.node.test.ts` bundles an effect-only import of every subpath and fails on any code left.
- Relative imports end in `.js`. Consumers type-check this source under `nodenext`, which rejects an extensionless import that the local `bundler` setting accepts.
- Module-level state under `src/actions/` needs a test-only reset that `resetActionFramework` in `src/actions/testing.ts` calls, and `src/actions/index.ts` never exports one. A missed reset leaks one test's setup into the next.
- Build new reactive state on the engine in `src/signal/signal.ts`, as `createStore`, `SignalMap` and `createCollection` are. A second subscriber list skips its glitch-free updates, cycle detection and `batch` coalescing.
- The engine ports [@preact/signals-core](https://github.com/preactjs/signals/tree/main/packages/core). Port an upstream fix with a regression test. The behaviour `docs/signals.md` states, the cycle guard in `endBatch`'s drain and the re-entrant drain depart from upstream on purpose.
- Upstream's batch snapshot for an A to B to A revert, its `globalVersion` skip and its `endBatch` rethrow stay out. No computed here unsubscribes from its sources, so `DIRTY` is complete, and `runEffect` isolates effect errors.
- Build DOM nodes with `el`, never with `innerHTML` or another HTML string, so caller text stays text and a page that enforces Trusted Types does not throw.
