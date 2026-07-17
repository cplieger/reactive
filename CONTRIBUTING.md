# Contributing to reactive

`@cplieger/reactive` is a zero-dependency TypeScript reactivity +
DOM-reconciliation library, published as TS source to both npm and JSR. This
guide covers the architecture, the local workflow, and the conventions a
contributor needs; org-wide defaults are inherited from
[cplieger/.github](https://github.com/cplieger/.github).

## Architecture

There is **one** reactivity engine, in `src/signal.ts`: Preact-style
doubly-linked source/target edges, pull-based glitch-free refresh, a global
epoch plus per-node version fast-skip, and bitfield flags. Everything else is a
thin facade or a consumer of that engine — do not introduce a second
implementation.

- `signal.ts` — the engine: `signal`, `computed`, `effect`, `batch`,
  `flushSync`, `untracked`, `on`, `subscribe`, the `isSignal`/`isComputed`
  guards, and `setEffectErrorHandler`.
- `store.ts` (`createStore`) and `signal-map.ts` (`SignalMap`) — facades over
  the engine. `createStore` lazily backs each fixed key with a signal;
  `SignalMap` is a dynamic per-id signal registry. Because they sit on the one
  engine, they inherit glitch-freedom and cycle detection.
- `collection.ts` (`createCollection`) — an ordered keyed collection built on
  `signal` + `SignalMap`. Two tiers: per-entity signals plus one structure
  signal (`ids`).
- `bind-list.ts` (`bindList`) — the two-tier list-to-DOM binding. One
  structural effect tracks `source.ids` and reconciles the row list; each row
  owns an isolated effect tracking only its own entity signal.
- `el.ts` (`el`) — CSP-safe element factory. String children become text nodes
  (never parsed as HTML).
- `reconcile.ts` (`reconcile`, `KEY_ATTR`) and `reconcile-tree.ts` (`patch`,
  `reconcileChildren`, `trackHandler`) — keyed-list reconciliation and
  structural tree-diffing.
- `bus.ts` (`createBus`) — the typed event primitive. State lives in signals;
  discrete events go on the bus.

The public API is whatever `src/index.ts` re-exports — that file is the
contract. Update it deliberately, and keep the README API section in sync.

### Correctness invariants (protect these)

The dependency-tracking core carries guarantees that tests pin down: the five
[correctness guarantees](README.md#correctness-guarantees) documented in the
README. Don't regress these when touching `signal.ts`.

### Unsupported by design

The README's ["Unsupported by Design" table](README.md#design-decisions--unsupported-by-design)
is a **contract**, not a backlog: those deliberate non-goals are a design
discussion before they are a PR.

### Upstream drift audits

`src/signal.ts` is a deliberate re-derivation of the `@preact/signals-core`
graph/scheduler mechanism with documented semantic deltas (the header of
`signal.ts` records the pinned baseline version, the deltas, and the upstream
machinery intentionally not ported). The engine takes no dependency on
upstream; instead, on new upstream releases, run a drift audit:

1. Fetch the release source (`https://unpkg.com/@preact/signals-core@<ver>/src/index.ts`)
   and its `CHANGELOG.md`.
2. Triage changelog entries: engine-internal **fixes** (dependency graph,
   scheduling, disposal, tracking) are harvest candidates; features that map
   to the README's Unsupported-by-Design table (models, watchers, actions)
   are not; fixes to machinery this port never adopted don't apply.
3. Port applicable fixes with a regression test each, preserving this
   library's deltas (`Object.is`, `equals` options, error isolation).
4. Update the provenance baseline in the `signal.ts` header.

Last audit: 2026-07-17 against 1.14.4 — harvested untracked `subscribe`
callbacks (upstream #188); confirmed the 1.14.x batch-snapshot machinery and
its #947 fix don't apply (never ported).

## Local development

Requires Node and npm. Install dependencies, then run the checks:

```sh
npm ci
npm run typecheck          # tsc -p tsconfig.json (source only)
npm run typecheck:tests    # tsc -p tsconfig.tests.json (includes *.test.ts)
npm test                   # vitest --run
npx eslint .               # strict typed-linting (eslint.config.mjs)
npx prettier --check .     # formatting (printWidth 100)
```

The `typecheck` scripts run `tsc`, the TypeScript 7 native compiler. It comes
from the `@typescript/native` devDependency (an npm alias for `typescript@7`),
which `npm ci` places at `node_modules/.bin/tsc` — no separate install step.
(The `typescript` devDependency is aliased to `@typescript/typescript6`, the TS
6.x API `typescript-eslint` needs; its bin is `tsc6`, so it never shadows the
native `tsc`.)

There is **no build step** — the package ships TypeScript source (`exports`
points at `./src/index.ts`), so `npm run typecheck` is what stands in for a
compile. CI runs the same battery centrally via
[cplieger/ci](https://github.com/cplieger/ci); running the commands above
locally reproduces it.

### Conventions and gotchas

- **ESM only.** Use `.js` extensions in relative imports (e.g.
  `from "./signal.js"`) even though the files are `.ts` — that is how
  `index.ts` and the rest of `src/` are written, and it is required for the
  TS-source publish to resolve.
- **Strict TypeScript.** `tsconfig.json` enables `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, and
  `isolatedModules`, among others. Expect the compiler to be pedantic.
- **Lint is strict-type-checked.** `no-explicit-any` is an error, `eqeqeq` is
  enforced, and types must be imported with inline `import type`. Test files
  get relaxed rules (see the config); production code does not.
- **Tests live beside source** as `*.test.ts`, with property-based suites in
  `*.property.test.ts` (via `fast-check`). The signal-engine suites
  (`signal*.test.ts` and `signal.property.test.ts`) deliberately probe the
  invariants above; if you change the engine, run them and add cases rather
  than weakening them.
- **DOM tests** run under `happy-dom` (configured in `vitest.config.ts`), so
  DOM globals are available in tests without a browser.

## Publishing

Releases are automated. A push to `main` triggers the central release pipeline,
which computes the version from commit history with git-cliff and publishes to
npm and JSR. Per `cliff.toml`, releases follow standard semver: `feat` bumps minor,
breaking changes bump major, and `chore`/`ci`/`docs`/`style`/`test`/`fuzz`/
`lint` commits do not cut a release. The published version is derived from the
git tag at release time, so the `version` field in `package.json` / `jsr.json`
is only a baseline; do not bump it by hand.

## Commits and PRs

Branch from `main`, keep changes focused with tests, and open a PR. Commit
messages follow [Conventional Commits](https://www.conventionalcommits.org/) —
git-cliff parses them for the changelog and version bump, so write the subject
as the changelog line you want (`feat: add prepend to collections`,
`fix: dedup diamond updates in computed`).

## Conduct & security

By participating you agree to the
[Code of Conduct](https://github.com/cplieger/.github/blob/main/CODE_OF_CONDUCT.md).
Report security issues through the
[security policy](https://github.com/cplieger/.github/blob/main/SECURITY.md) —
never in a public issue.
