import type { Store } from "@evelandhq/db";
import { permanentDeploymentActivationRefusal } from "@evelandhq/core/eve-compatibility";
import type { SessionBindingIdlePolicy } from "@evelandhq/core/routing";
import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";
import { reconcileWorkflowRuns } from "@evelandhq/workflow-world";
import { Pool } from "pg";
import {
  listDeploymentsWithActiveWorkflowRunsAcrossProjects,
  type ActiveWorkflowRunDeployment,
} from "./eveland-workflow-world-runs.js";

/**
 * Settles workflow runs that no delivery can ever resume, in two shapes.
 *
 * 1. Runs bound to Deployments that can never activate again (issue #433, the
 *    run-leak half of #425): missing, archived, or pinned to an Eve version
 *    outside the supported window. Settled as `fail`.
 *
 * 2. Runs bound to a superseded Deployment that nothing reaches any more. A
 *    parked session run is durable state only while something can still
 *    deliver to it: the SessionBinding routes the user's next message back for
 *    its idle TTL, a route target or activation lease keeps requests arriving.
 *    Once every one of those has lapsed the gateway already answers that
 *    session with 410 `session_expired`, so its runs are unreachable in the
 *    same sense as those in shape 1 — Eve would only notice at its own 30-day
 *    session deadline, cold-starting the old Deployment to say so. Settled as
 *    `cancel`, and only for Eve's own session workflows: a project-authored
 *    durable workflow sleeping on that Deployment is a reason to leave it
 *    alone, not to settle it.
 *
 * The scope is deliberately Deployment-shaped, not RuntimeInstance-shaped. A
 * run that is `running` while its agent process is reaped is usually the
 * intended durable state, and the judgement above is exactly the archive
 * policy's (`getDeploymentRetention`) with the runs themselves left out of it:
 * a Deployment the policy would keep for any other reason keeps its runs.
 */

export type WorkflowRunReconcilerStore = Pick<
  Store,
  "getDeployment" | "getRelease" | "getDeploymentRetention"
>;

export type ReconcileAbandonedWorkflowRunsOptions = SessionBindingIdlePolicy & {
  /** Defaults to the platform world URL from the environment; no-op when unset. */
  evelandWorkflowWorldUrl?: string;
  /** Newest Deployments per project whose runs are always kept; mirrors the archive policy. */
  keepRecent?: number;
  now?: Date;
  listActiveDeployments?: (worldUrl: string) => Promise<ActiveWorkflowRunDeployment[]>;
  reconcile?: typeof reconcileWorkflowRuns;
};

export type ReconcileAbandonedWorkflowRunsResult = {
  examinedDeployments: number;
  settledRuns: number;
  /** Deployments whose judgment or settle failed this sweep; retried next sweep. */
  failures: number;
};

/** Eve's own workflows (`workflow//eve//<name>`), as opposed to project-authored ones. */
export function isEveOwnedWorkflow(workflowName: string): boolean {
  return workflowName.startsWith("workflow//eve//");
}

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
  const keepRecent = Math.max(3, Math.floor(options.keepRecent ?? 3));
  const idlePolicy: SessionBindingIdlePolicy = {
    ...(options.playgroundIdleTtlMs !== undefined && {
      playgroundIdleTtlMs: options.playgroundIdleTtlMs,
    }),
    ...(options.apiIdleTtlMs !== undefined && { apiIdleTtlMs: options.apiIdleTtlMs }),
  };
  const now = options.now ?? new Date();
  // Lazy: most sweeps find every Deployment healthy and never open this pool.
  let pool: Pool | null = null;
  let settledRuns = 0;
  let failures = 0;
  // One retention read per project per sweep: the policy judges every
  // Deployment of the project at once, and several candidates share one.
  const retentionByProject = new Map<
    string,
    Promise<Awaited<ReturnType<WorkflowRunReconcilerStore["getDeploymentRetention"]>>>
  >();
  const retentionFor = (projectId: string) => {
    let pending = retentionByProject.get(projectId);
    if (!pending) {
      pending = store.getDeploymentRetention(projectId, keepRecent, {
        ...idlePolicy,
        now,
        // The question is what would keep this Deployment if its runs did not.
        deploymentsWithActiveWorkflowRuns: new Set<string>(),
      });
      retentionByProject.set(projectId, pending);
    }
    return pending;
  };
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
        if (refusal !== null) {
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
          continue;
        }
        if (!deployment || deployment.status !== "stopped") continue;
        // Shape 2 applies to Eve's session family only. Any project-authored
        // workflow still sleeping here is a reason to keep the whole
        // Deployment: settling it would cut a durable workflow short, and
        // settling around it would not free anything.
        if (
          candidate.workflowNames.length === 0 ||
          !candidate.workflowNames.every(isEveOwnedWorkflow)
        ) {
          continue;
        }
        const retention = await retentionFor(candidate.projectId);
        const verdict = retention.find((entry) => entry.deployment.id === candidate.deploymentId);
        if (!verdict || verdict.protected) continue;
        pool ??= new Pool({ connectionString: worldUrl, max: 1 });
        const reason =
          "Reconciled by the platform: the Deployment is superseded and no route, session " +
          "binding, operation or request lease still reaches it, so its session runs can never " +
          "be resumed.";
        const result = await reconcile(pool, {
          tenantId: candidate.projectId,
          deploymentIds: [candidate.deploymentId],
          disposition: "cancel",
          reason,
        });
        settledRuns += result.reconciled.length;
        if (result.reconciled.length > 0) {
          console.log(
            `Settled ${String(result.reconciled.length)} unreachable session run(s) on superseded ${candidate.deploymentId} (${candidate.projectId}); the archive policy no longer keeps it.`,
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
