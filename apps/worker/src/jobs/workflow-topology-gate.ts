import type { ReleaseRecord } from "@evelandhq/core/contracts";

/**
 * Stable, machine-matchable prefix for a managed workflow-topology refusal.
 * Gateway/API map it onto a user-facing error code; tests pin the prefix so a
 * launch refusal is never a bare 500.
 */
export const WORKFLOW_UNAVAILABLE = "workflow_unavailable";

export type WorkflowLaunchDecision =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

/**
 * Every launch path — deploy start, restart, cold activation, schedule and
 * workflow-step activation — decides from the Release's immutable attestation,
 * never from the worker's current environment. A Release the build did not
 * attest as a shared-World build fails closed with a managed reason instead of
 * guessing.
 */
export function assessWorkflowLaunch(
  release: Pick<ReleaseRecord, "id" | "workflow">,
): WorkflowLaunchDecision {
  if (release.workflow.worldKind === "shared") return { allowed: true };
  return {
    allowed: false,
    code: WORKFLOW_UNAVAILABLE,
    reason: `${WORKFLOW_UNAVAILABLE}: Release ${release.id} has no shared-World attestation; rebuild it.`,
  };
}
