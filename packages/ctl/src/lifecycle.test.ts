import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runStart, runStop, type LifecycleIo } from "./lifecycle.ts";
import { PLATFORM_PROCESSES } from "./processes.ts";
import { applianceLayout, resolveApplianceRoot } from "./home.ts";
import { readSupervisorPid, writeSupervisorPid, writeSupervisorState } from "./state-files.ts";

async function makeCheckout(options: { env?: string; nodeModules?: boolean; webBuild?: boolean }) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-repo-"));
  if (options.env !== undefined) await writeFile(path.join(repo, ".env"), options.env, "utf8");
  if (options.nodeModules !== false)
    await mkdir(path.join(repo, "node_modules"), { recursive: true });
  if (options.webBuild !== false) {
    await mkdir(path.join(repo, "apps/web/.next"), { recursive: true });
    await writeFile(path.join(repo, "apps/web/.next/BUILD_ID"), "test", "utf8");
  }
  return repo;
}

type HarnessOptions = {
  env?: string;
  nodeModules?: boolean;
  webBuild?: boolean;
  alivePids?: Set<number>;
  fetchOk?: boolean;
  daemon?: (layout: ReturnType<typeof applianceLayout>) => Promise<void>;
};

async function makeHarness(options: HarnessOptions = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-home-"));
  const repo = await makeCheckout(options);
  const out: string[] = [];
  const err: string[] = [];
  const execCalls: string[][] = [];
  const signals: Array<{ pid: number; signal: string }> = [];
  const alivePids = options.alivePids ?? new Set<number>();
  const layout = applianceLayout(resolveApplianceRoot({ EVELAND_HOME: home }, "darwin"));

  const io: LifecycleIo = {
    env: { EVELAND_HOME: home },
    platform: "darwin",
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    repoRootDir: repo,
    sleep: async () => {},
    fetchImpl: async () =>
      (options.fetchOk ?? true)
        ? new Response("{}", { status: 200 })
        : new Response("no", { status: 503 }),
    execCommand: async (argv) => {
      execCalls.push(argv);
      return { code: 0, output: "ok" };
    },
    spawnDaemon: async () => {
      await (options.daemon?.(layout) ??
        (async () => {
          await writeSupervisorPid(layout, 4242);
          alivePids.add(4242);
          await writeSupervisorState(layout, {
            pid: 4242,
            startedAt: "2026-09-01T00:00:00.000Z",
            children: Object.fromEntries(
              PLATFORM_PROCESSES.map((spec) => [
                spec.key,
                { status: "running" as const, pid: 5000, restarts: 0, lastExit: null },
              ]),
            ),
          });
        })());
      return 4242;
    },
    isAlive: (pid) => alivePids.has(pid),
    sendSignal: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGTERM" || signal === "SIGKILL") alivePids.delete(pid);
    },
  };
  return { io, out, err, execCalls, signals, alivePids, home, repo, layout };
}

const VALID_ENV = "NODE_ENV=development\nEVELAND_PUBLIC_ORIGIN=http://localhost:17300\n";

describe("runStart", () => {
  test("starts the daemon, brings infra up, waits for readiness, and prints the origin", async () => {
    const harness = await makeHarness({ env: VALID_ENV });
    expect(await runStart([], harness.io)).toBe(0);
    expect(harness.execCalls).toContainEqual([
      "docker",
      "compose",
      "up",
      "-d",
      "postgres",
      "otel-collector",
    ]);
    expect(harness.out.join("\n")).toContain("Eveland is running at http://localhost:17300");
  });

  test("is idempotent: a live supervisor short-circuits with exit 0", async () => {
    const harness = await makeHarness({ env: VALID_ENV, alivePids: new Set([777]) });
    await writeSupervisorPid(harness.layout, 777);
    expect(await runStart([], harness.io)).toBe(0);
    expect(harness.out.join("\n")).toContain("already running (supervisor pid 777)");
    expect(harness.execCalls).toEqual([]);
  });

  test("without configuration it explains both expected locations", async () => {
    const harness = await makeHarness({});
    await expect(runStart([], harness.io)).rejects.toThrow(
      /No platform configuration found.*eveland\.env.*\.env/s,
    );
  });

  test("refuses to start without installed dependencies or a Dashboard build", async () => {
    const harness = await makeHarness({ env: VALID_ENV, nodeModules: false, webBuild: false });
    expect(await runStart([], harness.io)).toBe(1);
    const stderr = harness.err.join("\n");
    expect(stderr).toContain("pnpm install");
    expect(stderr).toContain("pnpm --filter @evelandhq/web build");
  });

  test("--skip-infra starts without touching docker", async () => {
    const harness = await makeHarness({ env: VALID_ENV });
    expect(await runStart(["--skip-infra"], harness.io)).toBe(0);
    expect(harness.execCalls).toEqual([]);
  });

  test("an unreachable docker daemon is a clear error, not a compose stack trace", async () => {
    const harness = await makeHarness({ env: VALID_ENV });
    harness.io.execCommand = async (argv) => {
      harness.execCalls.push(argv);
      return { code: 1, output: "Cannot connect to the Docker daemon" };
    };
    await expect(runStart([], harness.io)).rejects.toThrow(/Docker is not reachable/);
  });

  test("a supervisor that dies during startup surfaces its log tail", async () => {
    const harness = await makeHarness({
      env: VALID_ENV,
      daemon: async (layout) => {
        // The daemon "crashes": pidfile written but the pid is never alive.
        await writeSupervisorPid(layout, 9999);
        await mkdir(layout.logsDir, { recursive: true });
        await writeFile(path.join(layout.logsDir, "supervisor.log"), "boom: bad config\n", "utf8");
      },
    });
    expect(await runStart(["--skip-infra"], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("supervisor exited during startup");
    expect(harness.err.join("\n")).toContain("boom: bad config");
  });
});

describe("runStop", () => {
  test("not running is a calm no-op that cleans stale files", async () => {
    const harness = await makeHarness({ env: VALID_ENV });
    await writeSupervisorPid(harness.layout, 4141); // stale: never alive
    expect(await runStop([], harness.io)).toBe(0);
    expect(harness.out.join("\n")).toContain("not running");
    expect(await readSupervisorPid(harness.layout)).toBeNull();
  });

  test("SIGTERMs a live supervisor and confirms it exited", async () => {
    const harness = await makeHarness({ env: VALID_ENV, alivePids: new Set([4242]) });
    await writeSupervisorPid(harness.layout, 4242);
    expect(await runStop([], harness.io)).toBe(0);
    expect(harness.signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(await readSupervisorPid(harness.layout)).toBeNull();
    expect(harness.out.join("\n")).toContain("Stopped.");
  });

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const harness = await makeHarness({ env: VALID_ENV, alivePids: new Set([4242]) });
    await writeSupervisorPid(harness.layout, 4242);
    harness.io.sendSignal = (pid, signal) => {
      harness.signals.push({ pid, signal });
      if (signal === "SIGKILL") harness.alivePids.delete(pid);
    };
    expect(await runStop([], harness.io)).toBe(0);
    expect(harness.signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
