import type { SharedAgentEnvironmentRecord } from "@evelandhq/core/contracts";
import { resolveSchedulerRuntimeSecret } from "@evelandhq/core/server/scheduler-dispatch";
import {
  decryptSecretValue,
  maskKnownSecrets,
  mergeRuntimeEnvironment,
  type EncryptedSecret,
} from "@evelandhq/core/server/secrets";
import { isSupportedEveDependency, unsupportedEveVersionMessage } from "@evelandhq/core/source";
import type { Store } from "@evelandhq/db";
import { access, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { resolveProjectSandboxCacheDir, resolveSandboxCacheRoot } from "../runtime/systemd.js";
import {
  resolveSandboxProcessLimits,
  resolveSandboxRunTimeoutMs,
} from "../runtime/sandbox-inject.js";
import {
  processSafeName,
  type RuntimeAdapter,
  type RuntimeCommandContext,
} from "../runtime/types.js";
import { ensureEvelandWorkflowTenant } from "../runtime/eveland-workflow-world-bootstrap.js";
import {
  resolveWorkflowWorldDeploymentUrl,
  resolveWorkflowWorldPlatformUrl,
} from "@evelandhq/core/workflow-world-url";
import { resolveDeploymentShutdownTimeoutSeconds } from "../runtime/shutdown-budget.js";
import { ensureProjectWorkflowWorld } from "../runtime/workflow-world-bootstrap.js";
import { resolveWorkflowRunnerMode } from "../runtime/workflow-world.js";
import { resolveIdentityDeploymentConfiguration } from "../runtime/identity-config-reconciler.js";

import type { ProcessJobOptions, ScheduleDispatchInput } from "./process-types.js";

export const devSecretKey = "eveland-dev-secret-key-000000000";
const runtimeDiagnosticMaxCharacters = 32_000;

export async function dispatchScheduleToRuntime(
  input: ScheduleDispatchInput,
): Promise<{ sessionIds: string[] }> {
  const timeoutMs = Number(process.env.EVELAND_SCHEDULER_DISPATCH_TIMEOUT_MS ?? 120_000);
  let response: Response;
  try {
    response = await fetch(
      `http://127.0.0.1:${input.hostPort}/eveland/scheduler/${encodeURIComponent(input.scheduleRunId)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.credential}`,
          "content-type": "application/json",
          "x-eveland-runtime-secret": input.runtimeSecret,
        },
        body: JSON.stringify({ scheduleKey: input.scheduleKey }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(
        `Scheduler Channel timed out after ${timeoutMs}ms for ScheduleRun ${input.scheduleRunId} on Deployment ${input.deploymentId}.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!response.ok)
    throw new Error(`Scheduler Channel rejected dispatch with HTTP ${response.status}.`);
  const body = (await response.json().catch(() => null)) as {
    sessionIds?: unknown;
  } | null;
  if (
    !body ||
    !Array.isArray(body.sessionIds) ||
    !body.sessionIds.every((value) => typeof value === "string")
  ) {
    throw new Error("Scheduler Channel returned an invalid dispatch result.");
  }
  return { sessionIds: body.sessionIds };
}

export async function removeManagedProjectFiles(
  dataDir: string,
  projectId: string,
  sourcePaths: string[],
  processNames: string[],
): Promise<void> {
  const root = path.resolve(dataDir);
  const safeProjectId = processSafeName(projectId);
  const ownedPaths = new Set([
    path.join(root, "sources", projectId),
    path.join(root, "builds", projectId),
    path.join(root, "observability", safeProjectId),
    path.join(root, "sandbox", safeProjectId),
    path.join(root, "memory", safeProjectId),
  ]);
  const allowedSourceRoots = [path.join(root, "sources"), path.join(root, "uploads")];

  for (const processName of processNames) {
    ownedPaths.add(path.join(root, "deployment-env", `${processSafeName(processName)}.env`));
  }

  for (const sourcePath of sourcePaths) {
    const candidate = path.resolve(sourcePath);
    const allowedRoot = allowedSourceRoots.find((entry) => isStrictlyWithin(candidate, entry));
    if (!allowedRoot) continue;
    const relativeSegments = path.relative(allowedRoot, candidate).split(path.sep);
    const ownedCandidate =
      allowedRoot === allowedSourceRoots[1] && relativeSegments[0]?.startsWith("zip-")
        ? path.join(allowedRoot, relativeSegments[0])
        : candidate;
    const [realCandidate, realAllowedRoot] = await Promise.all([
      realpath(ownedCandidate).catch(() => null),
      realpath(allowedRoot).catch(() => null),
    ]);
    if (realCandidate && realAllowedRoot && isStrictlyWithin(realCandidate, realAllowedRoot)) {
      ownedPaths.add(ownedCandidate);
    }
  }

  await Promise.all(
    [...ownedPaths].map((ownedPath) => rm(ownedPath, { recursive: true, force: true })),
  );
}

function isStrictlyWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

// Shared by build_deploy and restart_deployment: stops a process that this job
// itself just started but that never became healthy. Cleanup failure is only
// ever logged, never thrown, so it can never mask the original deploy/restart
// error that triggered the cleanup.
export async function stopStartedProcessOnFailure(
  store: Pick<Store, "appendLog">,
  projectId: string,
  adapter: RuntimeAdapter,
  processName: string,
  phase: "deploy" | "restart",
  secretValues: string[],
): Promise<void> {
  if (adapter.getProcessDiagnostics) {
    try {
      const diagnostics = await adapter.getProcessDiagnostics(processName);
      const raw = [
        `Runtime startup diagnostics (${adapter.name}) before cleanup:`,
        `State: ${diagnostics.state.trim() || "unavailable"}`,
        `Recent logs:\n${diagnostics.logs.trim() || "(none captured)"}`,
      ].join("\n");
      await store.appendLog({
        projectId,
        type: "runtime",
        line: limitRuntimeDiagnostic(maskKnownSecrets(raw, secretValues)),
      });
    } catch (diagnosticError) {
      await store.appendLog({
        projectId,
        type: "runtime",
        line: maskKnownSecrets(
          `Runtime startup diagnostics (${adapter.name}) unavailable before cleanup: ${errorMessage(diagnosticError)}`,
          secretValues,
        ),
      });
    }
  }
  try {
    await adapter.stopProcess(processName);
  } catch (cleanupError) {
    await store.appendLog({
      projectId,
      type: "runtime",
      line: `Cleanup after failed ${phase} also failed: ${errorMessage(cleanupError)}`,
    });
  }
}

function limitRuntimeDiagnostic(input: string): string {
  if (input.length <= runtimeDiagnosticMaxCharacters) return input;
  const marker = "\n… runtime diagnostics truncated …\n";
  const prefixLength = 2_000;
  const suffixLength = runtimeDiagnosticMaxCharacters - prefixLength - marker.length;
  return `${input.slice(0, prefixLength)}${marker}${input.slice(-suffixLength)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Without an explicit bound, @workflow/world-postgres falls back to pg's
 * implicit pool default (10) — per-deployment connection consumption then
 * scales invisibly with the number of running deployments until the workflow
 * Postgres instance hits max_connections (FATAL 53300). The default keeps
 * pg's 10; operators tune the fleet-wide value via the worker's
 * WORKFLOW_POSTGRES_MAX_POOL_SIZE.
 */
const defaultWorkflowMaxPoolSize = 10;

function resolveWorkflowMaxPoolSize(workerEnv: NodeJS.ProcessEnv): string {
  const parsed = Number.parseInt(workerEnv.WORKFLOW_POSTGRES_MAX_POOL_SIZE ?? "", 10);
  const size = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultWorkflowMaxPoolSize;
  return String(size);
}

// Shared by build_deploy and restart_deployment. Durable-workflow gating is
// NOT part of this: build_deploy only calls this after deciding the deploy may
// proceed, and restart never re-gates an already-deployed release.
export async function composeDeploymentEnv(
  store: Pick<Store, "listSecretRecords" | "getSharedAgentEnvironmentRecord">,
  projectId: string,
  options: ProcessJobOptions,
  workerEnv: NodeJS.ProcessEnv = process.env,
): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  const nodeEnv = options.nodeEnv ?? workerEnv.NODE_ENV;
  const isProduction = nodeEnv === "production";
  const workflowPostgresUrl = options.workflowPostgresUrl ?? workerEnv.WORKFLOW_POSTGRES_URL;
  // Every new build bakes in the shared world, so the only launches that still
  // get a legacy per-project database are the ones a caller explicitly marks
  // `legacy_project` — the legacy termination flow, never a fresh deploy. The
  // decision is the caller's persisted knowledge of the Deployment, not this
  // worker's current global environment.
  const usesLegacyWorld = options.workflowWorldKind === "legacy_project";
  // Legacy world: each project gets its own physical workflow database derived
  // from the platform base URL. A single shared database let any runtime claim
  // any project's queued turns and re-enqueue every project's active runs on
  // startup, so the database is created and bootstrapped here, before any
  // process starts with its URL.
  //
  // The platform world closes both doors with a tenant column instead, so a
  // project on it gets no per-project database — provisioning one would leave an
  // empty database behind for every project on the new world.
  const ensureWorld = options.ensureProjectWorkflowWorld ?? ensureProjectWorkflowWorld;
  const projectWorkflowUrl =
    workflowPostgresUrl && usesLegacyWorld
      ? await ensureWorld({ ...workerEnv, WORKFLOW_POSTGRES_URL: workflowPostgresUrl }, projectId)
      : undefined;
  // The platform world's equivalent: migrations plus this tenant's partitions.
  // Partitions must exist before the first write — there is deliberately no
  // DEFAULT partition, so an unprovisioned tenant fails loudly rather than
  // having its rows land somewhere unreclaimable.
  //
  // Deliberately NOT gated on the rollout flag. The flag chooses what the *next
  // build* bakes in, but this function runs on every launch, and a deployment's
  // world is fixed at build time. Gating here meant that turning the flag off
  // stopped injecting the world URL for a bundle that still imports the
  // multi-tenant world — which then fell back to the legacy single-tenant
  // database, one with no tenant_id column and no partitions. Injecting
  // whenever the platform has a world configured keeps an already-built
  // deployment pointed at the right database until it is rebuilt, which is what
  // makes the documented rollback ("flag off, then rebuild") actually safe.
  // Injected into the deployment: the container's view of the database.
  const evelandWorldUrl =
    options.evelandWorkflowWorldUrl ?? resolveWorkflowWorldDeploymentUrl(workerEnv);
  // Used from this process: the host's view. On Docker Desktop the injected
  // URL names `host.docker.internal`, which does not resolve on the host.
  const evelandWorldPlatformUrl =
    options.evelandWorkflowWorldUrl ?? resolveWorkflowWorldPlatformUrl(workerEnv);
  if (evelandWorldPlatformUrl) {
    const ensureTenant = options.ensureEvelandWorkflowTenant ?? ensureEvelandWorkflowTenant;
    await ensureTenant(evelandWorldPlatformUrl, projectId);
  }
  const schedulerRuntimeSecret =
    options.schedulerRuntimeSecret ?? resolveSchedulerRuntimeSecret(workerEnv);
  const schedulerRedeemUrl = options.schedulerRedeemUrl ?? workerEnv.EVELAND_SCHEDULER_REDEEM_URL;
  const appSecretKey = options.appSecretKey ?? workerEnv.APP_SECRET_KEY ?? devSecretKey;
  const identityConfiguration = resolveIdentityDeploymentConfiguration({
    dataDir: options.dataDir ?? workerEnv.EVELAND_DATA_DIR ?? ".eveland-data",
    nodeEnv,
    issuer:
      options.identityIssuer ||
      workerEnv.EVELAND_IDENTITY_ISSUER ||
      workerEnv.EVELAND_PUBLIC_ORIGIN,
    jwksUrl: options.identityJwksUrl || workerEnv.EVELAND_IDENTITY_JWKS_URL,
  });
  const identityIssuer = identityConfiguration?.issuer;
  const identityJwksUrl = identityConfiguration?.jwksUrl;
  const secrets = await readRuntimeSecrets(store, projectId, appSecretKey);
  const sharedEnvironment = readSharedAgentEnvironmentValues(
    await store.getSharedAgentEnvironmentRecord(),
    appSecretKey,
  );
  const sandboxProcessLimits = resolveSandboxProcessLimits(workerEnv);
  // Project secrets are runtime input, but the workflow database is
  // platform-owned and bootstrapped before this worker accepts jobs. Keep its
  // URL reserved so a project cannot silently redirect the injected world to
  // an uninitialized or tenant-controlled database.
  const reserved = {
    EVELAND_PROJECT_ID: projectId,
    // Where the deployed process finds its fileMemory() documents (read by the
    // SDK's evelandMemoryBackend()). Reserved so a project entry cannot point
    // an agent's persistent memory at another path; the launch context passes
    // the runtime-visible value (Docker's fixed in-container mount path), and
    // the fallback is the worker-visible per-project derivation.
    EVELAND_MEMORY_ROOT:
      options.memoryRootDir ?? resolveMemoryRootDirs(workerEnv, projectId).workerDir,
    EVELAND_SANDBOX_RUN_TIMEOUT_MS: resolveSandboxRunTimeoutMs(workerEnv),
    EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES: sandboxProcessLimits.maxConcurrentProcesses,
    EVELAND_SANDBOX_MAX_OUTPUT_BYTES: sandboxProcessLimits.maxOutputBytes,
    // How long srvx drains in-flight requests before cutting the remaining
    // connections (see ../runtime/shutdown-budget.ts for the four layers this
    // number has to thread). Reserved because a project entry could otherwise
    // set it to 0 -- turning every platform-initiated restart into an instant
    // kill -- or past the point where `eve start` SIGKILLs the server anyway.
    SERVER_SHUTDOWN_TIMEOUT: String(resolveDeploymentShutdownTimeoutSeconds(workerEnv)),
    // Only injected when the platform has the shared world configured. A
    // project that could set these could scope its world at another tenant's
    // data, or hand the runner a database nothing provisions.
    ...(evelandWorldUrl
      ? {
          EVELAND_WORKFLOW_WORLD_URL: evelandWorldUrl,
          EVELAND_WORKFLOW_RUNNER: resolveWorkflowRunnerMode(workerEnv),
          EVELAND_WORKFLOW_STREAM_COMPACTION: workerEnv.EVELAND_WORKFLOW_STREAM_COMPACTION ?? "on",
        }
      : {}),
    ...(identityIssuer ? { EVELAND_IDENTITY_ISSUER: identityIssuer.replace(/\/$/, "") } : {}),
    ...(identityJwksUrl ? { EVELAND_IDENTITY_JWKS_URL: identityJwksUrl } : {}),
    // The pool size is reserved alongside the URL: connection capacity on the
    // shared workflow Postgres instance is platform-planned
    // (max_connections ≈ pool size × concurrent deployments), so a project
    // must not be able to raise its own share of it.
    ...(projectWorkflowUrl
      ? {
          WORKFLOW_POSTGRES_URL: projectWorkflowUrl,
          WORKFLOW_POSTGRES_MAX_POOL_SIZE: resolveWorkflowMaxPoolSize(workerEnv),
        }
      : {}),
    ...(schedulerRuntimeSecret ? { EVELAND_SCHEDULER_RUNTIME_SECRET: schedulerRuntimeSecret } : {}),
    ...(schedulerRedeemUrl ? { EVELAND_SCHEDULER_REDEEM_URL: schedulerRedeemUrl } : {}),
    ...(isProduction ? { NODE_ENV: "production" } : {}),
  };
  const env = mergeRuntimeEnvironment({
    projectSecrets: secrets,
    sharedEnvironment,
    reserved,
  });
  const secretValues = [
    ...Object.values(secrets),
    ...Object.values(sharedEnvironment),
    ...(workflowPostgresUrl ? [workflowPostgresUrl] : []),
    ...(projectWorkflowUrl ? [projectWorkflowUrl] : []),
    // Carries credentials like the other two connection strings, so it is
    // masked out of build and runtime logs the same way.
    ...(evelandWorldUrl ? [evelandWorldUrl] : []),
    ...(schedulerRuntimeSecret ? [schedulerRuntimeSecret] : []),
  ];
  return { env, secretValues };
}

/**
 * The subset of the Agent environment a Release build may see: `variable`
 * entries only, never a `secret`.
 *
 * Which of those names the build actually keeps is the adapter's call, not
 * this one's -- `selectBuildVariables` drops the platform-owned ones at the
 * runtime boundary, where the rejected keys can still reach that build's log.
 * See ../runtime/build-environment.ts.
 */
export async function composeBuildVariables(
  store: Pick<Store, "listSecretRecords" | "getSharedAgentEnvironmentRecord">,
  projectId: string,
  appSecretKey: string,
): Promise<Record<string, string>> {
  const shared = readSharedAgentEnvironmentValues(
    await store.getSharedAgentEnvironmentRecord(),
    appSecretKey,
    "variable",
  );
  const project = Object.fromEntries(
    (await store.listSecretRecords(projectId))
      .filter((record) => record.kind === "variable")
      .map((record) => [
        record.key,
        decryptSecretValue(parseEncryptedSecret(record.encryptedValue), appSecretKey),
      ]),
  );
  // Must stay the runtime order (see mergeRuntimeEnvironment), minus the
  // reserved layer the build never gets.
  return { ...shared, ...project };
}

function readSharedAgentEnvironmentValues(
  environment: SharedAgentEnvironmentRecord | null,
  appSecretKey: string,
  kind?: SharedAgentEnvironmentRecord["entries"][number]["kind"],
): Record<string, string> {
  return Object.fromEntries(
    (environment?.entries ?? [])
      .filter((entry) => kind === undefined || entry.kind === kind)
      .map((entry) => [
        entry.key,
        decryptSecretValue(parseEncryptedSecret(entry.encryptedValue), appSecretKey),
      ]),
  );
}

async function readRuntimeSecrets(
  store: Pick<Store, "listSecretRecords">,
  projectId: string,
  appSecretKey: string,
): Promise<Record<string, string>> {
  const records = await store.listSecretRecords(projectId);
  const values: Record<string, string> = {};

  for (const record of records) {
    values[record.key] = decryptSecretValue(
      parseEncryptedSecret(record.encryptedValue),
      appSecretKey,
    );
  }

  return values;
}

export function parseEncryptedSecret(value: string): EncryptedSecret {
  const parsed = JSON.parse(value) as Partial<EncryptedSecret>;
  if (parsed.algorithm !== "aes-256-gcm" || !parsed.iv || !parsed.authTag || !parsed.ciphertext) {
    throw new Error("Invalid encrypted secret payload.");
  }
  return parsed as EncryptedSecret;
}

export async function resolveRuntimeCommandContext(
  sourcePath: string,
  persistedFiles: Array<{ path: string; content: string }> = [],
  persistedCommandContext?: RuntimeCommandContext,
): Promise<RuntimeCommandContext> {
  const packageJson =
    (await readPackageJson(sourcePath)) ??
    parsePackageJson(persistedFiles.find((file) => file.path === "package.json")?.content);
  const eveVersion = declaredEveVersion(packageJson);
  if (!isSupportedEveDependency(eveVersion)) {
    throw new Error(unsupportedEveVersionMessage(eveVersion));
  }
  if (persistedCommandContext) return persistedCommandContext;
  const persistedPaths = new Set(persistedFiles.map((file) => file.path));
  const hasPnpmLockfile =
    persistedPaths.has("pnpm-lock.yaml") ||
    (await fileExists(path.join(sourcePath, "pnpm-lock.yaml")));
  const hasNpmLockfile =
    persistedPaths.has("package-lock.json") ||
    (await fileExists(path.join(sourcePath, "package-lock.json")));
  return hasPnpmLockfile
    ? { hasLockfile: true as const, packageManager: "pnpm" as const }
    : { hasLockfile: hasNpmLockfile, packageManager: "npm" as const };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function declaredEveVersion(packageJson: PackageJson | null): string | null {
  const version = packageJson?.dependencies?.eve ?? packageJson?.devDependencies?.eve;
  return typeof version === "string" && version.trim().length > 0 ? version.trim() : null;
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function readPackageJson(sourcePath: string): Promise<PackageJson | null> {
  try {
    const raw = await readFile(path.join(sourcePath, "package.json"), "utf8");
    return parsePackageJson(raw);
  } catch {
    return null;
  }
}

function parsePackageJson(raw: string | undefined): PackageJson | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PackageJson;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export {
  allocateAvailableHostPort,
  claimInFlightPort,
  isTcpPortAvailable,
  releaseInFlightPort,
} from "../runtime/ports.js";

/**
 * Maps the worker-visible durable sandbox cache to the path the host Docker
 * daemon resolves for bind mounts. A custom cache inside EVELAND_DATA_DIR is
 * mapped by relative suffix; a cache outside that root is assumed to already
 * be host-visible (the native-worker case).
 */
/**
 * Every project's durable agent memory lives at
 * `<EVELAND_DATA_DIR>/memory/<processSafeName(projectId)>` -- always derived,
 * never separately configured: memory storage adds no operator knob, and the
 * agent side reads only the injected EVELAND_MEMORY_ROOT (never
 * EVELAND_DATA_DIR -- deriving paths from the data root is how the observer's
 * per-cwd path split happened). Keyed by project rather than deployment so
 * memories survive redeploys. The worker/host duality mirrors
 * resolveSandboxCacheDirs: `hostDir` is what the Docker daemon can mount when
 * the worker itself runs inside Compose.
 */
export function resolveMemoryRootDirs(
  env: NodeJS.ProcessEnv,
  projectId: string,
): { workerDir: string; hostDir: string } {
  const dataDir = path.resolve(env.EVELAND_DATA_DIR ?? ".eveland-data");
  const hostDataDir = path.resolve(env.EVELAND_HOST_DATA_DIR ?? dataDir);
  const safeProjectId = processSafeName(projectId);
  return {
    workerDir: path.join(dataDir, "memory", safeProjectId),
    hostDir: path.join(hostDataDir, "memory", safeProjectId),
  };
}

export function resolveSandboxCacheDirs(
  env: NodeJS.ProcessEnv,
  projectId: string,
): { workerDir: string; hostDir: string } {
  const dataDir = path.resolve(env.EVELAND_DATA_DIR ?? ".eveland-data");
  const hostDataDir = path.resolve(env.EVELAND_HOST_DATA_DIR ?? dataDir);
  const workerRoot = resolveSandboxCacheRoot(env);
  const relativeRoot = path.relative(dataDir, workerRoot);
  const outsideDataDir =
    relativeRoot === ".." ||
    relativeRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeRoot);
  const hostRoot = outsideDataDir ? workerRoot : path.resolve(hostDataDir, relativeRoot);
  return {
    workerDir: resolveProjectSandboxCacheDir(workerRoot, projectId),
    hostDir: resolveProjectSandboxCacheDir(hostRoot, projectId),
  };
}

export async function invalidateGatewayRouteCache(
  env: NodeJS.ProcessEnv,
  routes: Array<{ hostname: string }>,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const gatewayUrl = env.EVELAND_GATEWAY_INTERNAL_URL?.replace(/\/$/, "");
  const serviceToken = env.EVELAND_GATEWAY_SERVICE_TOKEN;
  if (!gatewayUrl || !serviceToken) return;
  for (const route of routes) {
    const response = await fetchImplementation(`${gatewayUrl}/internal/cache/invalidate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hostname: route.hostname }),
    });
    if (!response.ok)
      throw new Error(
        `Agent Gateway returned ${response.status} while invalidating ${route.hostname}.`,
      );
  }
}
