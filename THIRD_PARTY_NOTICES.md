# Third-party notices

No third-party code is included in this repository. The signal engine is a re-derivation of an upstream design, not a copy of its source, so no license text is reproduced here.

Two designs are followed, each named at the line of ours that follows it:

- The dependency graph and the scheduler in `src/signal.ts` follow [@preact/signals-core](https://github.com/preactjs/signals) (MIT): the doubly-linked source/target edge nodes (`DepNode`, `SourceNode`, `TargetNode` at `src/signal.ts:75-100`), the pull-based glitch-free `refreshComputed` (`src/signal.ts:327`), the eager drain in `endBatch` (`src/signal.ts:397`), and the untracked `subscribe` callback (`src/signal.ts:711`, upstream `preactjs/signals#188`). The pinned baseline is `@preact/signals-core@1.14.4`; the header of `src/signal.ts` records every deliberate delta from it and the upstream machinery this engine does not carry, and `CONTRIBUTING.md` records the drift-audit procedure.
- The explicit dependency helper `on()` (`src/signal.ts:734`) follows [solid-js](https://github.com/solidjs/solid) (MIT), whose `on()` has the same deps-plus-body shape; `untracked()` (`src/signal.ts:666`) is Solid's `untrack()` under the name Preact gives it.
