import {
  ensureTenantPartitions,
  dropTenantPartitions,
  runMigrations,
} from "@eveland/workflow-world";
import { Pool } from "pg";

/**
 * Provisioning for the platform workflow world.
 *
 * The legacy world provisions a whole database per project
 * ([workflow-world-bootstrap.ts](./workflow-world-bootstrap.ts)); this one only
 * has to create the project's partitions in the shared database. Both are
 * idempotent and both run before any process starts with the world configured.
 *
 * Migrations run here too so a fresh platform install does not require a
 * separate setup step before the first deploy. `runMigrations` takes an
 * advisory lock, so concurrent workers serialize rather than racing.
 */
export async function ensureEvelandWorkflowTenant(
  worldUrl: string,
  projectId: string,
): Promise<void> {
  const pool = new Pool({ connectionString: worldUrl, max: 1 });
  try {
    await runMigrations(pool);
    await ensureTenantPartitions(pool, projectId);
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Deployments of this project that still own a non-terminal run.
 *
 * Feeds the `active_workflow_run` retention reason. Non-terminal is `pending`
 * or `running`: upstream removed the `paused` status, and a run sleeping on a
 * timer is `running` with a wait row, so the two statuses cover it.
 *
 * Returns an empty set when the world is not configured, which keeps this safe
 * to call unconditionally during the run-out — a project still on
 * world-postgres simply contributes no protected deployments here.
 */
export async function listDeploymentsWithActiveWorkflowRuns(
  worldUrl: string | undefined,
  projectId: string,
): Promise<Set<string>> {
  if (!worldUrl) return new Set();
  const pool = new Pool({ connectionString: worldUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ deployment_id: string }>(
      `select distinct deployment_id
         from workflow.workflow_runs
        where tenant_id = $1 and status in ('pending', 'running')`,
      [projectId],
    );
    return new Set(rows.map((row) => row.deployment_id));
  } catch {
    // The world may not be migrated yet on a platform that has not enabled it.
    // Failing open here would be wrong in the other direction — an error must
    // not silently unprotect deployments — so callers treat a throw as fatal
    // and this only swallows the "table does not exist" case by returning empty
    // for an unconfigured world above.
    throw new Error(
      `Failed to read active workflow runs for ${projectId} from the platform workflow world.`,
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Deleting a project drops its partitions, which returns the storage
 * immediately instead of leaving dead tuples behind — the same reason the
 * legacy path drops the whole database.
 */
export async function dropEvelandWorkflowTenant(
  worldUrl: string,
  projectId: string,
): Promise<void> {
  const pool = new Pool({ connectionString: worldUrl, max: 1 });
  try {
    await dropTenantPartitions(pool, projectId);
  } finally {
    await pool.end().catch(() => {});
  }
}
