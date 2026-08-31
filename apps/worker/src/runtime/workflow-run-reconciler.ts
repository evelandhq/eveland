import type { Store } from "@evelandhq/db";
import { permanentDeploymentActivationRefusal } from "@evelandhq/core/eve-compatibility";
import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";
import { reconcileWorkflowRuns } from "@evelandhq/workflow-world";
import { Pool } from "pg";
import {
  listDeploymentsWithActiveWorkflowRunsAcrossProjects,
  type ActiveWorkflowRunDeployment,
} from "./eveland-workflow-world-runs.js";

/**
 * Settles workflow runs bound to Deployments that can never activate again
 * (issue #433, the run-leak half of #425).
 *
 * The scope is deliberately Deployment-shaped, not RuntimeInstance-shaped. A
 * run that is `running` while its agent process is reaped is usually the
 * intended durable state: a timer sleeps as `running` with a wait row and the
 * dispatcher wakes the Deployment when it fires, and a session's inbox hook
 * outlives the process because the SessionBinding routes the user's next
 * message back for up to its idle TTL. Settling those would break wake and
 * conversation resumption. What actually leaks forever is a run whose
 * Deployment is gone, archived, or pinned to an Eve version outside the
 * supported window — no delivery to it can ever succeed, so every one of its
 * runs is settled here with the World's own terminal semantics.
 */

export type WorkflowRunReconcilerStore = Pick<Store, "getDeployment" | "getRelease">;

export type ReconcileAbandonedWorkflowRunsOptions = {
  /** Defaults to the platform world URL from the environment; no-op when unset. */
  evelandWorkflowWorldUrl?: string;
  listActiveDeployments?: (worldUrl: string) => Promise<ActiveWorkflowRunDeployment[]>;
  reconcile?: typeof reconcileWorkflowRuns;
};

export type ReconcileAbandonedWorkflowRunsResult = {
  examinedDeployments: number;
  settledRuns: number;
  /** Deployments whose judgment or settle failed this sweep; retried next sweep. */
  failures: number;
};

export async function reconcileAbandonedWorkflowRuns(
  store: WorkflowRunReconcilerStore,
  options: ReconcileAbandonedWorkflowRunsOptions = {},
): Promise<ReconcileAbandonedWorkflowRunsResult> {
  const worldUrl = options.evelandWorkflowWorldUrl ?? resolveWorkflowWorldPlatformUrl(process.env);
  if (!worldUrl) return { examinedDeployments: 0, settledRuns: 0, failures: 0 };

  const listActiveDeployments =
    options.listActiveDeployments ?? listDeploymentsWithActiveWorkflowRunsAcrossProjects;
  const candidates = await listActiveDeployments(worldUrl);
  if (candidates.length === 0) return { examinedDeployments: 0, settledRuns: 0, failures: 0 };

  const reconcile = options.reconcile ?? reconcileWorkflowRuns;
  // Lazy: most sweeps find every Deployment healthy and never open this pool.
  let pool: Pool | null = null;
  let settledRuns = 0;
  let failures = 0;
  try {
    for (const candidate of candidates) {
      try {
        const deployment = await store.getDeployment(candidate.deploymentId);
        // A Deployment recorded under one project must never be judged — let
        // alone settled — through another project's runs. The world's rows are
        // tenant-scoped; trust but verify the join.
        if (deployment && deployment.projectId !== candidate.projectId) continue;
        const release = deployment ? await store.getRelease(deployment.releaseId) : null;
        const refusal = permanentDeploymentActivationRefusal(deployment, release?.summary ?? null);
        if (refusal === null) continue;
        pool ??= new Pool({ connectionString: worldUrl, max: 1 });
        const result = await reconcile(pool, {
          tenantId: candidate.projectId,
          deploymentIds: [candidate.deploymentId],
          disposition: "fail",
          errorCode: "DEPLOYMENT_UNSTARTABLE",
          reason: `Reconciled by the platform: ${refusal}`,
        });
        settledRuns += result.reconciled.length;
        if (result.reconciled.length > 0) {
          console.log(
            `Settled ${String(result.reconciled.length)} orphaned workflow run(s) on ${candidate.deploymentId} (${candidate.projectId}): ${refusal}`,
          );
        }
      } catch (error) {
        // Uncertainty is not a verdict: a store or world hiccup skips this
        // Deployment for the sweep, and the next sweep asks again.
        failures += 1;
        console.warn(
          `Workflow-run reconciliation skipped ${candidate.deploymentId} (${candidate.projectId}):`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    await pool?.end().catch(() => {});
  }
  return { examinedDeployments: candidates.length, settledRuns, failures };
}
