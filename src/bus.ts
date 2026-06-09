// bus.ts — typed event bus (discrete events, NOT reactive state).
//
// The deliberate counterpart to signals. A signal models continuous STATE:
// it has a current value you read and subscribe to. A bus models discrete
// EVENTS: fire-and-forget notifications with no retained value. Reach for a
// signal/Collection when "what is the current value?" makes sense; reach for
// the bus when "X just happened" does (navigation, "refresh requested",
// "escape pressed"). Mixing the two is the smell this split prevents.
//
// Handler sets are snapshot-cached: the iteration array is rebuilt only when
// the set is mutated, not on every emit, and a handler unsubscribed during an
// emit still fires for that emit (it was in the snapshot). No-payload events
// use `undefined` as their payload type.

/** Handler for a bus event. Events whose payload type is `undefined` take no
 *  argument. */
export type BusHandler<T> = T extends undefined ? () => void : (payload: T) => void;

/** A typed event bus over an event→payload map `M`. Methods are arrow-function
 *  properties (not method signatures) so consumers can safely destructure
 *  `const { on, emit } = bus` without unbound-`this` warnings. */
export interface Bus<M> {
  /** Subscribe to an event. Returns an unsubscribe function. */
  on: <K extends keyof M>(event: K, handler: BusHandler<M[K]>) => () => void;
  /** Subscribe for exactly one emit, then auto-unsubscribe. Returns an
   *  unsubscribe function (to cancel before it fires). */
  once: <K extends keyof M>(event: K, handler: BusHandler<M[K]>) => () => void;
  /** Remove a previously-registered handler (no-op if absent). */
  off: <K extends keyof M>(event: K, handler: BusHandler<M[K]>) => void;
  /** Emit an event. Events whose payload is `undefined` are emitted with no
   *  payload argument. */
  emit: <K extends keyof M>(
    ...args: M[K] extends undefined ? [event: K] : [event: K, payload: M[K]]
  ) => void;
  /** Remove all handlers for one event, or all handlers entirely. */
  clear: (event?: keyof M) => void;
}

type AnyHandler = (payload?: unknown) => void;

interface Slot {
  set: Set<AnyHandler>;
  snapshot: AnyHandler[];
  dirty: boolean;
}

/** Create a typed event bus. `onError` (default `console.error`) isolates a
 *  throwing handler so it can't break sibling handlers or the emitter. */
export function createBus<M>(options?: {
  onError?: (event: keyof M, err: unknown) => void;
}): Bus<M> {
  const slots = new Map<keyof M, Slot>();
  const onError =
    options?.onError ??
    ((event: keyof M, err: unknown): void => {
      console.error(`[bus] handler error for "${String(event)}":`, err);
    });

  function slotFor(event: keyof M): Slot {
    let slot = slots.get(event);
    if (slot === undefined) {
      slot = { set: new Set(), snapshot: [], dirty: false };
      slots.set(event, slot);
    }
    return slot;
  }

  function on<K extends keyof M>(event: K, handler: BusHandler<M[K]>): () => void {
    const slot = slotFor(event);
    slot.set.add(handler as AnyHandler);
    slot.dirty = true;
    return (): void => {
      off(event, handler);
    };
  }

  function off<K extends keyof M>(event: K, handler: BusHandler<M[K]>): void {
    const slot = slots.get(event);
    if (slot === undefined) {
      return;
    }
    if (slot.set.delete(handler as AnyHandler)) {
      slot.dirty = true;
    }
  }

  function once<K extends keyof M>(event: K, handler: BusHandler<M[K]>): () => void {
    const wrapped = ((payload?: unknown): void => {
      off(event, wrapped);
      (handler as AnyHandler)(payload);
    }) as BusHandler<M[K]>;
    return on(event, wrapped);
  }

  function emit<K extends keyof M>(
    ...args: M[K] extends undefined ? [event: K] : [event: K, payload: M[K]]
  ): void {
    const [event, payload] = args as [K, unknown];
    const slot = slots.get(event);
    if (slot === undefined) {
      return;
    }
    if (slot.dirty) {
      slot.snapshot = Array.from(slot.set);
      slot.dirty = false;
    }
    for (const handler of slot.snapshot) {
      try {
        handler(payload);
      } catch (err) {
        onError(event, err);
      }
    }
  }

  function clear(event?: keyof M): void {
    if (event === undefined) {
      slots.clear();
    } else {
      slots.delete(event);
    }
  }

  return { on, once, off, emit, clear };
}
