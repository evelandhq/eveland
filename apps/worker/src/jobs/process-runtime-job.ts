import type { Job } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";

import { handleArchiveDeploymentJob } from "./runtime-jobs/archive-deployment.js";
import { handleDeleteProjectJob } from "./runtime-jobs/delete-project.js";
import { handleEnsureDeploymentRunningJob } from "./runtime-jobs/ensure-deployment-running.js";
import { handleRestartDeploymentJob } from "./runtime-jobs/restart-deployment.js";
import { handleTriggerScheduleJob } from "./runtime-jobs/trigger-schedule.js";
import type {
  RuntimeJob,
  RuntimeJobHandler,
  RuntimeJobHandlerRegistry,
} from "./runtime-jobs/types.js";
import type { ProcessJobOptions } from "./process-types.js";

export { createDeploymentStartInput } from "./runtime-jobs/deployment-start-input.js";

export const runtimeJobHandlers = {
  restart_deployment: handleRestartDeploymentJob,
  archive_deployment: handleArchiveDeploymentJob,
  delete_project: handleDeleteProjectJob,
  ensure_deployment_running: handleEnsureDeploymentRunningJob,
  trigger_schedule: handleTriggerScheduleJob,
} satisfies RuntimeJobHandlerRegistry;

export async function processRuntimeJob(
  store: Store,
  job: Job,
  options: ProcessJobOptions,
): Promise<void> {
  const handler = (
    runtimeJobHandlers as Partial<Record<Job["type"], RuntimeJobHandler>>
  )[job.type];
  if (!handler) {
    throw new Error(`Unsupported runtime job type: ${job.type}`);
  }
  await handler(store, job as RuntimeJob, options);
}
