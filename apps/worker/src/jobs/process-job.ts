import type { Job } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";
import { dispatchJob } from "./job-registry.js";
import type { ProcessJobOptions } from "./process-types.js";

// Typed dispatch only: the import state machine lives in
// process-import-source.ts, build/deploy in process-build-deploy.ts, and the
// runtime job families under runtime-jobs/. Failure policies live with the
// handlers in job-registry.ts.
export async function processJob(
  store: Store,
  job: Job,
  options: ProcessJobOptions,
): Promise<void> {
  await dispatchJob(store, job, options);
}
