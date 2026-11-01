// Signal engine: preact-style linked edges, pull-based glitch-free refresh.
// User contract: docs/signals.md; upstream deltas: CONTRIBUTING.md. Invariants:
// - A write flushes: when the setter returns, every dependent effect has run,
//   except those still running, which are never interrupted; each one whose
//   current run had already read the written signal re-runs once it returns.
// - batch() is the only deferral; its effects run when the outermost returns.
// - The drain is re-entrant: a write inside an effect starts a nested drain.

const SIGNAL_BRAND = Symbol("signal");
const COMPUTED_BRAND = Symbol("computed");

// --- Bitfield flags ---
const DIRTY = 1;
const RUNNING = 4;
const DISPOSED = 8;
const HAS_ERROR = 16;
const RERUN = 32;
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
  _owner: OwnerNode | undefined;
  _scope: OwnerNode | undefined;
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

// --- Ownership ---
const OPEN = 0;
const CLOSING = 1;
const CLOSED = 2;

let currentOwner: OwnerNode | undefined;

/** A disposal scope made by `createRoot`. Effects and roots created while it is
 *  current are disposed with it. */
export interface Owner {
  /** Aborted when the owner is disposed, after its children and callbacks. */
  readonly signal: AbortSignal;
  /** Run `fn` when the owner is disposed, after its children, in reverse
   *  registration order. On an owner already being disposed, or disposed, `fn`
   *  runs at once. A throw goes to the effect error handler. */
  onDispose(fn: () => void): void;
}

class OwnerNode implements Owner {
  _state = OPEN;
  _parent: OwnerNode | undefined;
  _children: Set<OwnerNode | EffectNode> | undefined;
  _callbacks: (() => void)[] | undefined;
  // Created on first read: every run of an owned effect makes a scope, and
  // few of them are ever asked for a signal.
  _controller: AbortController | undefined;

  constructor(parent: OwnerNode | undefined) {
    this._parent = parent;
    parent?._adopt(this);
  }

  get signal(): AbortSignal {
    if (this._controller === undefined) {
      this._controller = new AbortController();
      if (this._state === CLOSED) {
        this._controller.abort();
      }
    }
    return this._controller.signal;
  }

  onDispose(fn: () => void): void {
    if (this._state === OPEN) {
      (this._callbacks ??= []).push(fn);
      return;
    }
    runLateDisposeCallback(this, fn);
  }

  _adopt(child: OwnerNode | EffectNode): void {
    (this._children ??= new Set()).add(child);
  }
}

function assertOpen(owner: OwnerNode | undefined, what: string): void {
  if (owner !== undefined && owner._state !== OPEN) {
    throw new Error(`reactive: cannot create ${what} under an owner that is being disposed`);
  }
}

function ownerNode(owner: Owner): OwnerNode {
  if (owner instanceof OwnerNode) {
    return owner;
  }
  throw new TypeError("reactive: not an owner made by createRoot");
}

function runDisposeCallback(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    safeCallHandler(e);
  }
}

function runLateDisposeCallback(owner: OwnerNode, fn: () => void): void {
  const prevOwner = currentOwner;
  const prevContext = evalContext;
  currentOwner = owner;
  evalContext = undefined;
  runDisposeCallback(fn);
  currentOwner = prevOwner;
  evalContext = prevContext;
}

function disposeOwner(owner: OwnerNode): void {
  if (owner._state === OPEN) {
    markClosing(owner);
    teardownOwner(owner);
  }
}

// The whole subtree is marked before anything is torn down, so a write made by
// a cleanup or callback mid-walk cannot re-run an effect of this subtree: the
// drain skips DISPOSED effects.
function markClosing(owner: OwnerNode): void {
  owner._state = CLOSING;
  if (owner._children === undefined) {
    return;
  }
  for (const child of owner._children) {
    if (child instanceof OwnerNode) {
      markClosing(child);
    } else {
      child._flags |= DISPOSED;
      if (child._scope !== undefined) {
        markClosing(child._scope);
      }
    }
  }
}

// Invariant: nothing in this walk throws (callbacks are isolated, effect
// teardown never throws), so the context restore and the abort need no finally.
function teardownOwner(owner: OwnerNode): void {
  owner._parent?._children?.delete(owner);
  owner._parent = undefined;
  const prevOwner = currentOwner;
  const prevContext = evalContext;
  currentOwner = owner;
  evalContext = undefined;
  const children = owner._children;
  owner._children = undefined;
  if (children !== undefined) {
    for (const child of [...children].reverse()) {
      if (child instanceof OwnerNode) {
        teardownOwner(child);
      } else {
        releaseEffect(child);
      }
    }
  }
  const callbacks = owner._callbacks;
  owner._callbacks = undefined;
  if (callbacks !== undefined) {
    for (const fn of callbacks.reverse()) {
      runDisposeCallback(fn);
    }
  }
  currentOwner = prevOwner;
  evalContext = prevContext;
  owner._controller?.abort();
  owner._state = CLOSED;
}

/** @internal The current owner, for a primitive that refuses to exist without
 *  one. Throws outside any owner, or under one being disposed. */
export function requireOwner(what: string): Owner {
  if (currentOwner === undefined) {
    throw new Error(`reactive: cannot create ${what} outside an owner`);
  }
  assertOpen(currentOwner, what);
  return currentOwner;
}

/** @internal `createRoot` with an explicit parent, for `bindList`'s rows. */
export function createRootUnder<T>(
  parent: Owner | undefined,
  fn: (dispose: () => void, owner: Owner) => T,
): T {
  const parentNode = parent === undefined ? undefined : ownerNode(parent);
  assertOpen(parentNode, "a root");
  const owner = new OwnerNode(parentNode);
  const prevOwner = currentOwner;
  const prevContext = evalContext;
  currentOwner = owner;
  evalContext = undefined;
  try {
    return fn(() => {
      disposeOwner(owner);
    }, owner);
  } catch (e) {
    disposeOwner(owner);
    throw e;
  } finally {
    currentOwner = prevOwner;
    evalContext = prevContext;
  }
}

/** Run `fn` untracked in a new owner, child of the current one when there is
 *  one, and return its result. Effects and roots created inside are disposed by
 *  `dispose`, or with the parent. A throw from `fn` disposes the root and
 *  rethrows. Throws when the current owner is being disposed. */
export function createRoot<T>(fn: (dispose: () => void, owner: Owner) => T): T {
  return createRootUnder(currentOwner, fn);
}

/** Run `fn` untracked with `owner` current, so what it creates is owned by
 *  `owner`. Returns `undefined` without calling `fn` once `owner` is being
 *  disposed or is disposed. Throws a TypeError for an object `createRoot` did
 *  not make. */
export function runWithOwner<T>(owner: Owner, fn: () => T): T | undefined {
  const node = ownerNode(owner);
  if (node._state !== OPEN) {
    return undefined;
  }
  const prevOwner = currentOwner;
  const prevContext = evalContext;
  currentOwner = node;
  evalContext = undefined;
  try {
    return fn();
  } finally {
    currentOwner = prevOwner;
    evalContext = prevContext;
  }
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
        // A source written while this computed is mid-evaluation: mark it DIRTY
        // so the next read recomputes (refresh callers check DIRTY first), but
        // do not recurse: its version has not moved, and recursing out of a
        // RUNNING node builds a notify ping-pong. Pull side only: its subscribers
        // are not woken here, and a computed writing its own source costs one
        // extra recompute per read, ending in the MAX_BATCH_ITERATIONS "Cycle
        // detected" path inside an effect rather than hanging.
        target._flags |= DIRTY;
      } else if (!(target._flags & NOTIFIED)) {
        target._flags |= DIRTY | NOTIFIED;
        notifyTargets(target as unknown as SourceNode);
        target._flags &= ~NOTIFIED;
      }
    } else {
      // It's an EffectNode. A running one, from its previous run's teardown to
      // the end of its body, is never queued: a nested drain re-entering it
      // would overwrite the scope and cleanup of the run still on the stack,
      // so runEffect re-queues it once that run returns.
      if (target._flags & RUNNING) {
        target._flags |= RERUN;
      } else if (!(target._flags & NOTIFIED)) {
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
// Callers check DIRTY first: there is no epoch fast-skip or staleness gate in
// here, so a call on a clean computed recomputes it.
function refreshComputed(comp: ComputedNode): void {
  if (comp._flags & RUNNING) {
    throw new Error("Cycle detected");
  }

  const prevContext = evalContext;
  const prevOwner = currentOwner;
  evalContext = comp;
  // A computed runs whenever it is read, so the reader's owner says nothing
  // about it: what it creates is unowned.
  currentOwner = undefined;
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
    currentOwner = prevOwner;
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

// `scope` is the disposed scope of the run being cleaned up, current during
// the cleanup so an effect or root created there throws instead of escaping.
function runCleanup(eff: EffectNode, scope: OwnerNode | undefined): void {
  if (eff._cleanup) {
    const c = eff._cleanup;
    eff._cleanup = undefined;
    const prevContext = evalContext;
    const prevOwner = currentOwner;
    evalContext = undefined;
    currentOwner = scope;
    try {
      c();
    } catch (e) {
      safeCallHandler(e);
    } finally {
      evalContext = prevContext;
      currentOwner = prevOwner;
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
  // Set before the previous run's teardown, so a write from its cleanup or
  // disposal callbacks finds this effect RUNNING (see notifyTargets).
  eff._flags |= RUNNING;
  const prevScope = eff._scope;
  if (prevScope !== undefined) {
    eff._scope = undefined;
    disposeOwner(prevScope);
  }
  runCleanup(eff, prevScope);

  // Track dependencies
  const prevContext = evalContext;
  const prevOwner = currentOwner;
  const scope = eff._owner === undefined ? undefined : new OwnerNode(undefined);
  eff._scope = scope;
  evalContext = eff;
  currentOwner = scope;
  prepareSources(eff);

  try {
    if (eff._fn) {
      eff._cleanup = eff._fn();
    }
  } catch (e) {
    safeCallHandler(e);
  } finally {
    eff._flags &= ~RUNNING;
    evalContext = prevContext;
    currentOwner = prevOwner;
    cleanupSources(eff);
  }
  if (eff._flags & DISPOSED) {
    // Disposed during its own run, alone or with its owner. The cleanup this
    // run returned runs now, like a late onDispose, with the run's closed
    // scope current; the edges the rest of the run made are dropped.
    runCleanup(eff, scope);
    releaseEffect(eff);
  } else if (eff._flags & RERUN) {
    eff._flags &= ~RERUN;
    eff._flags |= NOTIFIED;
    eff._nextBatchedEffect = batchedEffect;
    batchedEffect = eff;
    // Inside a batch this only queues it. Otherwise it drains now, one level
    // deeper, so a self-write loop still meets the cycle cap, whose throw is
    // routed here because this function never throws.
    startBatch();
    try {
      endBatch();
    } catch (e) {
      safeCallHandler(e);
    }
  }
}

// Disposes the run's scope first, then the cleanup, then the subscriptions.
// The caller has already marked the scope closing. Idempotent, and never
// throws: teardownOwner's walk relies on it.
function releaseEffect(eff: EffectNode): void {
  eff._flags |= DISPOSED;
  eff._owner?._children?.delete(eff);
  eff._owner = undefined;
  const scope = eff._scope;
  eff._scope = undefined;
  if (scope !== undefined) {
    teardownOwner(scope);
  }
  runCleanup(eff, scope);

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

/** Create a reactive effect that re-runs when its tracked signals change.
 *  Returns a dispose function. Under an owner the effect is disposed with it,
 *  and each run owns the effects and roots it creates, disposed before the next
 *  run. Throws when the current owner is being disposed. */
export function effect(fn: () => Cleanup): () => void {
  const owner = currentOwner;
  assertOpen(owner, "an effect");
  const eff: EffectNode = {
    _fn: fn,
    _cleanup: undefined,
    _flags: 0,
    _sources: undefined,
    _nextBatchedEffect: undefined,
    _isComputed: false,
    _owner: owner,
    _scope: undefined,
  };
  owner?._adopt(eff);

  // Run immediately
  runEffect(eff);

  // releaseEffect is idempotent, so a second dispose needs no guard.
  return () => {
    if (eff._scope !== undefined) {
      markClosing(eff._scope);
    }
    releaseEffect(eff);
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

/** Read signals for their tracking alone, discarding the values: `peek` reads
 *  without subscribing, `touch` subscribes without keeping. Outside a reactive
 *  scope it does nothing observable. A scope reading per-entity values through
 *  `signalFor` uses it to also re-run when the id set changes. `undefined`
 *  entries are skipped, so a lookup that may miss (`signalFor(id)`,
 *  `SignalMap.get(id)`) can be passed straight in. Unlike `on()`, it adds a
 *  dependency and leaves the scope's other reads tracked. */
export function touch(
  ...signals: readonly (Signal<unknown> | ReadonlySignal<unknown> | undefined)[]
): void {
  for (const sig of signals) {
    readForDependency(sig);
  }
}

// deadset:ignore DS1803 -- returning the value keeps the tracking read from being a discarded expression; typescript-eslint rejects void on a property read
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

/** Explicit dependency declaration helper, like Solid's `on()`. Without `defer`
 *  (or with `{ defer: false }`) the accessor returns `U`; `{ defer: true |
 *  boolean }` widens it to `U | undefined`, since the deferred first call yields
 *  `undefined`. A single accessor `() => T` types `value` and `prev` as `T`; an
 *  array of accessors types them as `unknown[]`. */
// Single accessor, non-deferred (or explicit `{ defer: false }`): never undefined.
export function on<T, U>(
  deps: () => T,
  fn: (value: T, prev: T | undefined, prevResult: U | undefined) => U,
  options?: { defer?: false },
): () => U;
/** Single accessor, deferred: the first call returns undefined. A `defer`
 *  typed as `boolean` selects this overload even when the value is `false`,
 *  because the type cannot rule the deferred call out; pass a literal
 *  `false` (or omit `options`) to keep the non-undefined return. */
export function on<T, U>(
  deps: () => T,
  fn: (value: T, prev: T | undefined, prevResult: U | undefined) => U,
  options: { defer: boolean },
): () => U | undefined;
/** Array of accessors, non-deferred (or explicit `{ defer: false }`): never
 *  undefined. `value` and `prev` are the accessors' results in declaration
 *  order, typed `unknown[]` — a heterogeneous list is not correlated
 *  positionally, so narrow each element before use. */
export function on<U>(
  deps: (() => unknown)[],
  fn: (value: unknown[], prev: unknown[] | undefined, prevResult: U | undefined) => U,
  options?: { defer?: false },
): () => U;
/** Array of accessors, deferred: the first call returns undefined, having read
 *  every accessor to seed `prev`. Same `boolean`-widening caveat as the single
 *  deferred overload. */
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
