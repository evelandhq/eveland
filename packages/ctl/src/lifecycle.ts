import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { API_INTERNAL_URL_FALLBACK, PUBLIC_ORIGIN_FALLBACK } from "@evelandhq/core/ports";
import {
  defaultStreamCommand,
  runBootstrapConfig,
  runBootstrapPrepare,
  writeInstallMetadata,
  type BootstrapDeps,
} from "./bootstrap.ts";
import type { ExecCommand, FetchLike, LifecycleIo, SpawnDaemon } from "./io.ts";
import { loadPlatformEnvFile, type PlatformEnvFile } from "./env-file.ts";
import {
  applianceLayout,
  databaseMode,
  readInstallMetadata,
  repoRoot,
  resolveApplianceRoot,
  type ApplianceLayout,
} from "./home.ts";
import { runImplicitLogin } from "./implicit-login.ts";
import { provisionLinuxHost } from "./linux-host.ts";
import { defaultTcpProbe } from "./net-probe.ts";
import { defaultPgReady } from "./pg-probe.ts";
import { runSeedAgent } from "./seed-agent.ts";
import { createPrompter, nonInteractivePrompter } from "./prompt.ts";
import { absoluteProcessDir, childEnvironment, PLATFORM_PROCESSES } from "./processes.ts";
import {
  defaultProcessIdentity,
  isProcessAlive,
  readSupervisorRecord,
  readSupervisorState,
  removeSupervisorFiles,
  acquireMutex,
  claimSupervisorRecord,
  MutexBusyError,
  readPendingUpdate,
  updateMutexPath,
  verifiedSupervisorPid,
  type HeldMutex,
  writeSupervisorState,
  type ProcessIdentity,
} from "./state-files.ts";
import { Supervisor, type SupervisedProcess } from "./supervisor.ts";
import {
  applianceComposeArgs,
  composeInfraServices,
  installSystemdArtifacts,
  startViaSystemd,
  stopViaSystemd,
  writeServiceEnvFiles,
  type SystemdModeContext,
} from "./systemd-mode.ts";
import { detectDockerBridgeHost } from "./docker-bridge.ts";

export type { ExecCommand, FetchLike, LifecycleIo, SpawnDaemon } from "./io.ts";

export const READINESS_DEADLINE_MS = 120_000;
export const READINESS_POLL_MS = 500;
export const STOP_WAIT_MS = 15_000;
export const STOP_KILL_WAIT_MS = 5_000;

/** Re-exported so the ctl-supervised form and the systemd form cannot disagree. */
export { INFRA_COMPOSE_SERVICES } from "./systemd-mode.ts";

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
  processIdentity: ProcessIdentity;
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
    processIdentity: io.processIdentity ?? defaultProcessIdentity(),
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

function resolvedDataDir(resolved: ResolvedLifecycle, envFile: PlatformEnvFile): string {
  return envFile.values.EVELAND_DATA_DIR?.trim() || resolved.layout.dataDir;
}

/**
 * Docker's bridge gateway, which is where the host-native API binds the
 * listener the managed Collector delivers Agent events to. Re-detected on
 * every start (Docker renumbers its bridge on its own schedule), and a
 * failure is loud: without it the Observation path silently stops
 * delivering, which reads downstream as a Worker that will not start.
 */
async function detectApiBridgeHost(
  io: LifecycleIo,
  resolved: ResolvedLifecycle,
): Promise<string | null> {
  if (resolved.platform !== "linux") return null;
  const host = await detectDockerBridgeHost({
    execCommand: resolved.execCommand,
    cwd: resolved.repoRootDir,
  });
  if (host === null) {
    io.stderr(
      "Could not read Docker's bridge gateway address, so the API will run without its " +
        "Collector-facing listener and Agent events will not be delivered. Check " +
        "`docker network inspect bridge`.",
    );
  }
  return host;
}

async function preflightStart(
  resolved: ResolvedLifecycle,
  options: { requireWebBuild: boolean },
): Promise<string[]> {
  const problems: string[] = [];
  if (!(await resolved.fileExists(path.join(resolved.repoRootDir, "node_modules")))) {
    problems.push(
      `Dependencies are not installed in ${resolved.repoRootDir}. Run \`pnpm install --frozen-lockfile\` first.`,
    );
  }
  if (
    options.requireWebBuild &&
    !(await resolved.fileExists(path.join(resolved.repoRootDir, "apps/web/.next/BUILD_ID")))
  ) {
    problems.push(
      "The Dashboard has no production build (apps/web/.next is missing). " +
        "Run `pnpm --filter @evelandhq/web build` first.",
    );
  }
  return problems;
}

/**
 * Compose interpolates the WHOLE file even when only infra services start,
 * and the api service's required `${EVELAND_ADMIN_PASSWORD:?}` style
 * interpolations only auto-resolve from a ./.env in the compose working
 * directory. An appliance keeps its configuration in etc/eveland.env, so
 * every compose invocation passes it explicitly.
 */
export function composeArgs(envFilePath: string, ...rest: string[]): string[] {
  return ["docker", "compose", "--env-file", envFilePath, ...rest];
}

async function ensureInfraUp(
  io: LifecycleIo,
  resolved: ResolvedLifecycle,
  upArgs: string[],
): Promise<void> {
  const probe = await resolved.execCommand(["docker", "info", "--format", "{{.ServerVersion}}"], {
    cwd: resolved.repoRootDir,
  });
  if (probe.code !== 0) {
    throw new Error(
      "Docker is not reachable, and the OTLP Collector runs in Docker Compose. " +
        "Start Docker and retry, or pass --skip-infra if the containers are managed elsewhere.",
    );
  }
  const services = upArgs.slice(upArgs.indexOf("-d") + 1);
  io.stdout(`Starting infrastructure (${services.join(", ")})...`);
  const result = await resolved.execCommand(upArgs, { cwd: resolved.repoRootDir });
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
  daemonPid: number | undefined,
): Promise<boolean> {
  // Liveness is checked against the daemon pid the spawn just returned — the
  // pidfile appears only once the supervisor has booted, so reading it here
  // would race a healthy startup into a false "supervisor exited".
  if (daemonPid === undefined) {
    io.stderr("The supervisor process could not be spawned.");
    return false;
  }
  const ready = new Set<string>();
  const deadline = READINESS_DEADLINE_MS;
  for (let waited = 0; waited <= deadline; waited += READINESS_POLL_MS) {
    if (!resolved.isAlive(daemonPid)) {
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

/**
 * Bootstrap is needed on an appliance whose install never completed. A
 * development checkout (its own .env, no appliance config) is never
 * bootstrapped: it is already configured by hand.
 */
/** After systemd promotion, systemctl+Compose own the processes, not the ctl supervisor. */
export async function systemdSupervised(resolved: ResolvedLifecycle): Promise<boolean> {
  const metadata = await readInstallMetadata(resolved.layout);
  return metadata?.supervision === "systemd";
}

/** The narrow context the systemd-mode machinery needs (also used by `install --systemd`). */
export function systemdModeContext(
  io: LifecycleIo,
  resolved: ResolvedLifecycle,
): SystemdModeContext {
  return {
    io,
    layout: resolved.layout,
    repoRootDir: resolved.repoRootDir,
    execCommand: resolved.execCommand,
    fetchImpl: resolved.fetchImpl,
    sleep: resolved.sleep,
  };
}

async function detectBootstrapNeeded(resolved: ResolvedLifecycle): Promise<boolean> {
  const applianceEnvExists = await resolved.fileExists(resolved.layout.envFilePath);
  const devEnvExists = await resolved.fileExists(path.join(resolved.repoRootDir, ".env"));
  if (!applianceEnvExists && devEnvExists) return false;
  const metadata = await readInstallMetadata(resolved.layout);
  return metadata?.bootstrapCompleted !== true;
}

function bootstrapDeps(
  io: LifecycleIo,
  resolved: ResolvedLifecycle,
  noPrompt: boolean,
): BootstrapDeps {
  if (resolved.platform !== "darwin" && resolved.platform !== "linux") {
    throw new Error(`Unsupported platform '${resolved.platform}'.`);
  }
  return {
    io,
    layout: resolved.layout,
    repoRootDir: resolved.repoRootDir,
    platform: resolved.platform,
    prompter: noPrompt ? nonInteractivePrompter() : (io.prompter ?? createPrompter()),
    streamCommand: io.streamCommand ?? defaultStreamCommand(io.stdout),
    execCommand: resolved.execCommand,
    tcpProbe: io.tcpProbe ?? defaultTcpProbe(),
    sleep: resolved.sleep,
    fileExists: resolved.fileExists,
    pgReady: io.pgReady ?? defaultPgReady(),
    random: io.random,
  };
}

/**
 * Login + seeding after readiness. The seed outcome is recorded separately
 * from bootstrap completion: the platform IS complete without the built-in
 * agent, but a failed seed marks `seedCompleted: false` so the very next
 * `start` retries it — the recovery the failure message promises.
 */
async function runLoginAndSeed(
  io: LifecycleIo,
  resolved: ResolvedLifecycle,
  envFile: PlatformEnvFile,
): Promise<boolean> {
  const origin = publicOrigin(envFile);
  const adminEmail = envFile.values.EVELAND_ADMIN_EMAIL;
  const adminPassword = envFile.values.EVELAND_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) return true; // nothing to seed with
  try {
    const login = await runImplicitLogin({
      apiBaseUrl: API_INTERNAL_URL_FALLBACK,
      publicOrigin: origin,
      adminEmail,
      adminPassword,
      fetchImpl: resolved.fetchImpl,
      sleep: resolved.sleep,
      env: io.env,
      print: io.stdout,
    });
    try {
      await runSeedAgent({
        repoRootDir: resolved.repoRootDir,
        publicOrigin: origin,
        accessToken: login.accessToken,
        envValues: envFile.values,
        parentEnv: io.env,
        streamCommand: io.streamCommand ?? defaultStreamCommand(io.stdout),
        print: io.stdout,
      });
      return true;
    } catch (error) {
      // The platform is fully usable without the built-in agent; the next
      // `eveland-ctl start` retries, and the error text carries the manual
      // `eveland deploy` recovery for the impatient.
      io.stderr(error instanceof Error ? error.message : String(error));
      io.stderr("The next `eveland-ctl start` will retry the seeding.");
      return false;
    }
  } catch (error) {
    // Login is a convenience, not a gate: the platform is up either way and
    // `eveland login` recovers it interactively.
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr("Continuing without CLI login; run `eveland login` later.");
    io.stderr("The next `eveland-ctl start` will retry login and seeding.");
    return false;
  }
}

async function finishBootstrap(
  io: LifecycleIo,
  resolved: ResolvedLifecycle,
  envFile: PlatformEnvFile,
): Promise<void> {
  const seedCompleted = await runLoginAndSeed(io, resolved, envFile);
  const metadata = await readInstallMetadata(resolved.layout);
  if (metadata) {
    await writeInstallMetadata(resolved.layout, {
      ...metadata,
      bootstrapCompleted: true,
      seedCompleted,
    });
  }
  await io.openUrl?.(publicOrigin(envFile)).catch(() => {});
}

/** The retry path a failed seed promises: run on a normal start until it sticks. */
async function retrySeedIfPending(
  io: LifecycleIo,
  resolved: ResolvedLifecycle,
  envFile: PlatformEnvFile,
): Promise<void> {
  const metadata = await readInstallMetadata(resolved.layout);
  if (!metadata || metadata.seedCompleted !== false) return;
  io.stdout("Retrying the built-in agent seeding left unfinished by a previous start...");
  const seedCompleted = await runLoginAndSeed(io, resolved, envFile);
  await writeInstallMetadata(resolved.layout, { ...metadata, seedCompleted });
}

export async function runStart(args: string[], io: LifecycleIo): Promise<number> {
  const parsed = parseArgs({
    args,
    options: {
      foreground: { type: "boolean" },
      "skip-infra": { type: "boolean" },
      "no-prompt": { type: "boolean" },
      /** (internal) set by update's phase 2, which starts while its pending record still exists. */
      "from-update": { type: "boolean" },
    },
    allowPositionals: false,
  });
  const resolved = resolveLifecycle(io);
  // A half-updated tree must not be started around an interrupted update:
  // the update state machine owns the platform until its record is cleared.
  if (parsed.values["from-update"]) {
    // update's phase 2: the parent phase 1 holds the update lock.
    return runStartUnlocked(parsed.values, io, resolved);
  }
  // start and update exclude each other through the SAME lock, held for
  // the whole start (a snapshot of the holder would leave a window for an
  // update to take the lock right after the look). The lock also covers
  // the backup/stop/stash window before update's record exists.
  await mkdir(resolved.layout.runDir, { recursive: true });
  let lock: HeldMutex;
  try {
    lock = await acquireMutex(
      updateMutexPath(resolved.layout),
      process.pid,
      resolved.processIdentity,
      { onLiveHolder: "fail", isAlive: resolved.isAlive, sleep: resolved.sleep },
    );
  } catch (error) {
    if (error instanceof MutexBusyError) {
      io.stderr(
        `An update is running (eveland-ctl update, pid ${error.holderPid}); ` +
          "it restarts the platform itself when done. Starting now is refused.",
      );
      return 1;
    }
    throw error;
  }
  let released = false;
  const release = async () => {
    if (!released) {
      released = true;
      await lock.release();
    }
  };
  try {
    if (await readPendingUpdate(resolved.layout)) {
      io.stderr(
        "An interrupted update is recorded (run/update-pending.json): re-run `eveland-ctl update` " +
          "to resume it. Starting a half-updated tree is refused.",
      );
      return 1;
    }
    return await runStartUnlocked(parsed.values, io, resolved, release);
  } finally {
    await release();
  }
}

type StartValues = {
  foreground?: boolean;
  "skip-infra"?: boolean;
  "no-prompt"?: boolean;
  "from-update"?: boolean;
};

async function runStartUnlocked(
  values: StartValues,
  io: LifecycleIo,
  resolved: ResolvedLifecycle,
  releaseUpdateLock: () => Promise<void> = async () => {},
): Promise<number> {
  const parsed = { values };
  // The systemd fast path is for a COMPLETED install only: a first boot
  // interrupted after the units were installed but before login/seed
  // finished still carries `supervision: "systemd"`, and must resume the
  // bootstrap (idempotent all the way) rather than be swallowed here.
  if ((await systemdSupervised(resolved)) && !(await detectBootstrapNeeded(resolved))) {
    const envFile = await requirePlatformEnvFile(io, resolved);
    // The Dashboard is a host unit now: its build is a host artifact, and a
    // missing one has to fail here rather than as a unit that will not start.
    const problems = await preflightStart(resolved, { requireWebBuild: true });
    if (problems.length > 0) {
      for (const problem of problems) io.stderr(problem);
      return 1;
    }
    const context = systemdModeContext(io, resolved);
    // Env files are derived from etc/eveland.env; re-render them so an
    // operator edit takes effect on the next start, not the next install.
    await writeServiceEnvFiles(context, envFile, {
      dockerBridgeHost: await detectApiBridgeHost(io, resolved),
    });
    const code = await startViaSystemd(context, {
      skipInfra: Boolean(parsed.values["skip-infra"]),
      dataDir: resolvedDataDir(resolved, envFile),
      database: databaseMode(await readInstallMetadata(resolved.layout)),
    });
    if (code !== 0) return code;
    await retrySeedIfPending(io, resolved, envFile);
    io.stdout("");
    io.stdout(`Eveland is running at ${publicOrigin(envFile)}`);
    return 0;
  }
  const existingPid = await verifiedSupervisorPid(resolved.layout, resolved.processIdentity);
  if (existingPid !== null) {
    io.stdout(`Eveland is already running (supervisor pid ${existingPid}).`);
    io.stdout("Use `eveland-ctl status` for details or `eveland-ctl restart` to restart.");
    const runningEnvFile = await loadPlatformEnvFile({
      env: io.env,
      repoRoot: resolved.repoRootDir,
      platform: resolved.platform,
    });
    if (runningEnvFile && (await detectBootstrapNeeded(resolved))) {
      // The supervisor came up, then the bootstrap died before login/seed
      // (or before recording completion): finish it against the running
      // platform instead of declaring "already running" and walking away.
      io.stdout("The first boot was interrupted after the platform started; finishing it now...");
      const supervisorLog = path.join(resolved.layout.logsDir, "supervisor.log");
      if (!(await waitForReadiness(io, resolved, supervisorLog, existingPid))) return 1;
      await finishBootstrap(io, resolved, runningEnvFile);
      io.stdout("");
      io.stdout(`Eveland is running at ${publicOrigin(runningEnvFile)}`);
      return 0;
    }
    // A pending seed is retried against the running platform too — the
    // recovery `start` promises must not depend on a restart.
    if (runningEnvFile) await retrySeedIfPending(io, resolved, runningEnvFile);
    return 0;
  }
  if ((await readSupervisorRecord(resolved.layout)) !== null) {
    // A record whose pid is gone or recycled: stale, clean it up.
    await removeSupervisorFiles(resolved.layout);
  }

  const bootstrapping = await detectBootstrapNeeded(resolved);
  let envFile: PlatformEnvFile;
  let database = databaseMode(await readInstallMetadata(resolved.layout));
  if (bootstrapping) {
    const deps = bootstrapDeps(io, resolved, Boolean(parsed.values["no-prompt"]));
    const problems = await preflightStart(resolved, { requireWebBuild: false });
    if (problems.length > 0) {
      for (const problem of problems) io.stderr(problem);
      return 1;
    }
    const configured = await runBootstrapConfig(deps);
    envFile = configured.envFile;
    database = configured.database;
    const existingMetadata = await readInstallMetadata(resolved.layout);
    await writeInstallMetadata(resolved.layout, {
      version: 1,
      installedAt: new Date().toISOString(),
      method: io.env.EVELAND_INSTALL_METHOD === "install.sh" ? "install.sh" : "manual",
      osMode: deps.platform,
      bootstrapCompleted: false,
      ...existingMetadata,
      // The answer to bundled-or-external, recorded before the first Compose
      // command that depends on it.
      database,
    });
    if (deps.platform === "linux") {
      // The production-host contract (sandbox toolchain, bwrap AppArmor
      // profile, service users, /workspace, system-PATH node/pnpm) is part
      // of the install, not homework left for the worker preflight to fail.
      const nodeBinDir = envFile.values.EVELAND_NODE
        ? path.dirname(envFile.values.EVELAND_NODE)
        : path.dirname(process.execPath);
      await provisionLinuxHost({
        stdout: io.stdout,
        stderr: io.stderr,
        execCommand: resolved.execCommand,
        streamCommand: deps.streamCommand,
        fileExists: resolved.fileExists,
        writeTextFile:
          io.writeTextFile ?? ((filePath, content) => writeFile(filePath, content, "utf8")),
        env: io.env,
        repoRootDir: resolved.repoRootDir,
        nodeBinDir,
        getuid: io.getuid ?? process.getuid ?? (() => -1),
      });
    }
    // Linux first boot lands DIRECTLY on the production form (systemd
    // units + Compose core services) — the plan's "day-one production" —
    // unless --foreground explicitly opts into the ctl supervisor.
    const linuxProductionForm =
      deps.platform === "linux" &&
      !parsed.values.foreground &&
      (io.getuid ?? process.getuid ?? (() => -1))() === 0;
    const context = systemdModeContext(io, resolved);
    if (linuxProductionForm) {
      const installed = await installSystemdArtifacts(context, envFile, {
        dockerBridgeHost: await detectApiBridgeHost(io, resolved),
      });
      if (installed !== 0) return installed;
      if (!parsed.values["skip-infra"]) {
        await ensureInfraUp(
          io,
          resolved,
          applianceComposeArgs(resolved.layout, "up", "-d", ...composeInfraServices(database)),
        );
      }
      // The Dashboard is a host systemd unit: build it here, once, instead
      // of rebuilding it inside a container on every start.
      await runBootstrapPrepare(deps, envFile, { buildWeb: true });
      await mkdir(resolved.layout.logsDir, { recursive: true });
      const started = await startViaSystemd(context, {
        skipInfra: true,
        dataDir: resolvedDataDir(resolved, envFile),
        database,
      });
      if (started !== 0) return started;
      await finishBootstrap(io, resolved, envFile);
      io.stdout("");
      io.stdout(`Eveland is running at ${publicOrigin(envFile)}`);
      return 0;
    }
    if (!parsed.values["skip-infra"]) {
      await ensureInfraUp(
        io,
        resolved,
        composeArgs(envFile.path, "up", "-d", ...composeInfraServices(database)),
      );
    }
    await runBootstrapPrepare(deps, envFile, { buildWeb: true });
  } else {
    envFile = await requirePlatformEnvFile(io, resolved);
    const problems = await preflightStart(resolved, { requireWebBuild: true });
    if (problems.length > 0) {
      for (const problem of problems) io.stderr(problem);
      return 1;
    }
    if (!parsed.values["skip-infra"]) {
      await ensureInfraUp(
        io,
        resolved,
        composeArgs(envFile.path, "up", "-d", ...composeInfraServices(database)),
      );
    }
  }
  await mkdir(resolved.layout.logsDir, { recursive: true });

  if (!bootstrapping && parsed.values.foreground) {
    io.stdout(`Starting Eveland in the foreground (config: ${envFile.path}). Ctrl-C stops it.`);
    // The supervisor claim protects the processes from here on; holding
    // the update lock for the supervisor's whole lifetime would only make
    // a later update impossible without a manual stop.
    await releaseUpdateLock();
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
  const ok = await waitForReadiness(io, resolved, supervisorLog, pid);
  if (!ok) return 1;
  if (bootstrapping) {
    await finishBootstrap(io, resolved, envFile);
  } else {
    await retrySeedIfPending(io, resolved, envFile);
  }
  io.stdout("");
  io.stdout(`Eveland is running at ${publicOrigin(envFile)}`);
  return 0;
}

export async function runStop(_args: string[], io: LifecycleIo): Promise<number> {
  const resolved = resolveLifecycle(io);
  if (await systemdSupervised(resolved)) {
    return stopViaSystemd(systemdModeContext(io, resolved));
  }
  // Verified against the recorded start-time identity: a recycled pid must
  // never receive our SIGTERM/SIGKILL — especially not as root.
  const pid = await verifiedSupervisorPid(resolved.layout, resolved.processIdentity);
  if (pid === null) {
    if ((await readSupervisorRecord(resolved.layout)) !== null) {
      await removeSupervisorFiles(resolved.layout);
    }
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
  io.stdout("Stopped. The infrastructure containers keep running;");
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
  const envFile = await requirePlatformEnvFile(io, resolved);
  await mkdir(resolved.layout.logsDir, { recursive: true });
  // Ownership is claimed atomically (O_EXCL on the pid record) BEFORE any
  // child spawns: two `start`s racing past the liveness check cannot both
  // end up owning five processes each.
  const claim = await claimSupervisorRecord(
    resolved.layout,
    { pid: process.pid, identity: await resolved.processIdentity(process.pid) },
    resolved.processIdentity,
  );
  if (!claim.claimed) {
    io.stderr(`Another supervisor is already running (pid ${claim.ownerPid}).`);
    return 1;
  }

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
      // detached: each child leads its own process group, so signals reach
      // the real servers behind the pnpm/tsx/next wrappers, not just the
      // wrapper the supervisor spawned.
      let handle: ReturnType<typeof spawn>;
      try {
        handle = spawn(command!, rest, {
          cwd: child.cwd,
          env: child.env,
          detached: true,
          stdio: ["ignore", fd, fd],
        });
      } finally {
        // The child holds its own duplicate; keeping ours would leak one fd
        // per restart and end a crash loop in EMFILE for the supervisor.
        closeSync(fd);
      }
      return {
        pid: handle.pid,
        onExit: (callback) => handle.once("exit", callback),
        kill: (signal) => {
          if (handle.pid !== undefined) {
            try {
              process.kill(-handle.pid, signal);
              return;
            } catch {
              // Group already gone; fall through to the direct child.
            }
          }
          handle.kill(signal);
        },
      };
    },
    sleep: resolved.sleep,
    now: () => new Date(),
    log: (line) => io.stdout(`[supervisor] ${line}`),
    publishState: (state) => writeSupervisorState(resolved.layout, state),
    supervisorPid: process.pid,
    groupAlive: (pid) => isProcessAlive(-pid),
    killGroup: (pid, signal) => {
      try {
        process.kill(-pid, signal);
      } catch {
        // Empty group: nothing left to signal.
      }
    },
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
