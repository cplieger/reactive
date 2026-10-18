import { describe, expect, it } from "vitest";

import { effect, SignalMap } from "./index.js";

interface Entity {
  readonly id: string;
  readonly rev: number;
}

describe("SignalMap equals", () => {
  it("notifies nothing for a write equal under equals, and notifies a change", () => {
    const map = new SignalMap<Entity>({ equals: (a, b) => a.rev === b.rev });
    const sig = map.ensure("a", { id: "a", rev: 1 });
    let runs = 0;
    const stop = effect(() => {
      void sig.value;
      runs++;
    });
    sig.value = { id: "a", rev: 1 };
    expect(runs).toBe(1);
    sig.value = { id: "a", rev: 2 };
    expect(runs).toBe(2);
    stop();
  });

  it("without equals a new object is a change", () => {
    const map = new SignalMap<Entity>();
    const sig = map.ensure("a", { id: "a", rev: 1 });
    let runs = 0;
    const stop = effect(() => {
      void sig.value;
      runs++;
    });
    sig.value = { id: "a", rev: 1 };
    expect(runs).toBe(2);
    stop();
  });
});
