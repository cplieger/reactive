# Third-party notices

No third-party code is included in this repository. The signal engine is a re-derivation of an upstream design, not a copy of its source, so no license text is reproduced here.

Two designs are followed:

- The dependency graph and the scheduler in `src/signal.ts` follow [@preact/signals-core](https://github.com/preactjs/signals) (MIT): the doubly-linked source and target edge nodes (`DepNode`, `SourceNode` and `TargetNode`), the pull-based glitch-free `refreshComputed`, the eager drain in `endBatch`, and the untracked `subscribe` callback (upstream `preactjs/signals#188`). The baseline is `@preact/signals-core@1.14.4`. `CONTRIBUTING.md` lists every deliberate delta from it and the upstream machinery this engine does not carry.
- The explicit dependency helper `on()` in `src/signal.ts` follows [solid-js](https://github.com/solidjs/solid) (MIT), whose `on()` has the same deps-plus-body shape. `untracked()` is Solid's `untrack()` under the name Preact gives it.
