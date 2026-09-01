import { describe, expect, test, vi } from "vitest";

import { nonOverlapping, startJobPump } from "./job-pump.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yields until pending microtasks and resolved continuations have settled. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("startJobPump", () => {
  test("rejects a non-positive concurrency instead of silently idling", () => {
    const options = {
      idleDelayMs: 1000,
      claim: async () => null,
      run: async () => {},
      onError: () => {},
    };
    expect(() => startJobPump({ ...options, concurrency: 0 })).toThrow(
      "Job pump concurrency must be a positive integer.",
    );
    expect(() => startJobPump({ ...options, concurrency: 1.5 })).toThrow(
      "Job pump concurrency must be a positive integer.",
    );
  });

  test("runs claimed jobs concurrently up to the pool size, claiming again as slots free up", async () => {
    const queue = ["a", "b", "c"];
    const runs = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    const pump = startJobPump<string>({
      concurrency: 2,
      idleDelayMs: 60_000,
      sleep: () => new Promise(() => {}),
      claim: async () => queue.shift() ?? null,
      run: (job) => {
        started.push(job);
        const gate = deferred();
        runs.set(job, gate);
        return gate.promise;
      },
      onError: () => {},
    });

    await settle();
    // Both slots fill immediately; the third job waits for a free slot.
    expect(started).toEqual(["a", "b"]);

    runs.get("a")!.resolve();
    await settle();
    expect(started).toEqual(["a", "b", "c"]);

    runs.get("b")!.resolve();
    runs.get("c")!.resolve();
    await pump.stop();
  });

  test("claims stay strictly serial even while the pool runs concurrently", async () => {
    let claimsInFlight = 0;
    let maxClaimsInFlight = 0;
    let handedOut = 0;
    const pump = startJobPump<number>({
      concurrency: 3,
      idleDelayMs: 60_000,
      sleep: () => new Promise(() => {}),
      claim: async () => {
        claimsInFlight += 1;
        maxClaimsInFlight = Math.max(maxClaimsInFlight, claimsInFlight);
        await settle();
        claimsInFlight -= 1;
        handedOut += 1;
        return handedOut <= 5 ? handedOut : null;
      },
      run: async () => {
        await settle();
      },
      onError: () => {},
    });

    await settle();
    await settle();
    await pump.stop();
    expect(maxClaimsInFlight).toBe(1);
  });

  test("sleeps for idleDelayMs when the queue is empty and claims again afterwards", async () => {
    const sleeps: ReturnType<typeof deferred>[] = [];
    const sleep = vi.fn(() => {
      const gate = deferred();
      sleeps.push(gate);
      return gate.promise;
    });
    const claim = vi.fn(async () => null);
    const pump = startJobPump({
      concurrency: 1,
      idleDelayMs: 5000,
      sleep,
      claim,
      run: async () => {},
      onError: () => {},
    });

    await settle();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);

    sleeps[0]!.resolve();
    await settle();
    expect(claim).toHaveBeenCalledTimes(2);
    await pump.stop();
  });

  test("reports claim and run failures without killing the loop", async () => {
    const errors: unknown[] = [];
    let phase = 0;
    const processed: string[] = [];
    const pump = startJobPump<string>({
      concurrency: 1,
      idleDelayMs: 1,
      sleep: async () => {},
      claim: async () => {
        phase += 1;
        if (phase === 1) throw new Error("claim exploded");
        if (phase === 2) return "doomed";
        if (phase === 3) return "fine";
        return null;
      },
      run: async (job) => {
        if (job === "doomed") throw new Error("run exploded");
        processed.push(job);
      },
      onError: (error) => errors.push(error),
    });

    await settle();
    await pump.stop();
    expect(errors.map((error) => (error as Error).message)).toEqual([
      "claim exploded",
      "run exploded",
    ]);
    expect(processed).toEqual(["fine"]);
  });

  test("stop() wakes idle sleepers, blocks new claims, and waits for in-flight runs", async () => {
    const gate = deferred();
    const claim = vi.fn(async () => (claim.mock.calls.length === 1 ? "only" : null));
    const pump = startJobPump<string>({
      concurrency: 2,
      idleDelayMs: 60_000,
      sleep: () => new Promise(() => {}), // never resolves on its own
      claim,
      run: () => gate.promise,
      onError: () => {},
    });

    await settle();
    const claimsBeforeStop = claim.mock.calls.length;
    let stopResolved = false;
    const stopping = pump.stop().then(() => {
      stopResolved = true;
    });
    await settle();
    // The idle loop woke and exited; the busy loop still holds stop() open.
    expect(stopResolved).toBe(false);

    gate.resolve();
    await stopping;
    expect(claim.mock.calls.length).toBe(claimsBeforeStop);
  });

  test("wake() interrupts idle loops so the next claim happens without waiting out the delay", async () => {
    const claim = vi.fn(async () => null);
    const pump = startJobPump({
      concurrency: 2,
      idleDelayMs: 60_000,
      sleep: () => new Promise(() => {}), // never resolves on its own
      claim,
      run: async () => {},
      onError: () => {},
    });

    await settle();
    const idleClaims = claim.mock.calls.length;
    pump.wake();
    await settle();
    // Every idle loop re-claimed once, then went back to sleep.
    expect(claim.mock.calls.length).toBe(idleClaims + 2);
    await pump.stop();
  });

  test("a wake landing during a claim triggers an immediate re-claim instead of sleeping", async () => {
    const gate = deferred();
    let claims = 0;
    const sleep = vi.fn(() => new Promise<void>(() => {}));
    const pump = startJobPump({
      concurrency: 1,
      idleDelayMs: 60_000,
      sleep,
      claim: async () => {
        claims += 1;
        if (claims === 1) await gate.promise;
        return null;
      },
      run: async () => {},
      onError: () => {},
    });

    await settle();
    // The enqueue this wake signals may have been missed by the in-flight
    // claim, so the loop must claim again before it is allowed to idle.
    pump.wake();
    gate.resolve();
    await settle();
    expect(claims).toBe(2);
    await pump.stop();
  });

  test("wake() after stop() does not restart the loops", async () => {
    const claim = vi.fn(async () => null);
    const pump = startJobPump({
      concurrency: 1,
      idleDelayMs: 1,
      sleep: async () => {},
      claim,
      run: async () => {},
      onError: () => {},
    });

    await settle();
    await pump.stop();
    const claimsAtStop = claim.mock.calls.length;
    pump.wake();
    await settle();
    expect(claim.mock.calls.length).toBe(claimsAtStop);
  });
});

describe("nonOverlapping", () => {
  test("skips invocations while the previous run is still in flight", async () => {
    const gate = deferred();
    const fn = vi.fn(() => gate.promise);
    const guarded = nonOverlapping(fn);

    guarded();
    guarded();
    guarded();
    expect(fn).toHaveBeenCalledTimes(1);

    gate.resolve();
    await settle();
    guarded();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("a rejected run releases the guard for the next invocation", async () => {
    const fn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const errors: unknown[] = [];
    const guarded = nonOverlapping(fn, (error) => errors.push(error));

    guarded();
    await settle();
    guarded();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(errors.map((error) => (error as Error).message)).toEqual(["boom"]);
  });
});
