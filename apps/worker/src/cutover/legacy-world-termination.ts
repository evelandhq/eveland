import pg from "pg";
import {
  deriveProjectWorkflowDatabaseName,
  deriveProjectWorkflowUrl,
} from "../runtime/workflow-world-bootstrap.js";

/**
 * Managed termination for a legacy per-project World. Retiring a legacy owner
 * in the control plane is not enough: its runs live in the project's derived
 * `eveland_wf_*` database, which the shared-world commands never open. The
 * saga may not declare `workflow_safe` while any of those runs is still
 * active — a re-opened legacy producer would resume them.
 *
 * The whole derived database belongs to one project, so the cancel is
 * database-wide by design; `@workflow/world-postgres` is single-tenant.
 */
export type LegacyWorldTermination = {
  projectId: string;
  /** Null when the derived database does not exist (already dropped or never created). */
  database: string | null;
  cancelledRuns: number;
  /** Non-terminal runs still present AFTER the cancel; must be 0 to proceed. */
  remainingActiveRuns: number;
};

export type LegacyWorldTerminator = (
  baseUrl: string,
  projectId: string,
) => Promise<LegacyWorldTermination>;

export const terminateLegacyProjectRuns: LegacyWorldTerminator = async (baseUrl, projectId) => {
  const database = deriveProjectWorkflowDatabaseName(projectId);
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    const probe = await admin.query(`select 1 from pg_database where datname = $1`, [database]);
    if (probe.rowCount === 0) {
      return { projectId, database: null, cancelledRuns: 0, remainingActiveRuns: 0 };
    }
  } finally {
    await admin.end().catch(() => {});
  }
  const client = new pg.Client({ connectionString: deriveProjectWorkflowUrl(baseUrl, projectId) });
  await client.connect();
  try {
    // The status enum changed generations (world-postgres migration 0004
    // dropped 'paused'); comparing as text covers both without an
    // invalid-enum-literal error on either, and 'paused' — where it still
    // exists — is an active run that must not survive workflow safety.
    const cancelled = await client.query(
      `update workflow.workflow_runs
          set status = 'cancelled', completed_at = now(), updated_at = now()
        where status::text in ('pending', 'running', 'paused')`,
    );
    const remaining = await client.query(
      `select count(*)::int as active
         from workflow.workflow_runs
        where status::text in ('pending', 'running', 'paused')`,
    );
    return {
      projectId,
      database,
      cancelledRuns: cancelled.rowCount ?? 0,
      remainingActiveRuns: (remaining.rows[0] as { active: number }).active,
    };
  } finally {
    await client.end().catch(() => {});
  }
};
