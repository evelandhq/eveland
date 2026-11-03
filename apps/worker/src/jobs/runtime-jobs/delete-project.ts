import type { Store } from "@evelandhq/db";

import { dropEvelandWorkflowTenant } from "../../runtime/eveland-workflow-world-bootstrap.js";
import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";
import { createRuntimeAdapterForKind } from "../../runtime/select.js";
import { dropProjectWorkflowWorld } from "../../runtime/workflow-world-bootstrap.js";
import {
  revokeProjectModelGatewayKey,
  type ModelGatewayEnvironmentStore,
} from "../model-gateway-environment.js";
import { devSecretKey, removeManagedProjectFiles } from "../process-support.js";
import type { ProcessJobOptions } from "../process-types.js";
import type { RuntimeJob } from "./types.js";

// The narrow persistence port this handler actually needs.
type DeleteProjectStore = Pick<
  Store,
  | "appendLog"
  | "deleteProject"
  | "getProject"
  | "getRelease"
  | "listDeployments"
  | "listSourceRevisions"
> &
  ModelGatewayEnvironmentStore;

export async function handleDeleteProjectJob(
  store: DeleteProjectStore,
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
    (deployment) => deployment.status === "running" || deployment.status === "draining",
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
          : (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
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
        : (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
    if (release && adapter.removeRelease) await adapter.removeRelease(release.imageTag);
    removedReleases.add(releaseKey);
  }

  // The project's derived workflow database goes with the project. Dropped
  // before deleteProject so a failed drop leaves a retryable project row.
  await (options.dropProjectWorkflowWorld ?? dropProjectWorkflowWorld)(process.env, job.projectId);

  // Same for the platform world, where the project owns partitions rather than
  // a database. DROP TABLE on a partition reclaims the space immediately, which
  // is the whole reason the big tables are partitioned by tenant.
  const evelandWorldUrl = resolveWorkflowWorldPlatformUrl(process.env);
  if (evelandWorldUrl) {
    await (options.dropEvelandWorkflowTenant ?? dropEvelandWorkflowTenant)(
      evelandWorldUrl,
      job.projectId,
    );
  }

  // The project's own key on the Model Gateway goes too. A failure leaves the
  // project row for the retry, like the workflow drops above.
  const revocation = await revokeProjectModelGatewayKey(store, job.projectId, {
    appSecretKey: options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey,
    ...(options.modelGatewayKeyClient ? { client: options.modelGatewayKeyClient } : {}),
  });
  if (revocation.status === "orphaned") {
    await store.appendLog({
      projectId: job.projectId,
      type: "deploy",
      line: `WARNING: this project's Model Gateway key ${revocation.alias} was issued on a gateway this instance no longer uses, so Eveland could not revoke it. Delete it on that gateway.`,
    });
  }

  const sourceRevisions = await store.listSourceRevisions(job.projectId);
  const pendingSourcePaths = job.payload.sourcePaths ?? [];
  await removeManagedProjectFiles(
    options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data",
    job.projectId,
    [...sourceRevisions.map((revision) => revision.sourcePath), ...pendingSourcePaths],
    deployments.map((deployment) => deployment.containerName),
  );

  // Must remain last: writes referencing the project are invalid after this.
  await store.deleteProject(job.projectId);
}
