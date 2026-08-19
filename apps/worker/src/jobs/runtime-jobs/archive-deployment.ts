import type { DeploymentStatus } from "@evelandhq/core/contracts";
import type { Store } from "@evelandhq/db";
import { rm } from "node:fs/promises";
import path from "node:path";

import { listDeploymentsWithActiveWorkflowRuns } from "../../runtime/eveland-workflow-world-runs.js";
import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";
import { createRuntimeAdapterForKind } from "../../runtime/select.js";
import type { ProcessJobOptions } from "../process-types.js";
import { assessWorkflowArchive } from "../workflow-topology-gate.js";
import type { RuntimeJob } from "./types.js";

// Statuses an archive may claim from. "archiving" re-claims a prior attempt
// of this job that failed between claiming and reverting.
const AUTOMATIC_CLAIMABLE: DeploymentStatus[] = ["stopped", "archiving"];
const MANUAL_CLAIMABLE: DeploymentStatus[] = [
  "running",
  "draining",
  "stopped",
  "failed",
  "archiving",
];

// The narrow persistence port this handler actually needs.
type ArchiveDeploymentStore = Pick<
  Store,
  | "appendLog"
  | "getDeployment"
  | "getDeploymentRetention"
  | "getRelease"
  | "transitionDeploymentStatus"
>;

export async function handleArchiveDeploymentJob(
  store: ArchiveDeploymentStore,
  job: RuntimeJob<"archive_deployment">,
  options: ProcessJobOptions,
): Promise<void> {
  const deploymentId = job.payload.deploymentId;
  const deployment = await store.getDeployment(deploymentId);
  if (!deployment || deployment.projectId !== job.projectId)
    throw new Error("Deployment not found for archive.");
  if (deployment.status === "archived") return;
  const automatic = job.payload.automatic === true;
  const claimable = automatic ? AUTOMATIC_CLAIMABLE : MANUAL_CLAIMABLE;
  if (!claimable.includes(deployment.status)) {
    if (automatic) return;
    throw new Error(`Deployment cannot be archived while ${deployment.status}.`);
  }

  // Unknown and unterminated legacy topologies conservatively protect their
  // artifact — it may be the only thing able to resume or diagnose a parked
  // run — until the cutover classifies or managed-terminates them.
  const archiveRelease = await store.getRelease(deployment.releaseId);
  if (!archiveRelease) throw new Error(`Release ${deployment.releaseId} not found for archive.`);
  const archiveDecision = assessWorkflowArchive(archiveRelease, deployment);
  if (!archiveDecision.allowed) {
    if (automatic) {
      await store.appendLog({
        projectId: job.projectId,
        deploymentId: deployment.id,
        type: "runtime",
        line: `Archive skipped: ${archiveDecision.reason}`,
      });
      return;
    }
    throw new Error(archiveDecision.reason);
  }

  // Claim before touching anything: holding "archiving" keeps activation,
  // restart, and the sweepers away while artifacts are removed. Retention is
  // re-checked only after the claim, so an activation that raced in is either
  // visible to the re-check (we revert) or sees the claim and refuses itself.
  const priorStatus: DeploymentStatus =
    deployment.status === "archiving" ? "stopped" : deployment.status;
  const claimed = await store.transitionDeploymentStatus({
    deploymentId,
    to: "archiving",
    from: [deployment.status],
  });
  if (!claimed) {
    if (automatic) return;
    throw new Error("Deployment changed state before archive could claim it.");
  }

  try {
    const configuredRetention = Number(process.env.EVELAND_RELEASE_RETENTION ?? 3);
    const retention = await store.getDeploymentRetention(
      job.projectId,
      Number.isFinite(configuredRetention) ? Math.max(3, Math.floor(configuredRetention)) : 3,
      {
        playgroundIdleTtlMs: Number(
          process.env.EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS ?? 86_400_000,
        ),
        apiIdleTtlMs: Number(process.env.EVELAND_API_SESSION_IDLE_TTL_MS ?? 604_800_000),
        // A run sleeping on a timer holds no session and no lease, so without
        // this the archive would delete the build directory and image that are
        // the only things able to resume it.
        deploymentsWithActiveWorkflowRuns: await (
          options.listDeploymentsWithActiveWorkflowRuns ?? listDeploymentsWithActiveWorkflowRuns
        )(resolveWorkflowWorldPlatformUrl(process.env), job.projectId),
      },
    );
    const policy = retention.find((entry) => entry.deployment.id === deployment.id);
    if (!policy || policy.protected) {
      throw new Error(
        `Deployment is protected from archive${policy?.reasons.length ? `: ${policy.reasons.join(", ")}` : "."}`,
      );
    }
    const adapter =
      options.runtime?.name === deployment.runtimeKind
        ? options.runtime
        : (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
    if (priorStatus === "running" || priorStatus === "draining")
      await adapter.stopProcess(deployment.containerName);
    const release = await store.getRelease(deployment.releaseId);
    if (release && adapter.removeRelease) await adapter.removeRelease(release.imageTag);
    await rm(
      path.join(
        options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data",
        "builds",
        job.projectId,
        deployment.releaseId,
      ),
      { recursive: true, force: true },
    );
    const archived = await store.transitionDeploymentStatus({
      deploymentId,
      to: "archived",
      from: ["archiving"],
    });
    if (!archived) throw new Error("Deployment lost the archiving claim before completion.");
  } catch (error) {
    // Best effort: hand the claim back so the deployment is not stranded in
    // "archiving"; a retried attempt can still re-claim that state.
    await store
      .transitionDeploymentStatus({
        deploymentId,
        to: priorStatus,
        from: ["archiving"],
      })
      .catch(() => undefined);
    throw error;
  }

  await store.appendLog({
    projectId: job.projectId,
    deploymentId,
    type: "deploy",
    line: automatic
      ? `Deployment ${deployment.deploymentKey} automatically archived by retention policy.`
      : `Deployment ${deployment.deploymentKey} archived.`,
  });
}
