import { describe, expect, test } from "vitest";
import {
  backoffDelayMs,
  RESTART_BACKOFF_CAP_MS,
  STABLE_RESET_MS,
  Supervisor,
  type ChildHandle,
  type SupervisedProcess,
  type SupervisorDeps,
} from "./supervisor.ts";

type FakeChild = {
  handle: ChildHandle;
  exit: (code: number | null, signal?: string | null) => void;
  kills: NodeJS.Signals[];
  pid: number;
};

function makeHarness(options: { autoExitOnTerm?: boolean } = {}) {
  const spawned: Record<string, FakeChild[]> = {};
  let nextPid = 100;
  let nowMs = 0;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const states: string[] = [];

  const deps: SupervisorDeps = {
    spawnChild: (spec) => {
      const pid = nextPid++;
      const callbacks: Array<(code: number | null, signal: string | null) => void> = [];
      const child: FakeChild = {
        pid,
        kills: [],
        exit: (code, signal = null) => {
          for (const callback of callbacks) callback(code, signal);
        },
        handle: {
          pid,
          onExit: (callback) => callbacks.push(callback),
          kill: (signal) => {
            child.kills.push(signal);
            if (options.autoExitOnTerm && signal === "SIGTERM") child.exit(null, "SIGTERM");
          },
        },
      };
      (spawned[spec.key] ??= []).push(child);
      return child.handle;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    now: () => new Date(nowMs),
    log: (line) => logs.push(line),
    publishState: async (state) => {
      states.push(JSON.stringify(state));
    },
    supervisorPid: 1,
  };

  const processes: SupervisedProcess[] = [
    { key: "alpha", label: "Alpha", cwd: "/tmp", argv: ["true"], env: {} },
    { key: "beta", label: "Beta", cwd: "/tmp", argv: ["true"], env: {} },
  ];

  return {
    deps,
    processes,
    spawned,
    sleeps,
    logs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

async function settle() {
  // Exit handling is a chain of awaited microtasks (publish, sleep, respawn).
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("backoffDelayMs", () => {
  test("doubles from one second and caps", () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(2)).toBe(2_000);
    expect(backoffDelayMs(3)).toBe(4_000);
    expect(backoffDelayMs(10)).toBe(RESTART_BACKOFF_CAP_MS);
  });
});

describe("Supervisor", () => {
  test("start spawns every process and reports them running", async () => {
    const harness = makeHarness();
    const supervisor = new Supervisor(harness.processes, harness.deps);
    await supervisor.start();
    expect(harness.spawned.alpha).toHaveLength(1);
    expect(harness.spawned.beta).toHaveLength(1);
    const state = supervisor.state();
    expect(state.children.alpha).toMatchObject({ status: "running", restarts: 0 });
    expect(state.children.beta?.pid).toBe(harness.spawned.beta![0]!.pid);
  });

  test("a crashed child is restarted after backoff, and repeated crashes back off exponentially", async () => {
    const harness = makeHarness();
    const supervisor = new Supervisor(harness.processes, harness.deps);
    await supervisor.start();

    harness.spawned.alpha![0]!.exit(1);
    await settle();
    expect(harness.spawned.alpha).toHaveLength(2);
    expect(supervisor.state().children.alpha).toMatchObject({ restarts: 1, lastExit: "code 1" });

    harness.spawned.alpha![1]!.exit(1);
    await settle();
    expect(harness.spawned.alpha).toHaveLength(3);
    // First crash waited 1s, the second (still unstable) 2s.
    expect(harness.sleeps).toEqual([1_000, 2_000]);
  });

  test("a child that stayed up past the stability window resets its backoff", async () => {
    const harness = makeHarness();
    const supervisor = new Supervisor(harness.processes, harness.deps);
    await supervisor.start();

    harness.spawned.alpha![0]!.exit(1);
    await settle();
    harness.spawned.alpha![1]!.exit(1);
    await settle();
    expect(harness.sleeps).toEqual([1_000, 2_000]);

    harness.advance(STABLE_RESET_MS);
    harness.spawned.alpha![2]!.exit(1);
    await settle();
    // The streak reset: back to the base delay.
    expect(harness.sleeps).toEqual([1_000, 2_000, 1_000]);
  });

  test("stop terminates children and does not restart them", async () => {
    const harness = makeHarness({ autoExitOnTerm: true });
    const supervisor = new Supervisor(harness.processes, harness.deps);
    await supervisor.start();
    await supervisor.stop();
    expect(supervisor.allStopped()).toBe(true);
    expect(harness.spawned.alpha).toHaveLength(1);
    expect(harness.spawned.alpha![0]!.kills).toEqual(["SIGTERM"]);
  });

  test("a child that ignores SIGTERM is SIGKILLed", async () => {
    const harness = makeHarness({ autoExitOnTerm: false });
    const supervisor = new Supervisor(harness.processes, harness.deps);
    await supervisor.start();
    const alpha = harness.spawned.alpha![0]!;
    // Make beta exit politely so only alpha lingers.
    harness.spawned.beta![0]!.handle.kill = (signal) => {
      harness.spawned.beta![0]!.kills.push(signal);
      if (signal === "SIGTERM") harness.spawned.beta![0]!.exit(null, "SIGTERM");
    };
    const stopped = supervisor.stop();
    await settle();
    // Let the fake child die only on SIGKILL.
    const originalKill = alpha.handle.kill;
    alpha.handle.kill = (signal) => {
      originalKill(signal);
      if (signal === "SIGKILL") alpha.exit(null, "SIGKILL");
    };
    await stopped;
    expect(alpha.kills).toContain("SIGTERM");
    expect(alpha.kills).toContain("SIGKILL");
    expect(supervisor.allStopped()).toBe(true);
  });

  test("a crash during shutdown is recorded as stopped, not restarted", async () => {
    const harness = makeHarness();
    const supervisor = new Supervisor(harness.processes, harness.deps);
    await supervisor.start();
    const stopped = supervisor.stop();
    harness.spawned.alpha![0]!.exit(1);
    harness.spawned.beta![0]!.exit(null, "SIGTERM");
    await stopped;
    expect(harness.spawned.alpha).toHaveLength(1);
    expect(supervisor.state().children.alpha?.status).toBe("stopped");
  });
});
