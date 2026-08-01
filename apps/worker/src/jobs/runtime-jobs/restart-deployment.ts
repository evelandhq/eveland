import type { Store } from "@eveland/db";
import { access, mkdir } from "node:fs/promises";

import { waitForOwnedHttpHealth } from "../../runtime/health.js";
import { createRuntimeAdapterForKind } from "../../runtime/select.js";
import {
  composeDeploymentEnv,
  resolveRuntimeCommandContext,
  resolveSandboxCacheDirs,
  stopStartedProcessOnFailure,
} from "../process-support.js";
import type { ProcessJobOptions } from "../process-types.js";
import {
  prepareDeploymentObservability,
  warnStaleObserverRelease,
} from "../process-observability.js";
import { createDeploymentStartInput } from "./deployment-start-input.js";
import { settleDeploymentStatus } from "./deployment-status.js";
import type { RuntimeJob } from "./types.js";

export async function handleRestartDeploymentJob(
  store: Store,
  job: RuntimeJob<"restart_deployment">,
  options: ProcessJobOptions,
): Promise<void> {
  // Flip to "starting" and log before any load can throw so a failed restart
  // still leaves a visible trail for the generic failure path.
  await store.updateProjectState(job.projectId, {
    deploymentStatus: "starting",
  });
  await store.appendLog({
    projectId: job.projectId,
    type: "deploy",
    line: "Restart requested.",
  });

  const project = await store.getProject(job.projectId);
  if (!project) {
    throw new Error(`Project ${job.projectId} not found.`);
  }
  const requestedDeploymentId = job.payload.deploymentId ?? null;
  const deployment = requestedDeploymentId
    ? await store.getDeployment(requestedDeploymentId)
    : await store.getCurrentDeployment(job.projectId);
  if (!deployment) {
    throw new Error(
      requestedDeploymentId
        ? `Deployment ${requestedDeploymentId} not found.`
        : "No deployment to restart.",
    );
  }
  if (deployment.projectId !== job.projectId) {
    throw new Error(
      `Deployment ${deployment.id} does not belong to project ${job.projectId}.`,
    );
  }
  // A queued restart that lost the race to an archive must not resurrect it.
  if (deployment.status === "archived") {
    const production = await store.getCurrentDeployment(job.projectId);
    await store.updateProjectState(job.projectId, {
      deploymentStatus: production?.status ?? "not_deployed",
    });
    await store.appendLog({
      projectId: job.projectId,
      deploymentId: deployment.id,
      type: "deploy",
      line: `Restart skipped: deployment ${deployment.deploymentKey} is archived.`,
    });
    return;
  }
  const release = await store.getRelease(deployment.releaseId);
  if (!release) {
    throw new Error(
      `Release ${deployment.releaseId} not found for deployment ${deployment.id}.`,
    );
  }
  const revision = await store.getSourceRevision(release.sourceRevisionId);
  if (!revision) {
    throw new Error(
      `Source revision ${release.sourceRevisionId} not found for release ${release.id}.`,
    );
  }
  // Check before stopping the current process; restart cannot fall back to
  // persisted files because its existing release must remain recoverable.
  try {
    await access(revision.sourcePath);
  } catch {
    throw new Error(
      `Source directory for revision ${revision.id} is missing: ${revision.sourcePath}. Re-import the source and deploy instead.`,
    );
  }

  const adapter =
    options.runtime ??
    (options.runtimeForKind ?? createRuntimeAdapterForKind)(
      deployment.runtimeKind,
    );
  const { env, secretValues } = await composeDeploymentEnv(
    store,
    project.id,
    deployment.id,
    options,
  );
  const commandContext = await resolveRuntimeCommandContext(
    revision.sourcePath,
  );

  await adapter.stopProcess(deployment.containerName);
  let restarted = false;
  try {
    // The restarted process binds deployment.hostPort directly; retire any
    // instance endpoint claims before replacing the process.
    for (const instance of await store.listDeploymentRuntimeInstances(
      deployment.id,
    )) {
      if (
        instance.status === "starting" ||
        instance.status === "ready" ||
        instance.status === "draining"
      ) {
        await store.updateRuntimeInstance(instance.id, {
          status: "stopped",
          endpointHost: null,
          endpointPort: null,
        });
      }
    }
    const sandboxCache = resolveSandboxCacheDirs(process.env, project.id);
    await mkdir(sandboxCache.workerDir, { recursive: true });
    const observability = await prepareDeploymentObservability({
      store,
      env: process.env,
      projectId: project.id,
      releaseId: release.id,
      deploymentId: deployment.id,
      runtimeKind: adapter.name,
      nodeEnv: options.nodeEnv ?? process.env.NODE_ENV,
    });
    await warnStaleObserverRelease(store, {
      projectId: project.id,
      deploymentId: deployment.id,
      release,
    });
    await adapter.startProcess(
      createDeploymentStartInput({
        processName: deployment.containerName,
        releaseRef: release.imageTag,
        port: deployment.hostPort,
        deploymentId: deployment.id,
        env,
        commandContext,
        runtimeKind: adapter.name,
        sandboxCacheDirs: sandboxCache,
        observabilityPolicyDirs: observability,
      }),
    );
    restarted = true;
    await waitForOwnedHttpHealth({
      host: "127.0.0.1",
      port: deployment.hostPort,
      timeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
      processName: deployment.containerName,
      runtime: adapter,
      ...(options.waitForDeployment
        ? { waitForHealth: options.waitForDeployment }
        : {}),
    });
  } catch (error) {
    if (restarted) {
      await stopStartedProcessOnFailure(
        store,
        job.projectId,
        adapter,
        deployment.containerName,
        "restart",
        secretValues,
      );
    }
    await settleDeploymentStatus(store, deployment.id, "stopped").catch(
      () => undefined,
    );
    throw error;
  }

  // A persistence failure here must not stop the healthy, known process.
  await settleDeploymentStatus(store, deployment.id, "running");
  await store.updateProjectState(job.projectId, {
    deploymentStatus: "running",
  });
  await store.appendLog({
    projectId: job.projectId,
    deploymentId: deployment.id,
    type: "deploy",
    line: `Deployment running on 127.0.0.1:${deployment.hostPort}.`,
  });
}
