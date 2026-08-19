import type { Store } from "@evelandhq/db";
import type { SessionBindingIdlePolicy } from "@evelandhq/core/routing";
import { listDeploymentsWithActiveWorkflowRuns } from "./eveland-workflow-world-runs.js";
import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";

export async function sweepReleaseRetention(
  store: Store,
  input: SessionBindingIdlePolicy & {
    keepRecent?: number;
    limit?: number;
    now?: Date;
    /** Injected so the sweep sees the same workflow-run protection archive does. */
    listDeploymentsWithActiveWorkflowRuns?: (
      worldUrl: string | undefined,
      projectId: string,
    ) => Promise<Set<string>>;
    evelandWorkflowWorldUrl?: string;
  } = {},
): Promise<number> {
  const configuredKeepRecent = input.keepRecent ?? 3;
  const keepRecent = Number.isFinite(configuredKeepRecent)
    ? Math.max(3, Math.floor(configuredKeepRecent))
    : 3;
  const configuredLimit = input.limit ?? 25;
  const limit = Number.isFinite(configuredLimit) ? Math.max(1, Math.floor(configuredLimit)) : 25;
  let enqueued = 0;

  for (const project of await store.listProjects()) {
    if (project.deletionStatus === "deleting") continue;
    // Without this the sweep cannot see `active_workflow_run`, so it would
    // keep enqueueing archive jobs for a deployment holding a sleeping run —
    // the archive job re-checks and refuses, leaving the deployment flapping
    // between `stopped` and `archiving` on every tick.
    const deploymentsWithActiveWorkflowRuns = await (
      input.listDeploymentsWithActiveWorkflowRuns ?? listDeploymentsWithActiveWorkflowRuns
    )(input.evelandWorkflowWorldUrl ?? resolveWorkflowWorldPlatformUrl(process.env), project.id);
    const retention = await store.getDeploymentRetention(project.id, keepRecent, {
      ...input,
      deploymentsWithActiveWorkflowRuns,
    });
    for (const entry of retention) {
      if (enqueued >= limit || entry.protected || entry.deployment.status !== "stopped") {
        continue;
      }
      const result = await store.enqueueDeploymentArchive(project.id, entry.deployment.id, {
        automatic: true,
      });
      if (result.created) enqueued += 1;
    }
    if (enqueued >= limit) break;
  }

  return enqueued;
}
