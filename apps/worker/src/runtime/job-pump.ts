export type JobPumpOptions<T> = {
  /** How many claimed jobs may execute at once. */
  concurrency: number;
  /** How long an empty (or failed) claim pauses that loop before retrying. */
  idleDelayMs: number;
  claim: () => Promise<T | null>;
  run: (item: T) => Promise<void>;
  onError: (error: unknown) => void;
  /** Injectable for tests; the default is a stop-wakeable setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

export type JobPump = {
  /** Blocks new claims, wakes idle loops, and resolves once in-flight runs finish. */
  stop(): Promise<void>;
  /**
   * Wakes idle loops for an immediate claim (e.g. a Postgres NOTIFY reported a
   * fresh enqueue). A wake that lands while a claim is in flight still forces
   * one more claim before that loop may idle — the in-flight claim may have
   * missed the job the wake signals.
   */
  wake(): void;
};

/**
 * Drains the job queue with a bounded pool instead of one admission per
 * control-loop tick: each loop claims, runs to completion, and immediately
 * claims again, so a burst of queued activations clears in seconds instead of
 * `queue length x poll interval`. Claims are strictly serialized across the
 * pool — claimNextJob's heavy-cap count and per-project exclusion both assume
 * single-file admission — while the claimed jobs themselves run concurrently.
 */
export function startJobPump<T>(options: JobPumpOptions<T>): JobPump {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Job pump concurrency must be a positive integer.");
  }
  let stopped = false;
  let notifyStop!: () => void;
  const stopSignal = new Promise<void>((resolve) => {
    notifyStop = resolve;
  });
  const sleep = options.sleep ?? defaultSleep;

  let wakeVersion = 0;
  let wakeGate = createGate();

  let claimChain: Promise<unknown> = Promise.resolve();
  const claimSerialized = (): Promise<T | null> => {
    const next = claimChain.then(() => (stopped ? null : options.claim()));
    claimChain = next.catch(() => undefined);
    return next;
  };

  async function loop(): Promise<void> {
    while (!stopped) {
      const versionBeforeClaim = wakeVersion;
      let item: T | null = null;
      try {
        item = await claimSerialized();
      } catch (error) {
        options.onError(error);
      }
      if (item !== null) {
        try {
          await options.run(item);
        } catch (error) {
          options.onError(error);
        }
        continue;
      }
      if (stopped) return;
      if (wakeVersion !== versionBeforeClaim) continue;
      await Promise.race([sleep(options.idleDelayMs), wakeGate.promise, stopSignal]);
    }
  }

  const loops = Array.from({ length: options.concurrency }, () => loop());
  return {
    async stop() {
      stopped = true;
      notifyStop();
      await Promise.all(loops);
    },
    wake() {
      if (stopped) return;
      wakeVersion += 1;
      const sleepers = wakeGate;
      wakeGate = createGate();
      sleepers.open();
    },
  };
}

function createGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Wraps an async task for use in a fixed-rate timer: invocations that arrive
 * while the previous run is still in flight are skipped, so a slow run cannot
 * stack concurrent executions behind itself. Skipping means a slow run
 * silently pauses everything sharing the timer — pass `slow` to surface any
 * run that outlasted its interval instead of finding out from the pause.
 */
export function nonOverlapping(
  fn: () => Promise<unknown>,
  onError: (error: unknown) => void = () => {},
  slow?: { thresholdMs: number; onSlow: (durationMs: number) => void },
): () => void {
  let inFlight = false;
  return () => {
    if (inFlight) return;
    inFlight = true;
    const startedAt = Date.now();
    void fn()
      .catch(onError)
      .finally(() => {
        inFlight = false;
        if (!slow) return;
        const durationMs = Date.now() - startedAt;
        if (durationMs > slow.thresholdMs) slow.onSlow(durationMs);
      });
  };
}
