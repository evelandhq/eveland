import type { Store } from "@eveland/db";

import { createRuntimeAdapterForKind } from "../../runtime/select.js";
import { dropProjectWorkflowWorld } from "../../runtime/workflow-world-bootstrap.js";
import { removeManagedProjectFiles } from "../process-support.js";
import type { ProcessJobOptions } from "../process-types.js";
import type { RuntimeJob } from "./types.js";

export async function handleDeleteProjectJob(
  store: Store,
  job: RuntimeJob<"delete_project">,
  options: ProcessJobOptions,
): Promise<void> {
  const project = await store.getProject(job.projectId);
  if (!project) {
    // Idempotent re-run of a half-finished delete: the project row is already
    // gone, so there is nothing left to stop or remove.
    return;
  }

  // The store only makes this job claimable after other running work for the
  // project has completed, so every process created by an earlier build is
  // represented by a Deployment before cleanup starts.
  const deployments = await store.listDeployments(job.projectId);
  const liveDeployments = deployments.filter(
    (deployment) =>
      deployment.status === "running" || deployment.status === "draining",
  );
  if (liveDeployments.length > 0) {
    await store.appendLog({
      projectId: job.projectId,
      type: "deploy",
      line: `Stopping ${liveDeployments.length} deployment(s) before deleting project.`,
    });
    for (const deployment of liveDeployments) {
      const stopAdapter =
        options.runtime?.name === deployment.runtimeKind
          ? options.runtime
          : (options.runtimeForKind ?? createRuntimeAdapterForKind)(
              deployment.runtimeKind,
            );
      await stopAdapter.stopProcess(deployment.containerName);
    }
  }

  const removedReleases = new Set<string>();
  for (const deployment of deployments) {
    const releaseKey = `${deployment.runtimeKind}:${deployment.releaseId}`;
    if (removedReleases.has(releaseKey)) continue;
    const release = await store.getRelease(deployment.releaseId);
    const adapter =
      options.runtime?.name === deployment.runtimeKind
        ? options.runtime
        : (options.runtimeForKind ?? createRuntimeAdapterForKind)(
            deployment.runtimeKind,
          );
    if (release && adapter.removeRelease)
      await adapter.removeRelease(release.imageTag);
    removedReleases.add(releaseKey);
  }

  // The project's derived workflow database goes with the project. Dropped
  // before deleteProject so a failed drop leaves a retryable project row.
  await (options.dropProjectWorkflowWorld ?? dropProjectWorkflowWorld)(
    process.env,
    job.projectId,
  );

  const sourceRevisions = await store.listSourceRevisions(job.projectId);
  const pendingSourcePaths = job.payload.sourcePaths ?? [];
  await removeManagedProjectFiles(
    options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data",
    job.projectId,
    [
      ...sourceRevisions.map((revision) => revision.sourcePath),
      ...pendingSourcePaths,
    ],
    deployments.map((deployment) => deployment.containerName),
  );

  // Must remain last: writes referencing the project are invalid after this.
  await store.deleteProject(job.projectId);
}
