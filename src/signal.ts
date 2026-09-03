// Reactive signals: signal<T>, effect (with cleanup), batch, computed, untracked.
// Preact-style doubly-linked source/target edges, pull-based glitch-free refresh,
// per-node version fast-skip, bitfield flags.
// Apache-2.0.
//
// FLUSH MODEL — one phase, and the whole of it:
//   1. A write flushes. When `sig.value = x` returns, every effect that depends
//      on `sig` has already re-run. The setter opens an implicit batch, notifies,
//      and drains before it returns, so there is no pending-effect state a caller
//      can observe and no queue to drain.
//   2. `batch(fn)` is the only deferral. Writes inside it coalesce; effects are
//      held and run once, synchronously, when the OUTERMOST batch returns.
//   3. Deferral beyond that is the caller's. To get effects on a later task,
//      write on a later task (queueMicrotask, requestAnimationFrame). This module
//      owns no scheduler and offers no flush barrier, because it never holds work.
//
// Clause 3 is why there is no `flushSync()`. A flush barrier is the API a
// DEFERRED model owes its callers — Vue's `nextTick`, React's `flushSync` — and
// an eager one owes none. The export existed until v2.0.0, could never find work
// pending (endBatch drains the moment the depth reaches 0) and refused to act
// when work WAS pending (it returned early above depth 0), so it was a no-op from
// every position a caller could occupy; six mutants over its body were
// permanently unkillable, and 71 consumer call sites had never done anything.
// Anything reintroducing a barrier here is reintroducing that: the barrier is not
// the missing piece, clause 1 is.
//
// Port provenance: graph/scheduler semantics verified against
// @preact/signals-core@1.14.4 (drift audit 2026-07-17). The flush model above is
// upstream's, including the absence of a barrier: upstream documents the write
// contract in prose ("Changing a signal's value synchronously updates every
// computed and effect that depends on that signal") and its surface is
// signal/computed/effect/batch/untracked/createModel. Deliberate deltas from
// upstream, pinned by tests: Object.is equality incl. NaN (upstream:
// `!==`); custom `equals` / `equals: false` options (upstream has none);
// isolate-and-continue effect error policy via setEffectErrorHandler
// (upstream disposes-and-rethrows); the cycle guard lives in endBatch's drain
// and un-notifies the chain it drops (upstream guards ONLY in the signal
// setter, evaluated before the write, so it never drops a chain); and the drain
// is re-entrant — `if (--batchDepth > 0) return` lets a write from an effect
// body start a fresh drain, where upstream's `if (batchDepth > 1) return` plus
// a post-drain `batchDepth--` keeps one drain per outermost batch.
//
// Upstream machinery NOT ported by design:
//   - watched/unwatched hooks, createModel/action (1.13+);
//   - the 1.14.x batch-snapshot A->B->A revert optimization — the
//     version-monotonicity bug its first release carried
//     (preactjs/signals#947) never existed here;
//   - the `globalVersion` epoch fast-skip in refreshComputed. All three
//     refresh call sites pre-check DIRTY, and because this port never
//     unsubscribes a computed from its sources, notifyTargets always reaches
//     every dependent computed — so DIRTY is a complete staleness signal.
//     Upstream needs the epoch for computeds with no subscribers, which have
//     no live edges. Do NOT try to revive it by deleting the DIRTY pre-checks:
//     this refreshComputed has neither upstream's TRACKING shortcut nor its
//     internal needsToRecompute gate, so an epoch miss recomputes
//     unconditionally and six recompute-gating tests go red.
//   - upstream's endBatch error capture and rethrow. Effect errors are
//     isolated inside runEffect (see its contract below), so nothing can throw
//     out of the drain and there was never anything to capture.
//
// Re-audit on upstream releases: diff src/index.ts against this file's
// mechanisms and harvest engine-internal fixes (see CONTRIBUTING.md).

const SIGNAL_BRAND = Symbol("signal");
const COMPUTED_BRAND = Symbol("computed");

// --- Bitfield flags ---
const DIRTY = 1;
const RUNNING = 4;
const DISPOSED = 8;
const HAS_ERROR = 16;
const NOTIFIED = 64;

// --- Linked-list Node for source↔target edges ---
interface DepNode {
  _source: SourceNode;
  _prevSource: DepNode | undefined;
  _nextSource: DepNode | undefined;
  _target: TargetNode;
  _prevTarget: DepNode | undefined;
  _nextTarget: DepNode | undefined;
  _version: number;
  _rollbackNode: DepNode | undefined;
}

// Anything that can be depended on (signal or computed)
interface SourceNode {
  _value: unknown;
  _version: number;
  _node: DepNode | undefined;
  _targets: DepNode | undefined;
  _isComputed: boolean; // discriminator
}

// Anything that can depend on sources (computed or effect)
interface TargetNode {
  _flags: number;
  _sources: DepNode | undefined;
  _isComputed: boolean; // discriminator: true=computed, false=effect
}

// Computed is BOTH source and target (same object)
interface ComputedNode extends SourceNode, TargetNode {
  _isComputed: true;
  _fn: () => unknown;
  _equals: ((a: unknown, b: unknown) => boolean) | undefined;
}

interface EffectNode {
  _fn: (() => Cleanup) | undefined;
  _cleanup: Cleanup;
  _flags: number;
  _sources: DepNode | undefined;
  _nextBatchedEffect: EffectNode | undefined;
  _isComputed: false;
}

// --- Globals ---
let evalContext: TargetNode | undefined;
let batchDepth = 0;
let batchedEffect: EffectNode | undefined;
let batchIteration = 0;

// Max effect-scheduling passes within one endBatch before assuming a cyclic
// effect-write loop and bailing with "Cycle detected".
const MAX_BATCH_ITERATIONS = 100;

// --- Effect error handler ---
/** Cleanup function returned by an effect callback, called before re-execution or disposal. */
export type Cleanup = undefined | (() => void);

/** Handler invoked when an effect throws an error. */
export type EffectErrorHandler = (error: unknown) => void;
let effectErrorHandler: EffectErrorHandler = (e) => {
  console.error("effect error:", e);
};

function safeCallHandler(e: unknown): void {
  try {
    effectErrorHandler(e);
  } catch {
    // swallow
  }
}

/** Set a global error handler for effect errors. Returns the previous handler. */
export function setEffectErrorHandler(handler: EffectErrorHandler): EffectErrorHandler {
  const prev = effectErrorHandler;
  effectErrorHandler = handler;
  return prev;
}

// --- Dependency tracking ---
function addDependency(source: SourceNode): DepNode | undefined {
  if (evalContext === undefined) {
    return undefined;
  }
  let node = source._node;
  if (node?._target !== evalContext) {
    // Create a new node
    node = {
      _version: 0,
      _source: source,
      _prevSource: undefined,
      _nextSource: undefined,
      _target: evalContext,
      _prevTarget: undefined,
      _nextTarget: undefined,
      _rollbackNode: source._node, // F3: save for rollback
    };

    // Link into target's sources (prepend)
    const evalSources = evalContext._sources;
    if (evalSources !== undefined) {
      evalSources._prevSource = node;
    }
    node._nextSource = evalSources;
    evalContext._sources = node;

    // Link into source's targets (prepend)
    const sourceTargets = source._targets;
    if (sourceTargets !== undefined) {
      sourceTargets._prevTarget = node;
    }
    node._nextTarget = sourceTargets;
    source._targets = node;

    source._node = node;
    return node;
  } else if (node._version === -1) {
    // Recycle existing node
    node._version = 0;

    // Move to head of sources if not already there
    if (node._prevSource !== undefined) {
      node._prevSource._nextSource = node._nextSource;
      if (node._nextSource !== undefined) {
        node._nextSource._prevSource = node._prevSource;
      }
      node._prevSource = undefined;
      const evalSources = evalContext._sources;
      if (evalSources !== undefined) {
        evalSources._prevSource = node;
      }
      node._nextSource = evalSources;
      evalContext._sources = node;
    }
    return node;
  }
  return undefined;
}

// --- Source preparation/cleanup for eval cycle ---
function prepareSources(target: TargetNode): void {
  let node = target._sources;
  while (node !== undefined) {
    const rollback = node._source._node;
    if (rollback !== undefined) {
      node._rollbackNode = rollback;
    }
    node._source._node = node;
    node._version = -1;
    node = node._nextSource;
  }
}

function cleanupSources(target: TargetNode): void {
  let node = target._sources;
  let head = target._sources;
  while (node !== undefined) {
    const next = node._nextSource;
    if (node._version === -1) {
      // Not re-used — unlink from source's targets
      if (node._prevTarget !== undefined) {
        node._prevTarget._nextTarget = node._nextTarget;
      } else {
        node._source._targets = node._nextTarget;
      }
      if (node._nextTarget !== undefined) {
        node._nextTarget._prevTarget = node._prevTarget;
      }
      // Remove from target's sources
      if (node._prevSource !== undefined) {
        node._prevSource._nextSource = node._nextSource;
      } else {
        head = node._nextSource;
      }
      if (node._nextSource !== undefined) {
        node._nextSource._prevSource = node._prevSource;
      }
      // Restore rollback
      node._source._node = node._rollbackNode;
      node._rollbackNode = undefined;
    } else {
      // Kept — restore rollback pointer (F3)
      node._source._node = node._rollbackNode;
      node._rollbackNode = undefined;
    }
    node = next;
  }
  target._sources = head;
}

// --- Notification propagation ---
function notifyTargets(source: SourceNode): void {
  let node = source._targets;
  while (node !== undefined) {
    const target = node._target;
    if (target._isComputed) {
      // It's a ComputedNode
      if (target._flags & RUNNING) {
        // A source written while this computed is mid-evaluation. Mark it stale
        // so the next read re-runs it — every refresh call site pre-checks
        // DIRTY, so without this the computed serves its pre-write value
        // forever — but do NOT recurse: its own version has not moved yet, and
        // recursing out of a RUNNING node is how a notify ping-pong is built.
        //
        // This repairs the PULL side only, deliberately. Two limits the next
        // reader should not have to rediscover: (1) the computed's own
        // subscribers are not woken here, so an effect that depends on it will
        // not re-run until something else notifies it; (2) a computed that
        // writes its own source unconditionally costs one extra recompute per
        // read, and inside an effect it degrades into the documented
        // MAX_BATCH_ITERATIONS "Cycle detected" path rather than hanging.
        target._flags |= DIRTY;
      } else if (!(target._flags & NOTIFIED)) {
        target._flags |= DIRTY | NOTIFIED;
        notifyTargets(target as unknown as SourceNode);
        target._flags &= ~NOTIFIED;
      }
    } else {
      // It's an EffectNode
      if (!(target._flags & NOTIFIED)) {
        target._flags |= NOTIFIED;
        const eff = target as unknown as EffectNode;
        eff._nextBatchedEffect = batchedEffect;
        batchedEffect = eff;
      }
    }
    node = node._nextTarget;
  }
}

// --- Staleness check ---
function needsToRecompute(target: TargetNode): boolean {
  let node = target._sources;
  while (node !== undefined) {
    const source = node._source;
    if (source._isComputed) {
      const comp = source as unknown as ComputedNode;
      if (comp._flags & DIRTY) {
        refreshComputed(comp);
      }
      if (comp._flags & HAS_ERROR) {
        return true;
      }
    }
    if (source._version !== node._version) {
      return true;
    }
    node = node._nextSource;
  }
  return false;
}

// --- Computed refresh (pull-based, depth-first) ---
function refreshComputed(comp: ComputedNode): void {
  if (comp._flags & RUNNING) {
    throw new Error("Cycle detected");
  }

  const prevContext = evalContext;
  evalContext = comp;
  const prevFlags = comp._flags;
  comp._flags = RUNNING;

  prepareSources(comp);

  let newValue: unknown;
  let fnThrew = false;
  try {
    newValue = comp._fn();
  } catch (err: unknown) {
    // PATH A: fn() threw — cache the error
    fnThrew = true;
    comp._value = err;
    comp._flags = HAS_ERROR;
    comp._version++;
    // Keep old deps (version=-1 nodes) so computed retries when sources change.
    let sn = comp._sources;
    while (sn !== undefined) {
      if (sn._version === -1) {
        sn._version = 0;
      }
      sn = sn._nextSource;
    }
  } finally {
    evalContext = prevContext;
    cleanupSources(comp);
    if (!fnThrew) {
      comp._flags = comp._flags & ~RUNNING;
    }
  }

  // PATH B: fn() succeeded — compare with equals() (F2: separate try/catch)
  if (!fnThrew) {
    const oldHadError = prevFlags & HAS_ERROR;
    let changed: boolean;

    if (oldHadError || comp._version === 0) {
      changed = true;
    } else {
      try {
        const eq = comp._equals;
        changed = eq ? !eq(comp._value, newValue) : !Object.is(comp._value, newValue);
      } catch {
        // equals() threw — treat as changed (F2: successful value NOT poisoned)
        changed = true;
      }
    }

    if (changed) {
      comp._value = newValue;
      comp._flags &= ~HAS_ERROR;
      comp._version++;
    } else {
      comp._flags &= ~HAS_ERROR;
    }
  }
}

// --- Batch / Effect scheduling ---
function startBatch(): void {
  batchDepth++;
}

function endBatch(): void {
  if (--batchDepth > 0) {
    return;
  }
  // The drain is re-entrant: a write or a batch() from an effect body sees
  // batchDepth back at 0 and starts a nested drain, and the cycle guard below
  // counts on those nested passes — a two-effect ping-pong recurses one level per
  // pass rather than looping here. So a nested drain must RESTORE the count it
  // inherited instead of zeroing it: zeroing let any nested drain, including an
  // empty `batch(() => {})`, wipe the passes the enclosing drain had accumulated
  // and multiply the effective cap.
  const enclosingIteration = batchIteration;
  while (batchedEffect !== undefined) {
    let eff: EffectNode | undefined = batchedEffect;
    batchedEffect = undefined;
    batchIteration++;
    if (batchIteration > MAX_BATCH_ITERATIONS) {
      batchIteration = enclosingIteration;
      // Un-notify the chain we are dropping: notifyTargets skips a NOTIFIED
      // effect, so an effect left NOTIFIED here could never be queued again —
      // bailing would silently deafen every effect in flight, including
      // bystanders that merely share a signal with the cycling one.
      let drop: EffectNode | undefined = eff;
      while (drop !== undefined) {
        const nextDrop: EffectNode | undefined = drop._nextBatchedEffect;
        drop._nextBatchedEffect = undefined;
        drop._flags &= ~NOTIFIED;
        drop = nextDrop;
      }
      throw new Error("Cycle detected");
    }
    while (eff !== undefined) {
      const next: EffectNode | undefined = eff._nextBatchedEffect;
      eff._nextBatchedEffect = undefined;
      eff._flags &= ~NOTIFIED;
      if (!(eff._flags & DISPOSED) && needsToRecompute(eff)) {
        runEffect(eff);
      }
      eff = next;
    }
  }
  batchIteration = enclosingIteration;
}

function runCleanup(eff: EffectNode): void {
  if (eff._cleanup) {
    const c = eff._cleanup;
    eff._cleanup = undefined;
    const prevContext = evalContext;
    evalContext = undefined;
    try {
      c();
    } catch (e) {
      safeCallHandler(e);
    } finally {
      evalContext = prevContext;
    }
  }
}

// Contract: runEffect NEVER throws, and both callers depend on it.
// Its body and its cleanup each route to safeCallHandler, which swallows even a
// throwing handler; everything else here is a pointer walk over a well-formed
// list. endBatch's drain and the effect() factory therefore call it bare. A
// throw escaping this function would abandon the rest of the queued chain
// mid-drain — the same shape of failure as the cycle bail's NOTIFIED leak. If
// you add a statement here that can throw, wrap it HERE, not at the call sites.
function runEffect(eff: EffectNode): void {
  // Run cleanup first (untracked)
  runCleanup(eff);

  // Track dependencies
  const prevContext = evalContext;
  evalContext = eff;
  prepareSources(eff);

  try {
    if (eff._fn) {
      eff._cleanup = eff._fn();
    }
  } catch (e) {
    safeCallHandler(e);
  } finally {
    evalContext = prevContext;
    cleanupSources(eff);
  }
}

function disposeEffect(eff: EffectNode): void {
  // Run cleanup (untracked)
  runCleanup(eff);

  // Unsubscribe from all sources
  let node = eff._sources;
  while (node !== undefined) {
    const next = node._nextSource;
    if (node._prevTarget !== undefined) {
      node._prevTarget._nextTarget = node._nextTarget;
    } else {
      node._source._targets = node._nextTarget;
    }
    if (node._nextTarget !== undefined) {
      node._nextTarget._prevTarget = node._prevTarget;
    }
    node._source._node = node._rollbackNode;
    node = next;
  }
  eff._sources = undefined;
  // F5: null closures for GC
  eff._fn = undefined;
  eff._cleanup = undefined;
  eff._flags |= DISPOSED;
}

// --- Public API ---

/** Options for configuring signal equality semantics. */
export interface SignalOptions<T> {
  equals?: false | ((prev: T, next: T) => boolean);
}

/** A reactive signal holding a mutable value that notifies subscribers on change. */
export interface Signal<T> {
  value: T;
  peek(): T;
}

/** A read-only reactive signal (e.g. from computed). */
export interface ReadonlySignal<T> {
  readonly value: T;
  peek(): T;
}

/** Create a reactive signal with an initial value. Reads are tracked; writes notify subscribers. */
export function signal<T>(initial: T, options?: SignalOptions<T>): Signal<T> {
  const eq = options?.equals;
  const node: SourceNode = {
    _value: initial,
    _version: 0,
    _node: undefined,
    _targets: undefined,
    _isComputed: false,
  };

  const s = {
    [SIGNAL_BRAND]: true,
    get value(): T {
      const dep = addDependency(node);
      if (dep !== undefined) {
        dep._version = node._version;
      }
      return node._value as T;
    },
    set value(v: T) {
      if (eq === false ? false : eq ? eq(node._value as T, v) : Object.is(node._value, v)) {
        return;
      }
      node._value = v;
      node._version++;
      startBatch();
      try {
        notifyTargets(node);
      } finally {
        endBatch();
      }
    },
    peek(): T {
      return node._value as T;
    },
  };
  return s;
}

/** Lazy cached derived signal with equality dedup (glitch-free). */
export function computed<T>(fn: () => T, options?: SignalOptions<T>): ReadonlySignal<T> {
  const eq = options?.equals;
  const node: ComputedNode = {
    // SourceNode fields
    _value: undefined,
    _version: 0,
    _node: undefined,
    _targets: undefined,
    _isComputed: true,
    // TargetNode fields
    _flags: DIRTY,
    _sources: undefined,
    // ComputedNode-specific fields
    _fn: fn,
    _equals:
      eq === false ? () => false : eq ? (a: unknown, b: unknown) => eq(a as T, b as T) : undefined,
  };

  const c = {
    [COMPUTED_BRAND]: true,
    get value(): T {
      // Cycle detection
      if (node._flags & RUNNING) {
        throw new Error("Cycle detected");
      }
      // Refresh before tracking (pull-based glitch-free)
      if (node._flags & DIRTY) {
        refreshComputed(node);
      }
      const dep = addDependency(node);
      if (dep !== undefined) {
        dep._version = node._version;
      }
      if (node._flags & HAS_ERROR) {
        throw node._value;
      }
      return node._value as T;
    },
    set value(_v: T) {
      throw new Error("Cannot set a computed signal");
    },
    peek(): T {
      // F6: refresh WITHOUT tracking
      if (node._flags & DIRTY) {
        const prevContext = evalContext;
        evalContext = undefined;
        try {
          refreshComputed(node);
        } finally {
          evalContext = prevContext;
        }
      }
      if (node._flags & HAS_ERROR) {
        throw node._value;
      }
      return node._value as T;
    },
  };
  return c;
}

/** Create a reactive effect that re-runs when its tracked signals change. Returns a dispose function. */
export function effect(fn: () => Cleanup): () => void {
  const eff: EffectNode = {
    _fn: fn,
    _cleanup: undefined,
    _flags: 0,
    _sources: undefined,
    _nextBatchedEffect: undefined,
    _isComputed: false,
  };

  // Run immediately
  runEffect(eff);

  return () => {
    if (eff._flags & DISPOSED) {
      return;
    }
    disposeEffect(eff);
  };
}

/** Coalesce signal writes; effects flush synchronously at end of outermost batch.
 *  This is the library's ONLY deferral: see the flush model in the module header. */
export function batch(fn: () => void): void {
  startBatch();
  try {
    fn();
  } finally {
    endBatch();
  }
}

/** Run fn without tracking any signal reads. */
export function untracked<T>(fn: () => T): T {
  const prev = evalContext;
  evalContext = undefined;
  try {
    return fn();
  } finally {
    evalContext = prev;
  }
}

/** Read a signal for its tracking effect alone, discarding the value.
 *
 *  The complement of `peek()`: `peek` reads without subscribing, `touch`
 *  subscribes without keeping. Outside a reactive scope it does nothing
 *  observable.
 *
 *  This exists because the two-tier shape `createCollection` and `bindList` are
 *  built on produces it: a scope reads per-entity values through `signalFor`,
 *  so it must depend on the structure signal separately to re-run when the id
 *  set changes, and that dependency has no value the body wants. Spelling it as
 *  a discarded expression left the intent to a comment, and `undefined` entries
 *  are accepted so a per-key lookup that may miss (`signalFor(id)`,
 *  `SignalMap.get(id)`) can be passed straight in.
 *
 *  Not a substitute for `on()`, which declares an exhaustive dependency list
 *  and runs its body untracked. `touch` ADDS a dependency and leaves every
 *  other read in the scope tracked as usual. */
export function touch(
  ...signals: readonly (Signal<unknown> | ReadonlySignal<unknown> | undefined)[]
): void {
  for (const sig of signals) {
    readForDependency(sig);
  }
}

// Named so the read is a call rather than a discarded expression: the value is
// deliberately unused, and returning it is what keeps that legible.
function readForDependency(sig: Signal<unknown> | ReadonlySignal<unknown> | undefined): unknown {
  return sig?.value;
}

/** Subscribe to a signal, calling cb on every change. Returns dispose function.
 *  The callback runs untracked: reading other signals inside it does not add
 *  them as dependencies of the subscription (matches upstream
 *  preactjs/signals#188 semantics). */
export function subscribe<T>(
  sig: Signal<T> | ReadonlySignal<T>,
  cb: (value: T) => void,
): () => void {
  return effect(() => {
    const value = sig.value;
    untracked(() => {
      cb(value);
    });
    return undefined;
  });
}

/** Type guard: returns true if value is a Signal created by signal(). */
export function isSignal(value: unknown): value is Signal<unknown> {
  return value !== null && typeof value === "object" && SIGNAL_BRAND in value;
}

/** Type guard: returns true if value is a computed ReadonlySignal. */
export function isComputed(value: unknown): value is ReadonlySignal<unknown> {
  return value !== null && typeof value === "object" && COMPUTED_BRAND in value;
}

/** Explicit dependency declaration helper. Mirrors Solid's on().
 *
 * Overloaded so the return type and the `value`/`prev` parameter types stay
 * tight:
 *   - Without `defer` (or `{ defer: false }`) the accessor always returns `U`;
 *     only the `{ defer: true | boolean }` form widens to `U | undefined`
 *     (the deferred first call yields `undefined`).
 *   - A single accessor `() => T` correlates `value`/`prev` to `T`; an array of
 *     accessors correlates them to `unknown[]`. */
// Single accessor, non-deferred (or explicit `{ defer: false }`): never undefined.
export function on<T, U>(
  deps: () => T,
  fn: (value: T, prev: T | undefined, prevResult: U | undefined) => U,
  options?: { defer?: false },
): () => U;
// Single accessor, deferred: first call returns undefined.
export function on<T, U>(
  deps: () => T,
  fn: (value: T, prev: T | undefined, prevResult: U | undefined) => U,
  options: { defer: boolean },
): () => U | undefined;
// Array of accessors, non-deferred (or explicit `{ defer: false }`): never undefined.
export function on<U>(
  deps: (() => unknown)[],
  fn: (value: unknown[], prev: unknown[] | undefined, prevResult: U | undefined) => U,
  options?: { defer?: false },
): () => U;
// Array of accessors, deferred: first call returns undefined.
export function on<U>(
  deps: (() => unknown)[],
  fn: (value: unknown[], prev: unknown[] | undefined, prevResult: U | undefined) => U,
  options: { defer: boolean },
): () => U | undefined;
export function on<T, U>(
  deps: (() => T) | (() => unknown)[],
  fn: (value: T | unknown[], prev: T | unknown[] | undefined, prevResult: U | undefined) => U,
  options?: { defer?: boolean },
): () => U | undefined {
  let prevInput: T | unknown[] | undefined;
  let prevResult: U | undefined;
  let first = true;
  return () => {
    const input: T | unknown[] = Array.isArray(deps) ? deps.map((d) => d()) : deps();
    if (first && options?.defer) {
      first = false;
      prevInput = input;
      return undefined;
    }
    const result = untracked(() => fn(input, prevInput, prevResult));
    prevInput = input;
    prevResult = result;
    first = false;
    return result;
  };
}
