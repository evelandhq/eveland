import {
  createScheduleDispatchCredential,
  resolveSchedulerDispatchSecret,
  resolveSchedulerRuntimeSecret,
} from "@evelandhq/core/server/scheduler-dispatch";
import type { Store } from "@evelandhq/db";

import { ensureDeploymentActive, type ActivationStore } from "../../runtime/activation-manager.js";
import { createRuntimeAdapterForKind } from "../../runtime/select.js";
import {
  createDeploymentStartInput,
  ensureDeploymentLaunchSandbox,
  materializeDeploymentLaunchContext,
  resolveDeploymentLaunchPrerequisites,
  resolveRecoverableRuntimeSource,
  type LaunchInputStore,
} from "../deployment-launch-context.js";
import { dispatchScheduleToRuntime, errorMessage } from "../process-support.js";
import type { ProcessJobOptions } from "../process-types.js";
import type { RuntimeJob } from "./types.js";

// The narrow persistence port this handler and its launch helpers need.
type TriggerScheduleStore = Pick<
  Store,
  | "appendLog"
  | "claimScheduleRunActivation"
  | "completeScheduleRun"
  | "getDeployment"
  | "getProjectSchedule"
  | "getRelease"
  | "getScheduleRun"
  | "getSourceRevision"
  | "listProjectScheduleVersions"
  | "listSourceRevisionFiles"
  | "releaseActivationLease"
  | "renewActivationLease"
  | "updateDeploymentStatus"
> &
  ActivationStore &
  LaunchInputStore;

export async function handleTriggerScheduleJob(
  store: TriggerScheduleStore,
  job: RuntimeJob<"trigger_schedule">,
  options: ProcessJobOptions,
): Promise<void> {
  const { scheduleRunId } = job.payload;
  let run = await store.getScheduleRun(scheduleRunId);
  let activationLeaseId: string | null = null;
  let activationLeaseHandedOff = false;
  const startedAtMs = Date.now();
  let failurePhase = "ScheduleRun validation";
  try {
    if (!run) throw new Error("Schedule trigger is missing a valid ScheduleRun.");
    const schedule = await store.getProjectSchedule(run.scheduleId);
    const deployment = await store.getDeployment(run.deploymentId);
    const release = await store.getRelease(run.releaseId);
    if (!schedule || schedule.projectId !== job.projectId)
      throw new Error("ScheduleRun does not belong to this project.");
    if (!schedule.enabled) throw new Error("Schedule is disabled.");
    if (
      !deployment ||
      deployment.projectId !== job.projectId ||
      deployment.releaseId !== run.releaseId
    ) {
      throw new Error("ScheduleRun Deployment provenance is invalid.");
    }
    if (!release || release.id !== deployment.releaseId)
      throw new Error("ScheduleRun Release provenance is invalid.");
    const versions = await store.listProjectScheduleVersions(
      job.projectId,
      release.sourceRevisionId,
    );
    if (
      !versions.some(
        (entry) => entry.version.id === run!.scheduleVersionId && entry.schedule.id === schedule.id,
      )
    ) {
      throw new Error("ScheduleRun version does not belong to its pinned Release.");
    }
    const claimedRun = await store.claimScheduleRunActivation(run.id);
    if (!claimedRun) {
      const current = await store.getScheduleRun(run.id);
      if (current && current.status !== "queued") {
        await store.appendLog({
          projectId: job.projectId,
          deploymentId: current.deploymentId,
          type: "runtime",
          line: `Duplicate ScheduleRun job ignored for ${current.id} in ${current.status}.`,
        });
        return;
      }
      throw new Error("ScheduleRun is not eligible for activation.");
    }
    run = claimedRun;
    const dispatchSecret =
      options.schedulerDispatchSecret ?? resolveSchedulerDispatchSecret(process.env);
    const runtimeSecret =
      options.schedulerRuntimeSecret ?? resolveSchedulerRuntimeSecret(process.env);
    if (!dispatchSecret || !runtimeSecret)
      throw new Error("Scheduler dispatch credentials are not configured.");
    const revision = await store.getSourceRevision(release.sourceRevisionId);
    if (!revision) throw new Error("ScheduleRun Release has no SourceRevision.");
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
      options,
    });
    await ensureDeploymentLaunchSandbox(launchPrerequisites);
    const maxRuntimeMs = scheduleRunMaxRuntimeMs(options);
    failurePhase = "Deployment activation";
    await store.appendLog({
      projectId: job.projectId,
      deploymentId: deployment.id,
      type: "runtime",
      line: `ScheduleRun ${run.id} activating ${schedule.key} on Deployment ${deployment.id} (Release ${release.id}, runtime=${deployment.runtimeKind}).`,
    });
    const launchContext = await materializeDeploymentLaunchContext({
      store,
      releaseId: release.id,
      prerequisites: launchPrerequisites,
      staleRelease: release,
    });
    const activation = await ensureDeploymentActive(
      store,
      {
        deployment,
        runtime,
        kind: "schedule_run",
        ownerId: run.id,
        startInput: createDeploymentStartInput({
          processName: deployment.containerName,
          releaseRef: release.imageTag,
          port: deployment.hostPort,
          launchContext,
        }),
      },
      {
        waitForHealth: options.waitForDeployment,
        readyTimeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
        leaseTtlMs: maxRuntimeMs,
      },
    );
    activationLeaseId = activation.lease.id;
    await store.updateDeploymentStatus(deployment.id, "running");
    failurePhase = "Scheduler Channel dispatch";
    await store.appendLog({
      projectId: job.projectId,
      deploymentId: deployment.id,
      type: "runtime",
      line: `ScheduleRun ${run.id} dispatching ${schedule.key} to the Scheduler Channel on Deployment ${deployment.id}.`,
    });
    const credential = createScheduleDispatchCredential(
      {
        scheduleRunId: run.id,
        deploymentId: deployment.id,
        scheduleKey: schedule.key,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
      dispatchSecret,
    );
    const result = await (options.dispatchSchedule ?? dispatchScheduleToRuntime)({
      scheduleRunId: run.id,
      scheduleKey: schedule.key,
      deploymentId: deployment.id,
      hostPort: deployment.hostPort,
      credential,
      runtimeSecret,
    });
    let reported = await store.getScheduleRun(run.id);
    if (reported?.status === "dispatching") {
      reported = await store.completeScheduleRun(run.id, {
        status: "succeeded",
        eveSessionIds: result.sessionIds,
      });
    } else if (!reported || !["running", "succeeded", "failed"].includes(reported.status)) {
      throw new Error("Scheduler Channel returned without a durable dispatch result.");
    }
    if (reported?.status === "running") {
      const renewed = await store.renewActivationLease(
        activationLeaseId,
        new Date(Date.now() + maxRuntimeMs),
      );
      if (!renewed) throw new Error("ScheduleRun activation lease could not be extended.");
      activationLeaseHandedOff = true;
    }
    await store.appendLog({
      projectId: job.projectId,
      deploymentId: deployment.id,
      type: "runtime",
      line: `ScheduleRun ${run.id} ${activationLeaseHandedOff ? "started" : "succeeded for"} ${schedule.key} with ${result.sessionIds.length} ${result.sessionIds.length === 1 ? "Session" : "Sessions"} after ${Date.now() - startedAtMs}ms.`,
    });
  } catch (error) {
    const rawMessage = errorMessage(error);
    const message = `${failurePhase} failed: ${rawMessage}`;
    let durableExecutionContinues = false;
    if (run) {
      const current = await store.getScheduleRun(run.id);
      if (current?.status === "running" && activationLeaseId) {
        const renewed = await store.renewActivationLease(
          activationLeaseId,
          new Date(Date.now() + scheduleRunMaxRuntimeMs(options)),
        );
        if (renewed) {
          activationLeaseHandedOff = true;
          durableExecutionContinues = true;
        }
      } else if (
        current &&
        !["succeeded", "failed", "dispatch_unknown", "skipped"].includes(current.status)
      ) {
        await store.completeScheduleRun(run.id, {
          status: current.status === "dispatching" ? "dispatch_unknown" : "failed",
          error: message,
        });
      }
    }
    await store.appendLog({
      projectId: job.projectId,
      deploymentId: run?.deploymentId ?? null,
      type: "runtime",
      line: durableExecutionContinues
        ? `ScheduleRun ${scheduleRunId ?? "unknown"} continued after its durable Session result was recorded but the Scheduler Channel response failed after ${Date.now() - startedAtMs}ms: ${rawMessage}`
        : `ScheduleRun ${scheduleRunId ?? "unknown"} failed during ${failurePhase} after ${Date.now() - startedAtMs}ms: ${rawMessage}`,
    });
  } finally {
    if (activationLeaseId && !activationLeaseHandedOff)
      await store.releaseActivationLease(activationLeaseId);
  }
}

function scheduleRunMaxRuntimeMs(options: ProcessJobOptions): number {
  const value =
    options.scheduleRunMaxRuntimeMs ??
    Number(process.env.EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS ?? 86_400_000);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS must be a positive integer.");
  }
  return value;
}
