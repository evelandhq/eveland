import type { Store } from "@eveland/db";
import { access } from "node:fs/promises";

import { waitForOwnedHttpHealth } from "../../runtime/health.js";
import { createRuntimeAdapterForKind } from "../../runtime/select.js";
import {
  createDeploymentStartInput,
  ensureDeploymentLaunchSandbox,
  materializeDeploymentLaunchContext,
  resolveDeploymentLaunchPrerequisites,
  type LaunchInputStore,
} from "../deployment-launch-context.js";
import { stopStartedProcessOnFailure } from "../process-support.js";
import type { ProcessJobOptions } from "../process-types.js";
import { settleDeploymentStatus } from "./deployment-status.js";
import type { RuntimeJob } from "./types.js";

// The narrow persistence port this handler and its launch helpers need.
type RestartDeploymentStore = Pick<
  Store,
  | "appendLog"
  | "getCurrentDeployment"
  | "getDeployment"
  | "getProject"
  | "getRelease"
  | "getSourceRevision"
  | "listDeploymentRuntimeInstances"
  | "transitionDeploymentStatus"
  | "updateProjectState"
  | "updateRuntimeInstance"
> &
  LaunchInputStore;

export async function handleRestartDeploymentJob(
  store: RestartDeploymentStore,
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
    throw new Error(`Deployment ${deployment.id} does not belong to project ${job.projectId}.`);
  }
  // A queued restart that lost the race to an archive must not resurrect it.
  if (deployment.status === "archived" || deployment.status === "archiving") {
    const production = await store.getCurrentDeployment(job.projectId);
    await store.updateProjectState(job.projectId, {
      deploymentStatus: production?.status ?? "not_deployed",
    });
    await store.appendLog({
      projectId: job.projectId,
      deploymentId: deployment.id,
      type: "deploy",
      line: `Restart skipped: deployment ${deployment.deploymentKey} is ${deployment.status}.`,
    });
    return;
  }
  const release = await store.getRelease(deployment.releaseId);
  if (!release) {
    throw new Error(`Release ${deployment.releaseId} not found for deployment ${deployment.id}.`);
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
    (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
  const launchPrerequisites = await resolveDeploymentLaunchPrerequisites({
    store,
    workerEnv: process.env,
    projectId: project.id,
    deploymentId: deployment.id,
    runtimeKind: adapter.name,
    sourcePath: revision.sourcePath,
    options,
  });

  await adapter.stopProcess(deployment.containerName);
  let restarted = false;
  try {
    // The restarted process binds deployment.hostPort directly; retire any
    // instance endpoint claims before replacing the process.
    for (const instance of await store.listDeploymentRuntimeInstances(deployment.id)) {
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
    await ensureDeploymentLaunchSandbox(launchPrerequisites);
    const launchContext = await materializeDeploymentLaunchContext({
      store,
      releaseId: release.id,
      prerequisites: launchPrerequisites,
      staleRelease: release,
    });
    await adapter.startProcess(
      createDeploymentStartInput({
        processName: deployment.containerName,
        releaseRef: release.imageTag,
        port: deployment.hostPort,
        launchContext,
      }),
    );
    restarted = true;
    await waitForOwnedHttpHealth({
      host: "127.0.0.1",
      port: deployment.hostPort,
      timeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
      processName: deployment.containerName,
      runtime: adapter,
      ...(options.waitForDeployment ? { waitForHealth: options.waitForDeployment } : {}),
    });
  } catch (error) {
    if (restarted) {
      await stopStartedProcessOnFailure(
        store,
        job.projectId,
        adapter,
        deployment.containerName,
        "restart",
        launchPrerequisites.secretValues,
      );
    }
    await settleDeploymentStatus(store, deployment.id, "stopped").catch(() => undefined);
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
