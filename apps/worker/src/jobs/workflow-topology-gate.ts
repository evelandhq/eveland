import type { DeploymentRecord, ReleaseRecord } from "@evelandhq/core/contracts";

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
 * workflow-step activation — decides from the Release's immutable attestation
 * and the Deployment's persisted execution topology, never from the worker's
 * current environment. Anything not provably a converted shared/external
 * Deployment fails closed with a managed reason instead of guessing.
 */
export function assessWorkflowLaunch(
  release: Pick<ReleaseRecord, "id" | "workflow">,
  deployment: Pick<DeploymentRecord, "id" | "workflowTopology">,
): WorkflowLaunchDecision {
  const { worldKind } = release.workflow;
  const { conversionState } = deployment.workflowTopology;
  if (worldKind === "shared" && conversionState === "external") {
    return { allowed: true, workflowWorldKind: "shared" };
  }
  if (worldKind === "legacy_project") {
    return {
      allowed: false,
      code: WORKFLOW_UNAVAILABLE,
      reason: `${WORKFLOW_UNAVAILABLE}: Release ${release.id} was built against the legacy per-project workflow world; it can only be managed-terminated, never launched again.`,
    };
  }
  if (worldKind === "unknown") {
    return {
      allowed: false,
      code: WORKFLOW_MIGRATION_REQUIRED,
      reason: `${WORKFLOW_MIGRATION_REQUIRED}: Release ${release.id} has no workflow attestation. The external-only cutover must classify this artifact before deployment ${deployment.id} may start.`,
    };
  }
  return {
    allowed: false,
    code: WORKFLOW_MIGRATION_REQUIRED,
    reason: `${WORKFLOW_MIGRATION_REQUIRED}: Deployment ${deployment.id} is ${conversionState}; it must finish converting to the external topology before it may start.`,
  };
}

/**
 * Archive destroys the runtime artifact — the only thing able to resume a
 * parked run. A shared attestation alone is not enough: a historically
 * classified Release can still own an `unclassified`/`fenced`/`converting`/
 * `blocked` Deployment whose runs have not passed the recovery gate. Only a
 * Deployment that finished converting (`external`) or completed its
 * managed-termination saga (`terminated`) may lose its artifact.
 */
export function assessWorkflowArchive(
  release: Pick<ReleaseRecord, "id" | "workflow">,
  deployment: Pick<DeploymentRecord, "id" | "workflowTopology">,
): { allowed: true } | { allowed: false; reason: string } {
  const { conversionState } = deployment.workflowTopology;
  if (conversionState === "terminated" || conversionState === "external") {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Deployment ${deployment.id} keeps its artifact: Release ${release.id} workflow topology is ${release.workflow.worldKind}/${conversionState} and must finish converting or be managed-terminated by the cutover before archive.`,
  };
}
