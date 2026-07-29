import type { SharedAgentEnvironmentRecord } from "@eveland/core/contracts";
import { resolveSchedulerRuntimeSecret } from "@eveland/core/server/scheduler-dispatch";
import {
  decryptSecretValue,
  maskKnownSecrets,
  mergeRuntimeEnvironment,
  type EncryptedSecret,
} from "@eveland/core/server/secrets";
import {
  isSupportedEveDependency,
  unsupportedEveVersionMessage,
} from "@eveland/core/source";
import type { Store } from "@eveland/db";
import { access, readFile, realpath, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  resolveProjectSandboxCacheDir,
  resolveSandboxCacheRoot,
} from "../runtime/systemd.js";
import {
  processSafeName,
  type RuntimeAdapter,
  type RuntimeCommandContext,
} from "../runtime/types.js";
import { ensureProjectWorkflowWorld } from "../runtime/workflow-world-bootstrap.js";
import { resolveIdentityDeploymentConfiguration } from "../runtime/identity-config-reconciler.js";

import type {
  ProcessJobOptions,
  ScheduleDispatchInput,
} from "./process-types.js";

export const devSecretKey = "eveland-dev-secret-key-000000000";
const runtimeDiagnosticMaxCharacters = 32_000;

export async function dispatchScheduleToRuntime(
  input: ScheduleDispatchInput,
): Promise<{ sessionIds: string[] }> {
  const timeoutMs = Number(
    process.env.EVELAND_SCHEDULER_DISPATCH_TIMEOUT_MS ?? 120_000,
  );
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
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error(
        `Scheduler Channel timed out after ${timeoutMs}ms for ScheduleRun ${input.scheduleRunId} on Deployment ${input.deploymentId}.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!response.ok)
    throw new Error(
      `Scheduler Channel rejected dispatch with HTTP ${response.status}.`,
    );
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
  ]);
  const allowedSourceRoots = [
    path.join(root, "sources"),
    path.join(root, "uploads"),
  ];

  for (const processName of processNames) {
    ownedPaths.add(
      path.join(root, "deployment-env", `${processSafeName(processName)}.env`),
    );
  }

  for (const sourcePath of sourcePaths) {
    const candidate = path.resolve(sourcePath);
    const allowedRoot = allowedSourceRoots.find((entry) =>
      isStrictlyWithin(candidate, entry),
    );
    if (!allowedRoot) continue;
    const relativeSegments = path
      .relative(allowedRoot, candidate)
      .split(path.sep);
    const ownedCandidate =
      allowedRoot === allowedSourceRoots[1] &&
      relativeSegments[0]?.startsWith("zip-")
        ? path.join(allowedRoot, relativeSegments[0])
        : candidate;
    const [realCandidate, realAllowedRoot] = await Promise.all([
      realpath(ownedCandidate).catch(() => null),
      realpath(allowedRoot).catch(() => null),
    ]);
    if (
      realCandidate &&
      realAllowedRoot &&
      isStrictlyWithin(realCandidate, realAllowedRoot)
    ) {
      ownedPaths.add(ownedCandidate);
    }
  }

  await Promise.all(
    [...ownedPaths].map((ownedPath) =>
      rm(ownedPath, { recursive: true, force: true }),
    ),
  );
}

export function isStrictlyWithin(candidate: string, root: string): boolean {
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
  store: Store,
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

export function limitRuntimeDiagnostic(input: string): string {
  if (input.length <= runtimeDiagnosticMaxCharacters) return input;
  const marker = "\n… runtime diagnostics truncated …\n";
  const prefixLength = 2_000;
  const suffixLength =
    runtimeDiagnosticMaxCharacters - prefixLength - marker.length;
  return `${input.slice(0, prefixLength)}${marker}${input.slice(-suffixLength)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Shared by build_deploy and restart_deployment. Durable-workflow gating is
// NOT part of this: build_deploy only calls this after deciding the deploy may
// proceed, and restart never re-gates an already-deployed release.
export async function composeDeploymentEnv(
  store: Store,
  projectId: string,
  deploymentId: string,
  options: ProcessJobOptions,
): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const isProduction = nodeEnv === "production";
  const workflowPostgresUrl =
    options.workflowPostgresUrl ?? process.env.WORKFLOW_POSTGRES_URL;
  // Each project gets its own physical workflow database derived from the
  // platform base URL. A single shared database let any runtime claim any
  // project's queued turns and re-enqueue every project's active runs on
  // startup, so the database is created and bootstrapped here, before any
  // process starts with its URL.
  const ensureWorld =
    options.ensureProjectWorkflowWorld ?? ensureProjectWorkflowWorld;
  const projectWorkflowUrl = workflowPostgresUrl
    ? await ensureWorld(
        { ...process.env, WORKFLOW_POSTGRES_URL: workflowPostgresUrl },
        projectId,
      )
    : undefined;
  const schedulerRuntimeSecret =
    options.schedulerRuntimeSecret ??
    resolveSchedulerRuntimeSecret(process.env);
  const schedulerRedeemUrl =
    options.schedulerRedeemUrl ?? process.env.EVELAND_SCHEDULER_REDEEM_URL;
  const appSecretKey =
    options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey;
  const identityConfiguration = resolveIdentityDeploymentConfiguration({
    dataDir: options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data",
    nodeEnv,
    issuer: options.identityIssuer || process.env.EVELAND_IDENTITY_ISSUER,
    jwksUrl:
      options.identityJwksUrl || process.env.EVELAND_IDENTITY_JWKS_URL,
  });
  const identityIssuer = identityConfiguration?.issuer;
  const identityJwksUrl = identityConfiguration?.jwksUrl;
  const secrets = await readRuntimeSecrets(store, projectId, appSecretKey);
  const sharedEnvironment = readSharedAgentEnvironmentValues(
    await store.getSharedAgentEnvironmentRecord(),
    appSecretKey,
  );
  // Project secrets are runtime input, but the workflow database is
  // platform-owned and bootstrapped before this worker accepts jobs. Keep its
  // URL reserved so a project cannot silently redirect the injected world to
  // an uninitialized or tenant-controlled database.
  const reserved = {
    EVELAND_PROJECT_ID: projectId,
    ...(identityIssuer
      ? { EVELAND_IDENTITY_ISSUER: identityIssuer.replace(/\/$/, "") }
      : {}),
    ...(identityJwksUrl
      ? { EVELAND_IDENTITY_JWKS_URL: identityJwksUrl }
      : {}),
    ...(projectWorkflowUrl
      ? { WORKFLOW_POSTGRES_URL: projectWorkflowUrl }
      : {}),
    ...(schedulerRuntimeSecret
      ? { EVELAND_SCHEDULER_RUNTIME_SECRET: schedulerRuntimeSecret }
      : {}),
    ...(schedulerRedeemUrl
      ? { EVELAND_SCHEDULER_REDEEM_URL: schedulerRedeemUrl }
      : {}),
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
    ...(schedulerRuntimeSecret ? [schedulerRuntimeSecret] : []),
  ];
  return { env, secretValues };
}

export function readSharedAgentEnvironmentValues(
  environment: SharedAgentEnvironmentRecord | null,
  appSecretKey: string,
): Record<string, string> {
  return Object.fromEntries(
    (environment?.entries ?? []).map((entry) => [
      entry.key,
      decryptSecretValue(
        parseEncryptedSecret(entry.encryptedValue),
        appSecretKey,
      ),
    ]),
  );
}

export async function readRuntimeSecrets(
  store: Store,
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
  if (
    parsed.algorithm !== "aes-256-gcm" ||
    !parsed.iv ||
    !parsed.authTag ||
    !parsed.ciphertext
  ) {
    throw new Error("Invalid encrypted secret payload.");
  }
  return parsed as EncryptedSecret;
}

type GitCredentialPayload = {
  userId: string;
  host: string;
  encryptedToken: string;
  persistAfterImport: boolean;
};

export function readGitCredentialPayload(
  value: unknown,
): GitCredentialPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<GitCredentialPayload>;
  if (
    typeof candidate.userId !== "string" ||
    typeof candidate.host !== "string" ||
    typeof candidate.encryptedToken !== "string" ||
    typeof candidate.persistAfterImport !== "boolean"
  )
    return null;
  return candidate as GitCredentialPayload;
}

export async function resolveRuntimeCommandContext(
  sourcePath: string,
  persistedFiles: Array<{ path: string; content: string }> = [],
): Promise<RuntimeCommandContext> {
  const packageJson =
    (await readPackageJson(sourcePath)) ??
    parsePackageJson(
      persistedFiles.find((file) => file.path === "package.json")?.content,
    );
  const eveVersion = declaredEveVersion(packageJson);
  if (!isSupportedEveDependency(eveVersion)) {
    throw new Error(unsupportedEveVersionMessage(eveVersion));
  }
  const persistedPaths = new Set(persistedFiles.map((file) => file.path));
  const hasPnpmLockfile =
    persistedPaths.has("pnpm-lock.yaml") ||
    (await fileExists(path.join(sourcePath, "pnpm-lock.yaml")));
  const hasNpmLockfile =
    persistedPaths.has("package-lock.json") ||
    (await fileExists(path.join(sourcePath, "package-lock.json")));
  return {
    isEveProject: true,
    ...(hasPnpmLockfile
      ? { hasLockfile: true as const, packageManager: "pnpm" as const }
      : { hasLockfile: hasNpmLockfile, packageManager: "npm" as const }),
    scripts: packageJson?.scripts ?? {},
  };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function declaredEveVersion(
  packageJson: PackageJson | null,
): string | null {
  const version =
    packageJson?.dependencies?.eve ?? packageJson?.devDependencies?.eve;
  return typeof version === "string" && version.trim().length > 0
    ? version.trim()
    : null;
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export async function readPackageJson(
  sourcePath: string,
): Promise<PackageJson | null> {
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

export async function allocateAvailableHostPort(
  startPort = Number(process.env.EVELAND_DEPLOYMENT_PORT ?? 41000),
  endPort = startPort + 100,
  reservedPorts: ReadonlySet<number> = new Set(),
): Promise<number> {
  for (let port = startPort; port <= endPort; port += 1) {
    if (reservedPorts.has(port)) continue;
    if (await isTcpPortAvailable("127.0.0.1", port)) {
      return port;
    }
  }

  throw new Error(
    `No available deployment host port in range ${startPort}-${endPort}.`,
  );
}

/**
 * Maps the worker-visible durable sandbox cache to the path the host Docker
 * daemon resolves for bind mounts. A custom cache inside EVELAND_DATA_DIR is
 * mapped by relative suffix; a cache outside that root is assumed to already
 * be host-visible (the native-worker case).
 */
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
  const hostRoot = outsideDataDir
    ? workerRoot
    : path.resolve(hostDataDir, relativeRoot);
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
    const response = await fetchImplementation(
      `${gatewayUrl}/internal/cache/invalidate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ hostname: route.hostname }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Gateway returned ${response.status} while invalidating ${route.hostname}.`,
      );
  }
}

export async function isTcpPortAvailable(
  host: string,
  port: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const cleanup = () => {
      server.removeAllListeners();
    };

    server.once("listening", () => {
      server.close((error) => {
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      });
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(port, host);
  });
}
