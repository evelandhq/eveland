import type { JobType } from "@evelandhq/core/contracts";

/**
 * The worker's cutover process mode. During the maintenance downtime the
 * cutover Worker consumes only the exact activation/reconciliation the
 * operation needs — no schedule planner, no build/import, no stale-job
 * recovery, no retention or observability loops. Startup fails closed without
 * the operation id: this process must know which operation it serves.
 */
export type WorkerProcessMode =
  | { mode: "normal" }
  | { mode: "workflow-cutover"; operationId: string };

// Only exact activation: it is the only job type a cutover operation stamps
// (enqueueDeploymentActivation), so nothing else can ever pass the claim's
// operation-id filter anyway.
export const CUTOVER_ALLOWED_JOB_TYPES: readonly JobType[] = ["ensure_deployment_running"];

export function resolveWorkerProcessMode(env: NodeJS.ProcessEnv): WorkerProcessMode {
  if (env.EVELAND_PROCESS_MODE === "workflow-cutover") {
    const operationId = env.EVELAND_WORKFLOW_CUTOVER_OPERATION_ID;
    if (!operationId) {
      throw new Error(
        "EVELAND_PROCESS_MODE=workflow-cutover requires EVELAND_WORKFLOW_CUTOVER_OPERATION_ID; a cutover Worker must know which operation it serves.",
      );
    }
    return { mode: "workflow-cutover", operationId };
  }
  if (env.EVELAND_PROCESS_MODE !== undefined && env.EVELAND_PROCESS_MODE !== "normal") {
    throw new Error(
      `Invalid EVELAND_PROCESS_MODE "${env.EVELAND_PROCESS_MODE}": expected "normal" or "workflow-cutover".`,
    );
  }
  return { mode: "normal" };
}
