import type { DeploymentStatus } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";

/**
 * Runtime jobs own only process-lifecycle statuses. Draining and archived are
 * control-plane decisions that a concurrent restart or activation must retain.
 */
const RUNTIME_JOB_OWNED_DEPLOYMENT_STATUSES: DeploymentStatus[] = [
  "running",
  "stopped",
  "failed",
];

export async function settleDeploymentStatus(
  store: Pick<Store, "transitionDeploymentStatus">,
  deploymentId: string,
  status: Extract<DeploymentStatus, "running" | "stopped">,
): Promise<void> {
  await store.transitionDeploymentStatus({
    deploymentId,
    to: status,
    from: RUNTIME_JOB_OWNED_DEPLOYMENT_STATUSES,
  });
}
