import { expect, it } from "vitest";

import * as reactive from "./index.js";

it("exports exactly the documented runtime surface, with no getOwner", () => {
  expect(Object.keys(reactive).sort()).toEqual(
    [
      "KEY_ATTR",
      "SignalMap",
      "batch",
      "bindList",
      "computed",
      "createBus",
      "createCollection",
      "createRoot",
      "createStore",
      "effect",
      "el",
      "isComputed",
      "isSignal",
      "on",
      "patch",
      "reconcile",
      "resource",
      "runWithOwner",
      "setEffectErrorHandler",
      "signal",
      "subscribe",
      "touch",
      "trackHandler",
      "untracked",
    ].sort(),
  );
});
