import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computed,
  createRoot,
  effect,
  runWithOwner,
  setEffectErrorHandler,
  signal,
  type EffectErrorHandler,
  type Owner,
} from "./index.js";

let errors: unknown[];
let previousHandler: EffectErrorHandler;

beforeEach(() => {
  errors = [];
  previousHandler = setEffectErrorHandler((e) => {
    errors.push(e);
  });
});

afterEach(() => {
  setEffectErrorHandler(previousHandler);
});

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

describe("a disposed owner refuses re-entry", () => {
  it("runWithOwner from the owner's own disposal callback does not call fn", () => {
    let called = false;
    let result: unknown = "unset";
    createRoot((dispose, owner) => {
      owner.onDispose(() => {
        result = runWithOwner(owner, () => {
          called = true;
          return "ran";
        });
      });
      dispose();
    });
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it("runWithOwner from a microtask queued before disposal does not call fn", async () => {
    let called = false;
    let result: unknown = "unset";
    const done = createRoot((dispose, owner) => {
      const queued = new Promise<void>((resolve) => {
        queueMicrotask(() => {
          result = runWithOwner(owner, () => {
            called = true;
            return "ran";
          });
          resolve();
        });
      });
      dispose();
      return queued;
    });
    await done;
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it("an effect created inside a disposal callback throws to the error handler", () => {
    let ran = false;
    createRoot((dispose, owner) => {
      owner.onDispose(() => {
        effect(() => {
          ran = true;
        });
      });
      dispose();
    });
    expect(ran).toBe(false);
    expect(errors.map(messageOf)).toEqual([
      "reactive: cannot create an effect under an owner that is being disposed",
    ]);
  });

  it("a root created inside a disposal callback throws to the error handler", () => {
    let ran = false;
    createRoot((dispose, owner) => {
      owner.onDispose(() => {
        createRoot(() => {
          ran = true;
        });
      });
      dispose();
    });
    expect(ran).toBe(false);
    expect(errors.map(messageOf)).toEqual([
      "reactive: cannot create a root under an owner that is being disposed",
    ]);
  });

  it("onDispose on a disposed owner runs at once", () => {
    const owner = createRoot((dispose, o) => {
      dispose();
      return o;
    });
    const log: string[] = [];
    owner.onDispose(() => {
      log.push("late");
    });
    expect(log).toEqual(["late"]);
  });

  it("onDispose on an owner being disposed runs at once, inside the callback", () => {
    const log: string[] = [];
    createRoot((dispose, owner) => {
      owner.onDispose(() => {
        log.push("outer start");
        owner.onDispose(() => {
          log.push("inner");
        });
        log.push("outer end");
      });
      dispose();
    });
    expect(log).toEqual(["outer start", "inner", "outer end"]);
  });

  it("an onDispose callback that runs at once on a disposed owner routes its throw", () => {
    const owner = createRoot((dispose, o) => {
      dispose();
      return o;
    });
    const boom = new Error("late boom");
    owner.onDispose(() => {
      throw boom;
    });
    expect(errors).toEqual([boom]);
  });

  it("runWithOwner refuses an object createRoot did not make", () => {
    const fake: Owner = { signal: new AbortController().signal, onDispose: () => undefined };
    expect(() => runWithOwner(fake, () => 1)).toThrow(TypeError);
  });
});

describe("disposal order", () => {
  it("disposes children first, then callbacks in reverse, then aborts the signal", () => {
    const log: string[] = [];
    createRoot((dispose, owner) => {
      owner.onDispose(() => log.push("callback A"));
      createRoot((_d, child) => {
        child.onDispose(() => log.push("child root"));
      });
      effect(() => () => {
        log.push("effect cleanup");
      });
      owner.onDispose(() => log.push("callback B"));
      owner.signal.addEventListener("abort", () => log.push("abort"));
      dispose();
    });
    expect(log).toEqual(["effect cleanup", "child root", "callback B", "callback A", "abort"]);
  });

  it("runs each callback once when dispose is called twice", () => {
    let runs = 0;
    createRoot((dispose, owner) => {
      owner.onDispose(() => runs++);
      dispose();
      dispose();
    });
    expect(runs).toBe(1);
  });

  it("aborts a signal read before disposal, and hands an aborted one after", () => {
    const { early, owner } = createRoot((dispose, o) => {
      const s = o.signal;
      expect(s.aborted).toBe(false);
      dispose();
      return { early: s, owner: o };
    });
    expect(early.aborted).toBe(true);
    expect(owner.signal.aborted).toBe(true);
    expect(owner.signal).toBe(owner.signal);
  });

  it("a signal first read inside a disposal callback is aborted by the end", () => {
    let seen: AbortSignal | undefined;
    createRoot((dispose, owner) => {
      owner.onDispose(() => {
        seen = owner.signal;
        expect(seen.aborted).toBe(false);
      });
      dispose();
    });
    expect(seen?.aborted).toBe(true);
  });

  it("a parent effect re-run 100 times leaves one live child effect", () => {
    const parent = signal(0);
    const child = signal(0);
    let childRuns = 0;
    createRoot(() => {
      effect(() => {
        void parent.value;
        effect(() => {
          void child.value;
          childRuns++;
        });
      });
    });
    for (let i = 1; i <= 100; i++) {
      parent.value = i;
    }
    childRuns = 0;
    child.value = 1;
    expect(childRuns).toBe(1);
  });

  it("disposes a child root with its parent, and a child disposed first is not re-run", () => {
    const log: string[] = [];
    createRoot((dispose) => {
      const disposeChild = createRoot((d, child) => {
        child.onDispose(() => log.push("first child"));
        return d;
      });
      createRoot((_d, child) => {
        child.onDispose(() => log.push("second child"));
      });
      disposeChild();
      dispose();
    });
    expect(log).toEqual(["first child", "second child"]);
  });

  it("a write made by a cleanup mid-disposal re-runs no effect of the subtree", () => {
    const s = signal(0);
    const runs: number[] = [];
    createRoot((dispose) => {
      effect(() => {
        runs.push(s.value);
      });
      createRoot(() => {
        effect(() => () => {
          s.value = 1;
        });
      });
      dispose();
    });
    expect(s.peek()).toBe(1);
    expect(runs).toEqual([0]);
  });

  it("a write by a cleanup mid-disposal re-runs no effect in a child root or a run's scope", () => {
    const s = signal(0);
    const runs: string[] = [];
    createRoot((dispose) => {
      createRoot(() => {
        effect(() => {
          runs.push(`child root ${String(s.value)}`);
        });
      });
      effect(() => {
        effect(() => {
          runs.push(`run scope ${String(s.value)}`);
        });
      });
      effect(() => () => {
        s.value = 1;
      });
      dispose();
    });
    expect(s.peek()).toBe(1);
    expect(runs).toEqual(["child root 0", "run scope 0"]);
  });

  it("disposing an owned effect disposes what its run created, without re-running it", () => {
    const s = signal(0);
    const runs: number[] = [];
    let childCleanups = 0;
    createRoot(() => {
      const disposeParent = effect(() => {
        effect(() => {
          runs.push(s.value);
          return () => {
            childCleanups++;
          };
        });
        effect(() => () => {
          s.value = 1;
        });
      });
      disposeParent();
    });
    s.value = 2;
    expect(runs).toEqual([0]);
    expect(childCleanups).toBe(1);
  });

  it("dispose called again from a disposal callback does not cut the disposal short", () => {
    const seen: boolean[] = [];
    const owner = createRoot((dispose, o) => {
      o.onDispose(() => {
        seen.push(o.signal.aborted);
      });
      o.onDispose(() => {
        dispose();
      });
      dispose();
      return o;
    });
    expect(seen).toEqual([false]);
    expect(owner.signal.aborted).toBe(true);
  });

  it("a cleanup of an owned effect cannot create an effect", () => {
    const s = signal(0);
    let leaked = 0;
    createRoot(() => {
      effect(() => {
        void s.value;
        return () => {
          effect(() => {
            leaked++;
          });
        };
      });
    });
    s.value = 1;
    expect(leaked).toBe(0);
    expect(errors.map(messageOf)).toEqual([
      "reactive: cannot create an effect under an owner that is being disposed",
    ]);
  });

  it("an effect disposing its own root mid-run stays inert", () => {
    const route = signal("a");
    const other = signal(0);
    const runs: string[] = [];
    let cleanups = 0;
    createRoot((dispose) => {
      effect(() => {
        const r = route.value;
        runs.push(r);
        if (r === "b") {
          dispose();
        }
        void other.value;
        return () => {
          cleanups++;
        };
      });
    });
    route.value = "b";
    expect(cleanups).toBe(2);
    other.value = 1;
    route.value = "c";
    expect(runs).toEqual(["a", "b"]);
    expect(cleanups).toBe(2);
  });

  it("the cleanup a run returns after disposing its own root runs at once", () => {
    const target = new EventTarget();
    let heard = 0;
    createRoot((dispose) => {
      effect(() => {
        const listener = (): void => {
          heard++;
        };
        target.addEventListener("ping", listener);
        dispose();
        return () => {
          target.removeEventListener("ping", listener);
        };
      });
    });
    target.dispatchEvent(new Event("ping"));
    expect(heard).toBe(0);
  });

  it("that cleanup runs with the run's closed scope current", () => {
    const route = signal("a");
    createRoot((dispose) => {
      effect(() => {
        const r = route.value;
        if (r === "b") {
          dispose();
        }
        return () => {
          if (r === "b") {
            effect(() => undefined);
          }
        };
      });
    });
    route.value = "b";
    expect(errors.map(messageOf)).toContain(
      "reactive: cannot create an effect under an owner that is being disposed",
    );
  });
});

describe("an owned effect writing a signal it read", () => {
  it("finishes its run before re-running, so its scope stays open", () => {
    const page = signal(5);
    const childRuns: number[] = [];
    let live = 0;
    createRoot(() => {
      effect(() => {
        if (page.value > 3) {
          page.value = 3;
        }
        const p = page.peek();
        effect(() => {
          live++;
          childRuns.push(p);
          return () => {
            live--;
          };
        });
      });
    });
    expect(errors).toEqual([]);
    expect(childRuns).toEqual([3, 3]);
    expect(live).toBe(1);
  });

  it("the run's cleanup is never dropped by its own re-run", () => {
    const s = signal(0);
    let acquired = 0;
    let released = 0;
    const dispose = createRoot((d) => {
      effect(() => {
        acquired++;
        if (s.value < 3) {
          s.value = s.value + 1;
        }
        return () => {
          released++;
        };
      });
      return d;
    });
    expect(acquired).toBe(4);
    expect(released).toBe(3);
    dispose();
    expect(released).toBe(4);
  });
});

describe("a write made while an owned effect tears down its previous run", () => {
  it("from its own cleanup leaves no child effect outliving the root", () => {
    const s = signal(0);
    let acquired = 0;
    let released = 0;
    let live = 0;
    const dispose = createRoot((d) => {
      effect(() => {
        const v = s.value;
        acquired++;
        effect(() => {
          live++;
          return () => {
            live--;
          };
        });
        return () => {
          released++;
          if (v === 1) {
            s.value = 2;
          }
        };
      });
      return d;
    });
    s.value = 1;
    s.value = 5;
    expect(errors).toEqual([]);
    expect(s.peek()).toBe(2);
    expect(live).toBe(1);
    dispose();
    expect(live).toBe(0);
    expect(released).toBe(acquired);
  });

  it("from a child effect's cleanup leaves no child effect outliving the root", () => {
    const t = signal(0);
    let parentRuns = 0;
    let live = 0;
    const dispose = createRoot((d) => {
      effect(() => {
        parentRuns++;
        const v = t.value;
        effect(() => {
          live++;
          return () => {
            live--;
            if (v === 1) {
              t.value = 0;
            }
          };
        });
      });
      return d;
    });
    t.value = 1;
    t.value = 2;
    expect(errors).toEqual([]);
    expect(t.peek()).toBe(0);
    expect(parentRuns).toBe(3);
    expect(live).toBe(1);
    dispose();
    expect(live).toBe(0);
  });
});

describe("cleanup errors", () => {
  it("a throwing callback stops neither the walk nor the abort, and each error is seen once", () => {
    const log: string[] = [];
    const errorA = new Error("A");
    const errorChild = new Error("child");
    const owner = createRoot((dispose, o) => {
      o.onDispose(() => log.push("B"));
      o.onDispose(() => {
        throw errorA;
      });
      createRoot((_d, child) => {
        child.onDispose(() => {
          throw errorChild;
        });
      });
      dispose();
      return o;
    });
    expect(log).toEqual(["B"]);
    expect(owner.signal.aborted).toBe(true);
    let called = false;
    expect(
      runWithOwner(owner, () => {
        called = true;
      }),
    ).toBeUndefined();
    expect(called).toBe(false);
    expect(errors).toEqual([errorChild, errorA]);
  });

  it("a throwing effect cleanup is routed once and the rest of the owner still disposes", () => {
    const boom = new Error("cleanup");
    const log: string[] = [];
    createRoot((dispose, owner) => {
      owner.onDispose(() => log.push("callback"));
      effect(() => () => {
        throw boom;
      });
      dispose();
    });
    expect(log).toEqual(["callback"]);
    expect(errors).toEqual([boom]);
  });
});

describe("createRoot and runWithOwner", () => {
  it("createRoot returns fn's result", () => {
    expect(createRoot(() => 42)).toBe(42);
  });

  it("a root whose fn throws is disposed and the error rethrown", () => {
    const log: string[] = [];
    const s = signal(0);
    let runs = 0;
    const boom = new Error("setup");
    expect(() =>
      createRoot((_d, owner) => {
        owner.onDispose(() => log.push("disposed"));
        effect(() => {
          void s.value;
          runs++;
        });
        throw boom;
      }),
    ).toThrow(boom);
    s.value = 1;
    expect(log).toEqual(["disposed"]);
    expect(runs).toBe(1);
  });

  it("runWithOwner returns fn's result and owns what fn creates", () => {
    const s = signal(0);
    let runs = 0;
    const { owner, dispose } = createRoot((d, o) => ({ owner: o, dispose: d }));
    const result = runWithOwner(owner, () => {
      effect(() => {
        void s.value;
        runs++;
      });
      return "ok";
    });
    expect(result).toBe("ok");
    dispose();
    s.value = 1;
    expect(runs).toBe(1);
  });

  it("restores the outer owner when runWithOwner's fn throws", () => {
    const s = signal(0);
    let runs = 0;
    const inner = createRoot((_d, o) => o);
    createRoot((dispose) => {
      expect(() =>
        runWithOwner(inner, () => {
          throw new Error("x");
        }),
      ).toThrow("x");
      effect(() => {
        void s.value;
        runs++;
      });
      dispose();
    });
    s.value = 1;
    expect(runs).toBe(1);
  });

  it("createRoot and runWithOwner do not subscribe the enclosing effect", () => {
    const a = signal(0);
    const b = signal(0);
    let outerRuns = 0;
    const owner = createRoot((_d, o) => o);
    const dispose = effect(() => {
      outerRuns++;
      createRoot(() => a.value);
      runWithOwner(owner, () => b.value);
    });
    a.value = 1;
    b.value = 1;
    expect(outerRuns).toBe(1);
    dispose();
  });

  it("disposal callbacks do not subscribe the effect that disposed the root", () => {
    const s = signal(0);
    const trigger = signal(0);
    let outerRuns = 0;
    const disposeRoot = createRoot((d, o) => {
      o.onDispose(() => {
        void s.value;
      });
      return d;
    });
    const dispose = effect(() => {
      outerRuns++;
      if (trigger.value === 1) {
        disposeRoot();
      }
    });
    trigger.value = 1;
    s.value = 1;
    expect(outerRuns).toBe(2);
    dispose();
  });

  it("a root created in an owned effect's run is disposed before the next run", () => {
    const s = signal(0);
    const log: number[] = [];
    createRoot(() => {
      effect(() => {
        const v = s.value;
        createRoot((_d, o) => {
          o.onDispose(() => log.push(v));
        });
      });
    });
    s.value = 1;
    s.value = 2;
    expect(log).toEqual([0, 1]);
  });
});

describe("outside any root", () => {
  it("an effect nested in an unowned effect outlives the parent's re-runs", () => {
    const parent = signal(0);
    const child = signal(0);
    let childRuns = 0;
    const disposers: (() => void)[] = [];
    const dispose = effect(() => {
      void parent.value;
      disposers.push(
        effect(() => {
          void child.value;
          childRuns++;
        }),
      );
    });
    parent.value = 1;
    childRuns = 0;
    child.value = 1;
    expect(childRuns).toBe(2);
    dispose();
    for (const d of disposers) {
      d();
    }
  });

  it("an effect created by a computed read inside a root is not owned by it", () => {
    const s = signal(0);
    let runs = 0;
    let inner: (() => void) | undefined;
    const c = computed(() => {
      inner ??= effect(() => {
        void s.value;
        runs++;
      });
      return 1;
    });
    createRoot((dispose) => {
      void c.value;
      dispose();
    });
    s.value = 1;
    expect(runs).toBe(2);
    inner?.();
  });
});
