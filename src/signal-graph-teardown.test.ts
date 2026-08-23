// Reactive signal core — what teardown must not take with it.
//
// A signal's subscribers live in a doubly-linked list whose HEAD is the only
// entry point (`_targets`); every unlink therefore has two branches, and the
// head branch is the one no later walk can repair, because the `_prevTarget`
// pointers a later unlink trusts were rewritten when the head went away. Get
// either branch wrong and an unrelated effect that merely shares a signal with
// the one being torn down goes quiet — no error, no second chance, and only
// after a specific order of subscribe / dispose / drop.
//
// The same applies to the DISPOSED flag: once an effect has torn itself down,
// every later call on it has to be inert.
import { describe, it, expect } from "vitest";
import { effect, signal } from "./index.js";

describe("an effect that drops every dependency it had", () => {
  it("does not unsubscribe a later effect on the same signal when disposed", () => {
    const s = signal(0);
    let read = true;
    const dropped: number[] = [];
    // Runs once reading `s`, then re-runs reading nothing at all: its only
    // source node is both the head of `s`'s subscriber list and the head of its
    // own source list, so the re-run empties both from the front.
    const disposeDropped = effect(() => {
      if (read) {
        dropped.push(s.value);
      }
      return undefined;
    });
    read = false;
    s.value = 1;
    expect(dropped).toEqual([0]);

    const kept: number[] = [];
    effect(() => {
      kept.push(s.value);
      return undefined;
    });
    expect(kept).toEqual([1]);

    // The dropped effect owns nothing on `s` any more, so disposing it must be
    // a no-op for `s`'s current subscriber.
    disposeDropped();
    s.value = 2;

    expect(kept).toEqual([1, 2]);
    expect(dropped).toEqual([0]);
  });
});

describe("disposing the newest subscriber to a signal", () => {
  it("leaves a subscriber added afterwards reactive once an older one drops out", () => {
    const s = signal(0);
    const oldest: number[] = [];
    const middle: number[] = [];
    const newest: number[] = [];
    const late: number[] = [];
    let readMiddle = true;

    effect(() => {
      oldest.push(s.value);
      return undefined;
    });
    effect(() => {
      if (readMiddle) {
        middle.push(s.value);
      }
      return undefined;
    });
    // The newest subscriber is at the head of `s`'s list; `middle` sits directly
    // behind it, so `middle`'s own link to the head is the one disposal rewrites.
    const disposeNewest = effect(() => {
      newest.push(s.value);
      return undefined;
    });
    disposeNewest();

    // Subscribing after the disposal puts a live node in front of everything.
    effect(() => {
      late.push(s.value);
      return undefined;
    });

    readMiddle = false;
    s.value = 1; // `middle` re-runs and drops `s`
    s.value = 2;

    expect(oldest).toEqual([0, 1, 2]);
    expect(middle).toEqual([0]);
    expect(newest).toEqual([0]);
    expect(late).toEqual([0, 1, 2]);
  });
});

describe("an effect that disposes itself from its own body", () => {
  it("is inert afterwards: no further runs, and no cleanup from a second dispose", () => {
    const s = signal(0);
    const runs: number[] = [];
    const cleanups: number[] = [];
    let dispose: () => void = () => {
      // replaced by the real disposer below; the first run must not self-dispose
    };
    dispose = effect(() => {
      const v = s.value;
      runs.push(v);
      if (v === 1) {
        dispose();
      }
      return () => {
        cleanups.push(v);
      };
    });
    expect(runs).toEqual([0]);

    s.value = 1; // re-runs (cleanup for run 0), then disposes itself mid-body
    expect(runs).toEqual([0, 1]);
    expect(cleanups).toEqual([0]);

    // The self-disposing run still returned a cleanup, which the effect stored
    // after tearing itself down. Disposal already happened, so nothing may run
    // it — and no later write may wake the effect either.
    s.value = 2;
    dispose();
    dispose();

    expect(runs).toEqual([0, 1]);
    expect(cleanups).toEqual([0]);
  });
});
