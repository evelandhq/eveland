import postgres from "postgres";

/**
 * Deployments of this project that still own a non-terminal run in the shared
 * `@evelandhq/workflow-world` database.
 *
 * Feeds the `active_workflow_run` retention reason. Non-terminal is `pending`
 * or `running`: upstream removed the `paused` status, and a run sleeping on a
 * timer is `running` with a wait row, so the two statuses cover it. The world's
 * schema keeps a partial index over exactly this predicate.
 *
 * Returns an empty set when the world is not configured, which keeps this safe
 * to call unconditionally during the run-out — a project still on
 * world-postgres simply contributes no protected deployments here. A configured
 * world that fails to answer is different: failing open would silently
 * unprotect deployments, so the error propagates and the caller's sweep skips
 * this tick instead of archiving blind.
 */
/** One (project, Deployment) pair that still owns a non-terminal workflow run. */
export type ActiveWorkflowRunDeployment = {
  projectId: string;
  deploymentId: string;
};

/**
 * Every (project, Deployment) pair with a non-terminal run, across all
 * tenants — the candidate list for the abandoned-run reconciler (issue #433).
 *
 * Unlike the retention read below, this deliberately does NOT exclude runs
 * quarantined behind an unresolved dead letter: a dead-lettered run bound to a
 * Deployment that can never activate again is exactly the wedged state the
 * reconciler exists to settle. Same fail-closed posture: unconfigured world
 * contributes nothing; a configured world that fails to answer throws.
 */
export async function listDeploymentsWithActiveWorkflowRunsAcrossProjects(
  worldUrl: string | undefined,
): Promise<ActiveWorkflowRunDeployment[]> {
  if (!worldUrl) return [];
  const sql = postgres(worldUrl, { max: 1 });
  try {
    const rows = await sql`
      select distinct runs.tenant_id, runs.deployment_id
        from "workflow"."workflow_runs" as runs
       where runs.status in ('pending', 'running')
    `;
    return rows.map((row) => ({
      projectId: row.tenant_id as string,
      deploymentId: row.deployment_id as string,
    }));
  } catch (error) {
    throw new Error(
      "Failed to list Deployments with active workflow runs from the platform workflow world.",
      { cause: error },
    );
  } finally {
    await sql.end();
  }
}

export async function listDeploymentsWithActiveWorkflowRuns(
  worldUrl: string | undefined,
  projectId: string,
): Promise<Set<string>> {
  if (!worldUrl) return new Set();
  const sql = postgres(worldUrl, { max: 1 });
  try {
    const rows = await sql`
      select distinct runs.deployment_id
        from "workflow"."workflow_runs" as runs
       where runs.tenant_id = ${projectId}
         and runs.status in ('pending', 'running')
         -- An unresolved dead letter is terminal dispatch quarantine. The
         -- workflow row remains active for explicit replay/cancel semantics,
         -- but must not pin a dead Deployment forever.
         and not exists (
           select 1
             from "workflow"."dispatch_dead_letters" as dead
            where dead.tenant_id = runs.tenant_id
              and dead.run_id = runs.id
              and dead.resolved_at is null
         )
    `;
    return new Set(rows.map((row) => row.deployment_id as string));
  } catch (error) {
    throw new Error(
      `Failed to read active workflow runs for ${projectId} from the platform workflow world.`,
      { cause: error },
    );
  } finally {
    await sql.end();
  }
}
