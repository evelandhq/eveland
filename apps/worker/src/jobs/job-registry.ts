import type { Job, JobType } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";
import { handleBuildDeployJob } from "./process-build-deploy.js";
import { handleImportSourceJob } from "./process-import-source.js";
import { handleArchiveDeploymentJob } from "./runtime-jobs/archive-deployment.js";
import { handleDeleteProjectJob } from "./runtime-jobs/delete-project.js";
import { handleEnsureDeploymentRunningJob } from "./runtime-jobs/ensure-deployment-running.js";
import { handleRestartDeploymentJob } from "./runtime-jobs/restart-deployment.js";
import { handleTriggerScheduleJob } from "./runtime-jobs/trigger-schedule.js";
import type { ProcessJobOptions } from "./process-types.js";

export type JobDescriptor<Type extends JobType = JobType> = {
  handle: (
    store: Store,
    job: Job<Type>,
    options: ProcessJobOptions,
  ) => Promise<void>;
  /**
   * Settles project/runtime state after the job row itself is marked failed.
   * Claiming, heartbeat, and attempt fencing stay in process.ts; this hook
   * owns only what the failed job family means for the project.
   */
  onFailure?: (store: Store, job: Job<Type>, message: string) => Promise<void>;
};

export const jobRegistry: { [Type in JobType]: JobDescriptor<Type> } = {
  import_source: {
    handle: handleImportSourceJob,
    // A failed import never touches the running container, so it must not
    // report a live deployment as failed; only deploy/restart jobs change
    // deployment status.
    onFailure: async (store, job) => {
      await store.updateProjectState(job.projectId, { status: "failed" });
    },
  },
  build_deploy: {
    handle: handleBuildDeployJob,
    onFailure: async (store, job) => {
      const production = await store.getCurrentDeployment(job.projectId);
      await store.updateProjectState(
        job.projectId,
        production &&
          (production.status === "running" ||
            production.status === "draining")
          ? {
              status: "failed",
              deploymentStatus: production.status,
            }
          : { status: "failed", deploymentStatus: "failed" },
      );
    },
  },
  restart_deployment: {
    handle: handleRestartDeploymentJob,
    onFailure: async (store, job) => {
      await store.updateProjectState(job.projectId, {
        status: "failed",
        deploymentStatus: "failed",
      });
    },
  },
  trigger_schedule: {
    handle: handleTriggerScheduleJob,
    onFailure: async (store, job) => {
      await store.updateProjectState(job.projectId, { status: "failed" });
    },
  },
  ensure_deployment_running: {
    handle: handleEnsureDeploymentRunningJob,
    onFailure: async (store, job, message) => {
      await store.updateRuntimeInstance(job.payload.runtimeInstanceId, {
        status: "failed",
        error: message,
      });
      const production = await store.getCurrentDeployment(job.projectId);
      if (production?.id === job.payload.deploymentId) {
        await store.updateProjectState(job.projectId, {
          status: "failed",
        });
      }
    },
  },
  // Archive failures leave project state alone: the deployment reverts to
  // its pre-claim status and nothing user-facing changed.
  archive_deployment: {
    handle: handleArchiveDeploymentJob,
  },
  delete_project: {
    handle: handleDeleteProjectJob,
    onFailure: async (store, job, message) => {
      await store.setProjectDeletionFailed(job.projectId, message);
    },
  },
};

export async function dispatchJob(
  store: Store,
  job: Job,
  options: ProcessJobOptions,
): Promise<void> {
  const descriptor = jobRegistry[job.type] as JobDescriptor;
  await descriptor.handle(store, job, options);
}

export async function settleJobFailure(
  store: Store,
  job: Job,
  message: string,
): Promise<void> {
  const descriptor = jobRegistry[job.type] as JobDescriptor;
  await descriptor.onFailure?.(store, job, message);
}
