import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { writeInstallMetadata } from "./bootstrap.ts";
import { parseEnvFile } from "./env-file.ts";
import { applianceLayout, readInstallMetadata, resolveApplianceRoot } from "./home.ts";
import { runStart, runStop, type LifecycleIo } from "./lifecycle.ts";
import { PLATFORM_PROCESSES } from "./processes.ts";
import {
  readSupervisorPid,
  removeSupervisorFiles,
  writeSupervisorPid,
  writeSupervisorState,
} from "./state-files.ts";

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
    const composeUp = harness.execCalls.find((argv) => argv.includes("up"));
    // The explicit --env-file keeps compose interpolation working when the
    // configuration is not a ./.env in the compose working directory.
    expect(composeUp).toEqual([
      "docker",
      "compose",
      "--env-file",
      path.join(harness.repo, ".env"),
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

describe("runStart first boot", () => {
  function deviceFlowFetch(): (url: string, init?: RequestInit) => Promise<Response> {
    let approved = false;
    let claimed = false;
    return async (url, init) => {
      const { pathname } = new URL(url);
      if (pathname === "/api/auth/device/code") {
        return Response.json({ device_code: "dev-1", user_code: "CODE", interval: 5 });
      }
      if (pathname === "/api/auth/sign-in/email") {
        return new Response("{}", {
          status: 200,
          headers: { "set-cookie": "session=abc; Path=/" },
        });
      }
      if (pathname === "/api/auth/device") {
        claimed = true;
        return Response.json({ status: "pending" });
      }
      if (pathname === "/api/auth/device/approve") {
        approved = claimed;
        return new Response("{}", { status: 200 });
      }
      if (pathname === "/api/auth/oauth2/token") {
        return approved
          ? Response.json({ access_token: "tok", token_type: "Bearer", scope: "deploy observe" })
          : Response.json({ error: "authorization_pending" }, { status: 400 });
      }
      // Everything else is a readiness/health probe.
      void init;
      return new Response("{}", { status: 200 });
    };
  }

  test("an unconfigured appliance bootstraps end to end: config, infra, migrate, login, browser", async () => {
    const harness = await makeHarness({ env: undefined, webBuild: false });
    const configHome = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-xdg-"));
    harness.io.env.XDG_CONFIG_HOME = configHome;
    harness.io.fetchImpl = deviceFlowFetch();
    harness.io.tcpProbe = async () => true;
    const streamed: string[][] = [];
    harness.io.streamCommand = async (argv) => {
      streamed.push(argv);
      return 0;
    };
    const opened: string[] = [];
    harness.io.openUrl = async (url) => {
      opened.push(url);
    };

    expect(await runStart(["--no-prompt"], harness.io)).toBe(0);

    // Rendered config exists with generated secrets and production NODE_ENV.
    const rendered = parseEnvFile(await readFile(harness.layout.envFilePath, "utf8"));
    expect(rendered.NODE_ENV).toBe("production");
    expect(rendered.APP_SECRET_KEY).toBeTruthy();

    // The Dashboard build and migrations ran; infra came up; the built-in
    // agent was seeded through the real eveland CLI with the minted token.
    expect(streamed.slice(0, 2)).toEqual([
      ["pnpm", "--filter", "@evelandhq/web", "build"],
      ["pnpm", "--filter", "@evelandhq/api", "db:migrate"],
    ]);
    expect(streamed).toHaveLength(3);
    expect(streamed[2]).toContain("deploy");
    expect(streamed[2]!.join(" ")).toContain("templates/starter-agent");
    expect(streamed[2]!.join(" ")).toContain("--name stella");
    expect(harness.execCalls).toContainEqual([
      "docker",
      "compose",
      "--env-file",
      harness.layout.envFilePath,
      "up",
      "-d",
      "postgres",
      "otel-collector",
    ]);

    // Implicit login stored a CLI credential for the public origin.
    const credentials = await readdir(path.join(configHome, "eveland", "credentials"));
    expect(credentials).toHaveLength(1);

    // Bootstrap completed and the browser opened on the platform.
    expect((await readInstallMetadata(harness.layout))?.bootstrapCompleted).toBe(true);
    expect(opened).toEqual(["http://localhost:17300"]);
    expect(harness.out.join("\n")).toContain("Eveland is running at http://localhost:17300");
  });

  test("a failed implicit login is a warning, not a failed start", async () => {
    const harness = await makeHarness({ env: undefined, webBuild: false });
    harness.io.env.XDG_CONFIG_HOME = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-xdg-"));
    harness.io.fetchImpl = async (url) => {
      if (new URL(url).pathname.startsWith("/api/auth/")) {
        return new Response("{}", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    };
    harness.io.tcpProbe = async () => true;
    harness.io.streamCommand = async () => 0;

    expect(await runStart(["--no-prompt"], harness.io)).toBe(0);
    expect(harness.err.join("\n")).toContain("eveland login");
    expect((await readInstallMetadata(harness.layout))?.bootstrapCompleted).toBe(true);
  });

  test("a development checkout with its own .env never bootstraps", async () => {
    const harness = await makeHarness({ env: VALID_ENV });
    expect(await runStart([], harness.io)).toBe(0);
    expect(await readInstallMetadata(harness.layout)).toBeNull();
    await expect(readFile(harness.layout.envFilePath, "utf8")).rejects.toThrow();
  });

  test("an interrupted bootstrap resumes without re-rendering secrets", async () => {
    const harness = await makeHarness({ env: undefined, webBuild: false });
    harness.io.env.XDG_CONFIG_HOME = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-xdg-"));
    harness.io.fetchImpl = deviceFlowFetch();
    harness.io.tcpProbe = async () => true;
    harness.io.streamCommand = async () => 0;
    expect(await runStart(["--no-prompt"], harness.io)).toBe(0);
    const first = parseEnvFile(await readFile(harness.layout.envFilePath, "utf8"));

    // Simulate an incomplete install: completed flag reset, supervisor gone.
    const metadata = await readInstallMetadata(harness.layout);
    await writeInstallMetadata(harness.layout, { ...metadata!, bootstrapCompleted: false });
    await removeSupervisorFiles(harness.layout);
    harness.alivePids.clear();
    harness.io.fetchImpl = deviceFlowFetch();

    expect(await runStart(["--no-prompt"], harness.io)).toBe(0);
    const second = parseEnvFile(await readFile(harness.layout.envFilePath, "utf8"));
    expect(second.APP_SECRET_KEY).toBe(first.APP_SECRET_KEY);
    expect((await readInstallMetadata(harness.layout))?.bootstrapCompleted).toBe(true);
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
