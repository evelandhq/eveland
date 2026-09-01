import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PUBLIC_ORIGIN_FALLBACK } from "@evelandhq/core/ports";
import { loadPlatformEnvFile, type PlatformEnvFile } from "./env-file.ts";
import { applianceLayout, repoRoot, resolveApplianceRoot, type ApplianceLayout } from "./home.ts";
import { absoluteProcessDir, childEnvironment, PLATFORM_PROCESSES } from "./processes.ts";
import {
  isProcessAlive,
  readSupervisorPid,
  readSupervisorState,
  removeSupervisorFiles,
  writeSupervisorPid,
  writeSupervisorState,
} from "./state-files.ts";
import { Supervisor, type SupervisedProcess } from "./supervisor.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type LifecycleIo = {
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  platform?: NodeJS.Platform;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  execCommand?: ExecCommand;
  spawnDaemon?: SpawnDaemon;
  fileExists?: (filePath: string) => Promise<boolean>;
  isAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  repoRootDir?: string;
};

export type ExecCommand = (
  argv: string[],
  options: { cwd: string },
) => Promise<{ code: number | null; output: string }>;

export type SpawnDaemon = (options: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
}) => Promise<number | undefined>;

export const READINESS_DEADLINE_MS = 120_000;
export const READINESS_POLL_MS = 500;
export const STOP_WAIT_MS = 15_000;
export const STOP_KILL_WAIT_MS = 5_000;

export const INFRA_COMPOSE_SERVICES = ["postgres", "otel-collector"];

function defaultFileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function defaultExecCommand(): ExecCommand {
  return (argv, options) =>
    new Promise((resolve) => {
      const [command, ...rest] = argv;
      const child = spawn(command!, rest, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("error", (error) => resolve({ code: null, output: `${output}\n${error.message}` }));
      child.on("close", (code) => resolve({ code, output }));
    });
}

function defaultSpawnDaemon(): SpawnDaemon {
  return async ({ argv, cwd, env, logFile }) => {
    await mkdir(path.dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");
    const [command, ...rest] = argv;
    const child = spawn(command!, rest, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    return child.pid;
  };
}

type ResolvedLifecycle = {
  layout: ApplianceLayout;
  repoRootDir: string;
  platform: NodeJS.Platform;
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  execCommand: ExecCommand;
  spawnDaemon: SpawnDaemon;
  fileExists: (filePath: string) => Promise<boolean>;
  isAlive: (pid: number) => boolean;
  sendSignal: (pid: number, signal: NodeJS.Signals) => void;
};

export function resolveLifecycle(io: LifecycleIo): ResolvedLifecycle {
  const platform = io.platform ?? process.platform;
  return {
    layout: applianceLayout(resolveApplianceRoot(io.env, platform)),
    repoRootDir: io.repoRootDir ?? repoRoot(),
    platform,
    fetchImpl: io.fetchImpl ?? ((url, init) => fetch(url, init)),
    sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    execCommand: io.execCommand ?? defaultExecCommand(),
    spawnDaemon: io.spawnDaemon ?? defaultSpawnDaemon(),
    fileExists: io.fileExists ?? defaultFileExists,
    isAlive: io.isAlive ?? ((pid) => isProcessAlive(pid)),
    sendSignal: io.sendSignal ?? ((pid, signal) => process.kill(pid, signal)),
  };
}

async function requirePlatformEnvFile(
  io: LifecycleIo,
  resolved: ResolvedLifecycle,
): Promise<PlatformEnvFile> {
  const envFile = await loadPlatformEnvFile({
    env: io.env,
    repoRoot: resolved.repoRootDir,
    platform: resolved.platform,
  });
  if (!envFile) {
    throw new Error(
      `No platform configuration found. Expected ${resolved.layout.envFilePath} (appliance install) ` +
        `or ${path.join(resolved.repoRootDir, ".env")} (development checkout). ` +
        `Copy .env.example to .env and set the required values before starting.`,
    );
  }
  return envFile;
}

export function publicOrigin(envFile: PlatformEnvFile): string {
  return envFile.values.EVELAND_PUBLIC_ORIGIN?.trim() || PUBLIC_ORIGIN_FALLBACK;
}

async function preflightStart(resolved: ResolvedLifecycle): Promise<string[]> {
  const problems: string[] = [];
  if (!(await resolved.fileExists(path.join(resolved.repoRootDir, "node_modules")))) {
    problems.push(
      `Dependencies are not installed in ${resolved.repoRootDir}. Run \`pnpm install --frozen-lockfile\` first.`,
    );
  }
  if (!(await resolved.fileExists(path.join(resolved.repoRootDir, "apps/web/.next/BUILD_ID")))) {
    problems.push(
      "The Dashboard has no production build (apps/web/.next is missing). " +
        "Run `pnpm --filter @evelandhq/web build` first.",
    );
  }
  return problems;
}

async function ensureInfraUp(io: LifecycleIo, resolved: ResolvedLifecycle): Promise<void> {
  const probe = await resolved.execCommand(["docker", "info", "--format", "{{.ServerVersion}}"], {
    cwd: resolved.repoRootDir,
  });
  if (probe.code !== 0) {
    throw new Error(
      "Docker is not reachable, and Postgres and the OTLP Collector run in Docker Compose. " +
        "Start Docker and retry, or pass --skip-infra if the containers are managed elsewhere.",
    );
  }
  io.stdout("Starting infrastructure (postgres, otel-collector)...");
  const result = await resolved.execCommand(
    ["docker", "compose", "up", "-d", ...INFRA_COMPOSE_SERVICES],
    { cwd: resolved.repoRootDir },
  );
  if (result.code !== 0) {
    throw new Error(`docker compose up failed:\n${result.output.trim()}`);
  }
}

async function probeReady(fetchImpl: FetchLike, url: string): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw.split("\n").slice(-lines).join("\n");
  } catch {
    return "(no supervisor log yet)";
  }
}

async function waitForReadiness(
  io: LifecycleIo,
  resolved: ResolvedLifecycle,
  supervisorLog: string,
): Promise<boolean> {
  const ready = new Set<string>();
  const deadline = READINESS_DEADLINE_MS;
  for (let waited = 0; waited <= deadline; waited += READINESS_POLL_MS) {
    const pid = await readSupervisorPid(resolved.layout);
    if (pid === null || !resolved.isAlive(pid)) {
      io.stderr("The supervisor exited during startup. Last supervisor log lines:");
      io.stderr(await tailFile(supervisorLog, 20));
      return false;
    }
    const state = await readSupervisorState(resolved.layout);
    for (const spec of PLATFORM_PROCESSES) {
      if (ready.has(spec.key)) continue;
      if (spec.readinessUrl) {
        if (await probeReady(resolved.fetchImpl, spec.readinessUrl)) {
          ready.add(spec.key);
          io.stdout(`  ${spec.label} is ready`);
        }
      } else if (state?.children[spec.key]?.status === "running") {
        ready.add(spec.key);
        io.stdout(`  ${spec.label} is running`);
      }
    }
    if (ready.size === PLATFORM_PROCESSES.length) return true;
    await resolved.sleep(READINESS_POLL_MS);
  }
  const missing = PLATFORM_PROCESSES.filter((spec) => !ready.has(spec.key)).map((s) => s.label);
  io.stderr(
    `Timed out waiting for: ${missing.join(", ")}. ` +
      "Check `eveland-ctl status` and `eveland-ctl logs`.",
  );
  return false;
}

export async function runStart(args: string[], io: LifecycleIo): Promise<number> {
  const parsed = parseArgs({
    args,
    options: {
      foreground: { type: "boolean" },
      "skip-infra": { type: "boolean" },
    },
    allowPositionals: false,
  });
  const resolved = resolveLifecycle(io);
  const existingPid = await readSupervisorPid(resolved.layout);
  if (existingPid !== null && resolved.isAlive(existingPid)) {
    io.stdout(`Eveland is already running (supervisor pid ${existingPid}).`);
    io.stdout("Use `eveland-ctl status` for details or `eveland-ctl restart` to restart.");
    return 0;
  }
  if (existingPid !== null) {
    await removeSupervisorFiles(resolved.layout);
  }

  const envFile = await requirePlatformEnvFile(io, resolved);
  const problems = await preflightStart(resolved);
  if (problems.length > 0) {
    for (const problem of problems) io.stderr(problem);
    return 1;
  }
  if (!parsed.values["skip-infra"]) {
    await ensureInfraUp(io, resolved);
  }
  await mkdir(resolved.layout.logsDir, { recursive: true });

  if (parsed.values.foreground) {
    io.stdout(`Starting Eveland in the foreground (config: ${envFile.path}). Ctrl-C stops it.`);
    return runSupervise(["--root", resolved.layout.root], io);
  }

  const supervisorLog = path.join(resolved.layout.logsDir, "supervisor.log");
  const binPath = fileURLToPath(new URL("./bin.ts", import.meta.url));
  const pid = await resolved.spawnDaemon({
    argv: [process.execPath, binPath, "_supervise", "--root", resolved.layout.root],
    cwd: resolved.repoRootDir,
    env: io.env,
    logFile: supervisorLog,
  });
  io.stdout(`Starting Eveland (config: ${envFile.path}, supervisor pid ${pid ?? "?"})...`);
  const ok = await waitForReadiness(io, resolved, supervisorLog);
  if (!ok) return 1;
  io.stdout("");
  io.stdout(`Eveland is running at ${publicOrigin(envFile)}`);
  return 0;
}

export async function runStop(_args: string[], io: LifecycleIo): Promise<number> {
  const resolved = resolveLifecycle(io);
  const pid = await readSupervisorPid(resolved.layout);
  if (pid === null || !resolved.isAlive(pid)) {
    if (pid !== null) await removeSupervisorFiles(resolved.layout);
    io.stdout("Eveland is not running.");
    return 0;
  }
  io.stdout(`Stopping Eveland (supervisor pid ${pid})...`);
  resolved.sendSignal(pid, "SIGTERM");
  for (let waited = 0; waited < STOP_WAIT_MS; waited += READINESS_POLL_MS) {
    if (!resolved.isAlive(pid)) break;
    await resolved.sleep(READINESS_POLL_MS);
  }
  if (resolved.isAlive(pid)) {
    io.stderr("The supervisor did not exit in time; sending SIGKILL.");
    resolved.sendSignal(pid, "SIGKILL");
    for (let waited = 0; waited < STOP_KILL_WAIT_MS; waited += READINESS_POLL_MS) {
      if (!resolved.isAlive(pid)) break;
      await resolved.sleep(READINESS_POLL_MS);
    }
  }
  if (resolved.isAlive(pid)) {
    io.stderr(`Supervisor pid ${pid} is still alive. Inspect it manually.`);
    return 1;
  }
  await removeSupervisorFiles(resolved.layout);
  io.stdout("Stopped. Infrastructure containers (postgres, otel-collector) keep running;");
  io.stdout("use `docker compose stop` in the source tree to stop them too.");
  return 0;
}

export async function runRestart(args: string[], io: LifecycleIo): Promise<number> {
  const stopCode = await runStop([], io);
  if (stopCode !== 0) return stopCode;
  return runStart(args, io);
}

/**
 * The hidden `_supervise` command: the daemonized (or --foreground) process
 * that actually owns the five platform children. Everything user-facing goes
 * through start/stop/status; this entry only supervises.
 */
export async function runSupervise(args: string[], io: LifecycleIo): Promise<number> {
  const parsed = parseArgs({
    args,
    options: { root: { type: "string" } },
    allowPositionals: false,
  });
  const resolved = resolveLifecycle(
    parsed.values.root ? { ...io, env: { ...io.env, EVELAND_HOME: parsed.values.root } } : io,
  );
  const existingPid = await readSupervisorPid(resolved.layout);
  if (existingPid !== null && existingPid !== process.pid && resolved.isAlive(existingPid)) {
    io.stderr(`Another supervisor is already running (pid ${existingPid}).`);
    return 1;
  }
  const envFile = await requirePlatformEnvFile(io, resolved);
  await mkdir(resolved.layout.logsDir, { recursive: true });
  await writeSupervisorPid(resolved.layout, process.pid);

  const children: SupervisedProcess[] = PLATFORM_PROCESSES.map((spec) => ({
    key: spec.key,
    label: spec.label,
    cwd: absoluteProcessDir(resolved.repoRootDir, spec),
    argv: spec.argv,
    env: childEnvironment(io.env, envFile.values),
  }));

  const supervisor = new Supervisor(children, {
    spawnChild: (child) => {
      const fd = openSync(path.join(resolved.layout.logsDir, `${child.key}.log`), "a");
      const [command, ...rest] = child.argv;
      const handle = spawn(command!, rest, {
        cwd: child.cwd,
        env: child.env,
        stdio: ["ignore", fd, fd],
      });
      return {
        pid: handle.pid,
        onExit: (callback) => handle.once("exit", callback),
        kill: (signal) => void handle.kill(signal),
      };
    },
    sleep: resolved.sleep,
    now: () => new Date(),
    log: (line) => io.stdout(`[supervisor] ${line}`),
    publishState: (state) => writeSupervisorState(resolved.layout, state),
    supervisorPid: process.pid,
  });

  await supervisor.start();
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void supervisor.stop().then(resolve);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  await removeSupervisorFiles(resolved.layout);
  io.stdout("[supervisor] all processes stopped");
  return 0;
}
