import type { ReleaseRecord } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";
import { access, mkdir } from "node:fs/promises";

import { resolveAgentObservabilityDirs } from "../runtime/observability/policy.js";
import type { ProcessStartInput, RuntimeAdapter, RuntimeCommandContext } from "../runtime/types.js";
import {
  prepareDeploymentObservability,
  warnStaleObserverRelease,
} from "./process-observability.js";
import {
  composeDeploymentEnv,
  devSecretKey,
  resolveRuntimeCommandContext,
  resolveSandboxCacheDirs,
} from "./process-support.js";
import type { ProcessJobOptions } from "./process-types.js";

export type AdapterVisibleDirectories = Readonly<{
  workerDir: string;
  hostDir: string;
}>;

export type DeploymentLaunchPrerequisites = Readonly<{
  projectId: string;
  deploymentId: string;
  runtimeKind: RuntimeAdapter["name"];
  env: Record<string, string>;
  secretValues: string[];
  commandContext: RuntimeCommandContext;
  sandboxCacheDirs: AdapterVisibleDirectories;
  observabilityPolicyDirs: AdapterVisibleDirectories;
  observability: Readonly<{
    appSecretKey: string;
    nodeEnv: string | undefined;
  }>;
}>;

export type DeploymentLaunchContext = Readonly<{
  deploymentId: string;
  runtimeKind: RuntimeAdapter["name"];
  env: Record<string, string>;
  secretValues: string[];
  commandContext: RuntimeCommandContext;
  sandboxCacheDirs: AdapterVisibleDirectories;
  observabilityPolicyDirs: AdapterVisibleDirectories;
}>;

export type DeploymentStartInput = Readonly<{
  processName: string;
  releaseRef: string;
  port: number;
  launchContext: DeploymentLaunchContext;
}>;

export type LaunchInputStore = Pick<
  Store,
  "listSecretRecords" | "getSharedAgentEnvironmentRecord" | "getObservabilityPolicy" | "appendLog"
>;

export function createDeploymentStartInput(input: DeploymentStartInput): ProcessStartInput {
  const usesHostVisiblePaths = input.launchContext.runtimeKind === "docker";
  return {
    processName: input.processName,
    releaseRef: input.releaseRef,
    port: input.port,
    env: {
      ...input.launchContext.env,
      EVELAND_DEPLOYMENT_ID: input.launchContext.deploymentId,
    },
    commandContext: input.launchContext.commandContext,
    sandboxCacheDir: usesHostVisiblePaths
      ? input.launchContext.sandboxCacheDirs.hostDir
      : input.launchContext.sandboxCacheDirs.workerDir,
    observabilityPolicyDir: usesHostVisiblePaths
      ? input.launchContext.observabilityPolicyDirs.hostDir
      : input.launchContext.observabilityPolicyDirs.workerDir,
  };
}

export async function resolveDeploymentLaunchPrerequisites(input: {
  store: Pick<LaunchInputStore, "listSecretRecords" | "getSharedAgentEnvironmentRecord">;
  workerEnv: NodeJS.ProcessEnv;
  projectId: string;
  deploymentId: string;
  runtimeKind: RuntimeAdapter["name"];
  sourcePath: string;
  persistedSourceFiles?: ReadonlyArray<{ path: string; content: string }>;
  persistedCommandContext?: RuntimeCommandContext;
  options: ProcessJobOptions;
}): Promise<DeploymentLaunchPrerequisites> {
  // Resolve sequentially: environment bootstrap errors should remain visible
  // before source metadata errors, matching the existing launch paths.
  const appSecretKey = input.options.appSecretKey ?? input.workerEnv.APP_SECRET_KEY ?? devSecretKey;
  const { env, secretValues } = await composeDeploymentEnv(
    input.store,
    input.projectId,
    // The deployment id reaches the runtime as EVELAND_DEPLOYMENT_ID, which is
    // what the platform world records on every run it creates. Without it a run
    // could not be pinned to a deployment able to replay it.
    { ...input.options, appSecretKey, deploymentId: input.deploymentId },
    input.workerEnv,
  );
  const commandContext = await resolveRuntimeCommandContext(
    input.sourcePath,
    input.persistedSourceFiles ? [...input.persistedSourceFiles] : undefined,
    input.persistedCommandContext,
  );

  return {
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    runtimeKind: input.runtimeKind,
    env,
    secretValues,
    commandContext,
    sandboxCacheDirs: resolveSandboxCacheDirs(input.workerEnv, input.projectId),
    observabilityPolicyDirs: resolveAgentObservabilityDirs(
      input.workerEnv,
      input.projectId,
      input.deploymentId,
    ),
    observability: {
      appSecretKey,
      nodeEnv: input.options.nodeEnv ?? input.workerEnv.NODE_ENV,
    },
  };
}

export async function ensureDeploymentLaunchSandbox(
  prerequisites: Pick<DeploymentLaunchPrerequisites, "sandboxCacheDirs">,
): Promise<void> {
  await mkdir(prerequisites.sandboxCacheDirs.workerDir, { recursive: true });
}

export async function materializeDeploymentLaunchContext(input: {
  store: Pick<LaunchInputStore, "getObservabilityPolicy" | "appendLog">;
  releaseId: string;
  prerequisites: DeploymentLaunchPrerequisites;
  staleRelease?: ReleaseRecord;
}): Promise<DeploymentLaunchContext> {
  const observability = await prepareDeploymentObservability({
    store: input.store,
    env: {},
    directories: input.prerequisites.observabilityPolicyDirs,
    projectId: input.prerequisites.projectId,
    releaseId: input.releaseId,
    deploymentId: input.prerequisites.deploymentId,
    runtimeKind: input.prerequisites.runtimeKind,
    nodeEnv: input.prerequisites.observability.nodeEnv,
    appSecretKey: input.prerequisites.observability.appSecretKey,
  });
  if (input.staleRelease) {
    await warnStaleObserverRelease(input.store, {
      projectId: input.prerequisites.projectId,
      deploymentId: input.prerequisites.deploymentId,
      release: input.staleRelease,
    });
  }

  return {
    deploymentId: input.prerequisites.deploymentId,
    runtimeKind: input.prerequisites.runtimeKind,
    env: input.prerequisites.env,
    secretValues: input.prerequisites.secretValues,
    commandContext: input.prerequisites.commandContext,
    sandboxCacheDirs: input.prerequisites.sandboxCacheDirs,
    observabilityPolicyDirs: {
      workerDir: observability.workerDir,
      hostDir: observability.hostDir,
    },
  };
}

export async function resolveRecoverableRuntimeSource(
  store: Pick<Store, "listSourceRevisionFiles">,
  revision: Readonly<{
    id: string;
    sourcePath: string;
    summary: Record<string, unknown>;
  }>,
): Promise<{
  persistedSourceFiles: Awaited<ReturnType<Store["listSourceRevisionFiles"]>>;
  persistedCommandContext?: RuntimeCommandContext;
}> {
  try {
    await access(revision.sourcePath);
    return { persistedSourceFiles: [] };
  } catch {
    const persistedSourceFiles = await store.listSourceRevisionFiles(revision.id);
    if (!persistedSourceFiles.some((file) => file.path === "package.json")) {
      throw new Error(
        `Source directory for revision ${revision.id} is missing: ${revision.sourcePath}. Re-import the source and deploy instead.`,
      );
    }
    const persistedCommandContext = parseRuntimeCommandContext(
      revision.summary.runtimeCommandContext,
    );
    return {
      persistedSourceFiles,
      ...(persistedCommandContext ? { persistedCommandContext } : {}),
    };
  }
}

function parseRuntimeCommandContext(value: unknown): RuntimeCommandContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.packageManager === "pnpm") {
    return candidate.hasLockfile === true
      ? { packageManager: "pnpm", hasLockfile: true }
      : undefined;
  }
  if (candidate.packageManager === "npm" && typeof candidate.hasLockfile === "boolean") {
    return {
      packageManager: "npm",
      hasLockfile: candidate.hasLockfile,
    };
  }
  return undefined;
}
