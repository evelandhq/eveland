import type { Store } from "@eveland/db";
import { rm } from "node:fs/promises";
import path from "node:path";

import { createRuntimeAdapterForKind } from "../../runtime/select.js";
import type { ProcessJobOptions } from "../process-types.js";
import type { RuntimeJob } from "./types.js";

export async function handleArchiveDeploymentJob(
  store: Store,
  job: RuntimeJob<"archive_deployment">,
  options: ProcessJobOptions,
): Promise<void> {
  const deploymentId = job.payload.deploymentId;
  const deployment = await store.getDeployment(deploymentId);
  if (!deployment || deployment.projectId !== job.projectId)
    throw new Error("Deployment not found for archive.");
  if (job.payload.automatic === true && deployment.status !== "stopped") {
    return;
  }
  const configuredRetention = Number(
    process.env.EVELAND_RELEASE_RETENTION ?? 3,
  );
  const retention = await store.getDeploymentRetention(
    job.projectId,
    Number.isFinite(configuredRetention)
      ? Math.max(3, Math.floor(configuredRetention))
      : 3,
    {
      playgroundIdleTtlMs: Number(
        process.env.EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS ?? 86_400_000,
      ),
      apiIdleTtlMs: Number(
        process.env.EVELAND_API_SESSION_IDLE_TTL_MS ?? 604_800_000,
      ),
    },
  );
  const policy = retention.find(
    (entry) => entry.deployment.id === deployment.id,
  );
  if (!policy || policy.protected) {
    throw new Error(
      `Deployment is protected from archive${policy?.reasons.length ? `: ${policy.reasons.join(", ")}` : "."}`,
    );
  }
  const adapter =
    options.runtime?.name === deployment.runtimeKind
      ? options.runtime
      : (options.runtimeForKind ?? createRuntimeAdapterForKind)(
          deployment.runtimeKind,
        );
  if (deployment.status === "running" || deployment.status === "draining")
    await adapter.stopProcess(deployment.containerName);
  const release = await store.getRelease(deployment.releaseId);
  if (release && adapter.removeRelease)
    await adapter.removeRelease(release.imageTag);
  await rm(
    path.join(
      options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data",
      "builds",
      job.projectId,
      deployment.releaseId,
    ),
    { recursive: true, force: true },
  );
  await store.updateDeploymentStatus(deployment.id, "archived");
  await store.appendLog({
    projectId: job.projectId,
    deploymentId,
    type: "deploy",
    line:
      job.payload.automatic === true
        ? `Deployment ${deployment.deploymentKey} automatically archived by retention policy.`
        : `Deployment ${deployment.deploymentKey} archived.`,
  });
}
