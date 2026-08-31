import { unsupportedReleaseEveVersionMessage } from "@evelandhq/core/eve-compatibility";
import type { Store } from "@evelandhq/db";

import { startRuntimeInstance, type ActivationStore } from "../../runtime/activation-manager.js";
import { createRuntimeAdapterForKind } from "../../runtime/select.js";
import {
  createDeploymentStartInput,
  type LaunchInputStore,
  ensureDeploymentLaunchSandbox,
  materializeDeploymentLaunchContext,
  resolveDeploymentLaunchPrerequisites,
  resolveRecoverableRuntimeSource,
} from "../deployment-launch-context.js";
import type { ProcessJobOptions } from "../process-types.js";
import { assessWorkflowLaunch } from "../workflow-topology-gate.js";
import { settleDeploymentStatus } from "./deployment-status.js";
import type { RuntimeJob } from "./types.js";

// The narrow persistence port this handler and its launch helpers need.
type EnsureDeploymentRunningStore = Pick<
  Store,
  | "appendLog"
  | "getDeployment"
  | "getRelease"
  | "getRuntimeInstance"
  | "getSourceRevision"
  | "listSourceRevisionFiles"
  | "updateRuntimeInstance"
> &
  ActivationStore &
  LaunchInputStore;

export async function handleEnsureDeploymentRunningJob(
  store: EnsureDeploymentRunningStore,
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
  // A queued activation that lost the race to an archive must not resurrect
  // the deployment.
  if (deployment.status === "archiving" || deployment.status === "archived") {
    await store.updateRuntimeInstance(runtimeInstanceId, {
      status: "failed",
      error: `Deployment is ${deployment.status} and cannot be activated.`,
    });
    return;
  }
  const release = await store.getRelease(deployment.releaseId);
  if (!release) throw new Error("Deployment activation Release is missing.");
  // The activation route refuses this Release at request time, but activations
  // enqueued by starting-instance recovery never pass through the route. The
  // gate is deterministic -- the unsupported Eve version is baked into the
  // image -- so fail the instance before materializing the launch context
  // instead of burning a full doomed start (issue #425).
  const eveVersionRefusal = unsupportedReleaseEveVersionMessage(release.summary);
  if (eveVersionRefusal !== null) {
    await store.updateRuntimeInstance(runtimeInstanceId, {
      status: "failed",
      error: eveVersionRefusal,
    });
    await store.appendLog({
      projectId: job.projectId,
      deploymentId: deployment.id,
      type: "runtime",
      line: `Activation blocked: ${eveVersionRefusal}`,
    });
    return;
  }
  // Cold activation decides from the persisted attestation, never the worker's
  // current environment. The instance fails with the managed reason instead of
  // waiting out an activation timeout.
  const launchDecision = assessWorkflowLaunch(release);
  if (!launchDecision.allowed) {
    await store.updateRuntimeInstance(runtimeInstanceId, {
      status: "failed",
      error: launchDecision.reason,
    });
    await store.appendLog({
      projectId: job.projectId,
      deploymentId: deployment.id,
      type: "runtime",
      line: `Activation blocked: ${launchDecision.reason}`,
    });
    return;
  }
  const revision = await store.getSourceRevision(release.sourceRevisionId);
  if (!revision) throw new Error("Deployment activation SourceRevision is missing.");
  const recoverableSource = await resolveRecoverableRuntimeSource(store, revision);
  const runtime =
    options.runtime ??
    (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
  const launchPrerequisites = await resolveDeploymentLaunchPrerequisites({
    store,
    workerEnv: process.env,
    projectId: job.projectId,
    deploymentId: deployment.id,
    runtimeKind: runtime.name,
    sourcePath: revision.sourcePath,
    ...recoverableSource,
    options: { ...options, workflowWorldKind: launchDecision.workflowWorldKind },
  });
  await ensureDeploymentLaunchSandbox(launchPrerequisites);
  const launchContext = await materializeDeploymentLaunchContext({
    store,
    releaseId: release.id,
    prerequisites: launchPrerequisites,
    staleRelease: release,
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
        launchContext,
      }),
    },
    runtimeInstance.id,
    {
      waitForHealth: options.waitForDeployment,
      readyTimeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
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
