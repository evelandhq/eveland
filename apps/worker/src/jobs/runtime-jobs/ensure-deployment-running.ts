import type { Store } from "@eveland/db";
import { access, mkdir } from "node:fs/promises";

import { startRuntimeInstance } from "../../runtime/activation-manager.js";
import { createRuntimeAdapterForKind } from "../../runtime/select.js";
import {
  composeDeploymentEnv,
  resolveRuntimeCommandContext,
  resolveSandboxCacheDirs,
} from "../process-support.js";
import type { ProcessJobOptions } from "../process-types.js";
import {
  prepareDeploymentObservability,
  warnStaleObserverRelease,
} from "../process-observability.js";
import { createDeploymentStartInput } from "./deployment-start-input.js";
import { settleDeploymentStatus } from "./deployment-status.js";
import type { RuntimeJob } from "./types.js";

export async function handleEnsureDeploymentRunningJob(
  store: Store,
  job: RuntimeJob<"ensure_deployment_running">,
  options: ProcessJobOptions,
): Promise<void> {
  const { deploymentId, runtimeInstanceId } = job.payload;
  const deployment = await store.getDeployment(deploymentId);
  const runtimeInstance = await store.getRuntimeInstance(runtimeInstanceId);
  if (!deployment || deployment.projectId !== job.projectId)
    throw new Error("Deployment activation target is invalid.");
  if (!runtimeInstance || runtimeInstance.deploymentId !== deployment.id)
    throw new Error("RuntimeInstance activation target is invalid.");
  const release = await store.getRelease(deployment.releaseId);
  if (!release)
    throw new Error("Deployment activation Release is missing.");
  const revision = await store.getSourceRevision(release.sourceRevisionId);
  if (!revision)
    throw new Error("Deployment activation SourceRevision is missing.");
  let persistedSourceFiles: Awaited<
    ReturnType<Store["listSourceRevisionFiles"]>
  > = [];
  try {
    await access(revision.sourcePath);
  } catch {
    persistedSourceFiles = await store.listSourceRevisionFiles(revision.id);
    if (!persistedSourceFiles.some((file) => file.path === "package.json")) {
      throw new Error(
        `Source directory for revision ${revision.id} is missing: ${revision.sourcePath}. Re-import the source and deploy instead.`,
      );
    }
  }
  const runtime =
    options.runtime ??
    (options.runtimeForKind ?? createRuntimeAdapterForKind)(
      deployment.runtimeKind,
    );
  const { env } = await composeDeploymentEnv(
    store,
    job.projectId,
    deployment.id,
    options,
  );
  const commandContext = await resolveRuntimeCommandContext(
    revision.sourcePath,
    persistedSourceFiles,
  );
  const sandboxCache = resolveSandboxCacheDirs(process.env, job.projectId);
  await mkdir(sandboxCache.workerDir, { recursive: true });
  const observability = await prepareDeploymentObservability({
    store,
    env: process.env,
    projectId: job.projectId,
    releaseId: release.id,
    deploymentId: deployment.id,
    runtimeKind: runtime.name,
    nodeEnv: options.nodeEnv ?? process.env.NODE_ENV,
  });
  await warnStaleObserverRelease(store, {
    projectId: job.projectId,
    deploymentId: deployment.id,
    release,
  });
  await startRuntimeInstance(
    store,
    {
      deployment,
      runtime,
      startInput: createDeploymentStartInput({
        processName: deployment.containerName,
        releaseRef: release.imageTag,
        port: deployment.hostPort,
        deploymentId: deployment.id,
        env,
        commandContext,
        runtimeKind: runtime.name,
        sandboxCacheDirs: sandboxCache,
        observabilityPolicyDirs: observability,
      }),
    },
    runtimeInstance.id,
    {
      waitForHealth: options.waitForDeployment,
      readyTimeoutMs: Number(
        process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000,
      ),
    },
  );
  // Preserve a concurrent drain/archive decision made during activation.
  await settleDeploymentStatus(store, deployment.id, "running");
  await store.appendLog({
    projectId: job.projectId,
    deploymentId: deployment.id,
    type: "runtime",
    line: `Deployment ${deployment.id} is ready for RuntimeInstance ${runtimeInstance.id}.`,
  });
}
