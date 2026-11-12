import { describe, it, expect } from "vitest";

import { SignalMap } from "./signal-map.js";
import { effect } from "./signal.js";

describe("SignalMap", () => {
  it("get returns undefined before ensure, the signal after", () => {
    expect.assertions(3);
    const m = new SignalMap<number>();
    expect(m.get("a")).toBeUndefined();
    const s = m.ensure("a", 1);
    expect(m.get("a")).toBe(s);
    expect(s.value).toBe(1);
  });

  it("ensure is idempotent — same signal, initial ignored on re-ensure", () => {
    expect.assertions(2);
    const m = new SignalMap<number>();
    const a = m.ensure("k", 1);
    const b = m.ensure("k", 99);
    expect(b).toBe(a);
    expect(a.value).toBe(1);
  });

  it("entries are reactive — effects track per id", () => {
    expect.assertions(1);
    const m = new SignalMap<string>();
    const s = m.ensure("msg", "");
    const seen: string[] = [];
    effect(() => {
      seen.push(s.value);
    });
    s.value = "hello";
    s.value = "world";
    expect(seen).toEqual(["", "hello", "world"]);
  });

  it("clear drops one id; ensure after clear makes a fresh signal", () => {
    expect.assertions(3);
    const m = new SignalMap<number>();
    const a = m.ensure("k", 1);
    m.clear("k");
    expect(m.get("k")).toBeUndefined();
    const b = m.ensure("k", 2);
    expect(b).not.toBe(a);
    expect(b.value).toBe(2);
  });

  it("clearAll drops every id", () => {
    expect.assertions(2);
    const m = new SignalMap<number>();
    m.ensure("a", 1);
    m.ensure("b", 2);
    m.clearAll();
    expect(m.get("a")).toBeUndefined();
    expect(m.get("b")).toBeUndefined();
  });
});
