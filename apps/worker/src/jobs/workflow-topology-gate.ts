import type { ReleaseRecord } from "@evelandhq/core/contracts";

/**
 * Stable, machine-matchable prefixes for managed workflow-topology refusals.
 * Gateway/API map these onto user-facing error codes; tests pin the prefix so
 * a launch refusal is never a bare 500.
 */
export const WORKFLOW_MIGRATION_REQUIRED = "workflow_migration_required";
export const WORKFLOW_UNAVAILABLE = "workflow_unavailable";

export type WorkflowLaunchDecision =
  | { allowed: true; workflowWorldKind: "shared" }
  | { allowed: false; code: string; reason: string };

/**
 * Every launch path — deploy start, restart, cold activation, schedule and
 * workflow-step activation — decides from the Release's immutable attestation,
 * never from the worker's current environment. Anything not provably a shared
 * build fails closed with a managed reason instead of guessing.
 */
export function assessWorkflowLaunch(
  release: Pick<ReleaseRecord, "id" | "workflow">,
): WorkflowLaunchDecision {
  const { worldKind } = release.workflow;
  if (worldKind === "shared") {
    return { allowed: true, workflowWorldKind: "shared" };
  }
  if (worldKind === "legacy_project") {
    return {
      allowed: false,
      code: WORKFLOW_UNAVAILABLE,
      reason: `${WORKFLOW_UNAVAILABLE}: Release ${release.id} was built against the legacy per-project workflow world; it can never be launched again.`,
    };
  }
  return {
    allowed: false,
    code: WORKFLOW_MIGRATION_REQUIRED,
    reason: `${WORKFLOW_MIGRATION_REQUIRED}: Release ${release.id} has no workflow attestation; only a shared-World build may start.`,
  };
}
