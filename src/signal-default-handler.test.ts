// Reactive signal core — the built-in effect error handler. This file must be
// the only place that observes it, and must not install one of its own:
// setEffectErrorHandler() replaces module state, so the default is only
// observable while nothing has swapped it out.
import { describe, it, expect, vi } from "vitest";
import { effect } from "./index.js";

describe("default effect error handler", () => {
  it("reports an effect body error to console.error", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      effect(() => {
        throw new Error("body-boom");
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith("effect error:", expect.any(Error));
    } finally {
      logged.mockRestore();
    }
  });
});
