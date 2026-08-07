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
export async function listDeploymentsWithActiveWorkflowRuns(
  worldUrl: string | undefined,
  projectId: string,
): Promise<Set<string>> {
  if (!worldUrl) return new Set();
  const sql = postgres(worldUrl, { max: 1 });
  try {
    const rows = await sql`
      select distinct deployment_id
        from "workflow"."workflow_runs"
       where tenant_id = ${projectId} and status in ('pending', 'running')
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
