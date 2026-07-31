import postgres from "postgres";
import {
  PROJECT_WORKFLOW_DATABASE_PREFIX,
  resolveBootstrapPostgresUrl,
} from "./workflow-world-bootstrap.js";

/**
 * eve persists one durable stream chunk per token delta (each carrying the
 * full accumulated message, vercel/eve#1441) and @workflow/world-postgres
 * never deletes chunks, so per-project workflow databases grow without bound
 * (#213: one project reached 14 GB, 99.56% redundant bytes). Once a run is
 * terminal its chunks are delivery-only — session program memory lives in
 * workflow step results, not this table — so chunks of terminal runs past the
 * resume window are safe to drop.
 *
 * The eof marker rows must survive: the streamer reads data rows with
 * eof = false and decides termination via a separate eof = true lookup, so
 * deleting the marker leaves a late reader waiting forever instead of ending
 * cleanly.
 */

export type WorkflowWorldSweepOptions = {
  /** Terminal runs younger than this keep their chunks so clients can still resume the stream. */
  retentionMs?: number;
  /** Rows deleted per DELETE statement; bounds lock time and WAL burst per batch. */
  batchSize?: number;
};

export type WorkflowWorldSweepDeps = {
  listWorkflowDatabases: (bootstrapUrl: string, prefix: string) => Promise<string[]>;
  pruneTerminalStreamChunks: (
    databaseUrl: string,
    input: { retentionMs: number; batchSize: number },
  ) => Promise<number>;
  onDatabaseError: (databaseName: string, error: unknown) => void;
};

const defaultDeps: WorkflowWorldSweepDeps = {
  listWorkflowDatabases,
  pruneTerminalStreamChunks,
  onDatabaseError: (databaseName, error) =>
    console.error(
      `Workflow stream retention sweep failed for ${databaseName}:`,
      error instanceof Error ? error.message : String(error),
    ),
};

/**
 * Deletes stream chunks of terminal runs older than the resume window from
 * every per-project workflow database. Databases are enumerated from
 * pg_database rather than the project store so orphaned databases are swept
 * too, and each database is swept independently: projects are created and
 * dropped concurrently, so one vanishing mid-sweep must not abort the rest.
 * Returns the total number of deleted rows.
 */
export async function sweepWorkflowStreamRetention(
  env: NodeJS.ProcessEnv,
  options: WorkflowWorldSweepOptions = {},
  overrides: Partial<WorkflowWorldSweepDeps> = {},
): Promise<number> {
  const workflowPostgresUrl = env.WORKFLOW_POSTGRES_URL;
  if (!workflowPostgresUrl) return 0;

  const deps = { ...defaultDeps, ...overrides };
  const retentionMs = sanitize(options.retentionMs, 86_400_000, 0);
  const batchSize = sanitize(options.batchSize, 50_000, 1);
  const bootstrapBaseUrl = resolveBootstrapPostgresUrl(env, workflowPostgresUrl);

  let deleted = 0;
  for (const databaseName of await deps.listWorkflowDatabases(
    bootstrapBaseUrl,
    PROJECT_WORKFLOW_DATABASE_PREFIX,
  )) {
    const url = new URL(bootstrapBaseUrl);
    url.pathname = `/${databaseName}`;
    try {
      deleted += await deps.pruneTerminalStreamChunks(url.toString(), { retentionMs, batchSize });
    } catch (error) {
      deps.onDatabaseError(databaseName, error);
    }
  }
  return deleted;
}

function sanitize(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

async function listWorkflowDatabases(bootstrapUrl: string, prefix: string): Promise<string[]> {
  const sql = postgres(bootstrapUrl, { max: 1 });
  try {
    const rows = await sql`
      select datname from pg_database
      where datallowconn and starts_with(datname, ${prefix})
      order by datname
    `;
    return rows.map((row) => row.datname as string);
  } finally {
    await sql.end();
  }
}

async function pruneTerminalStreamChunks(
  databaseUrl: string,
  input: { retentionMs: number; batchSize: number },
): Promise<number> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    let total = 0;
    // The cutoff is computed in SQL: run timestamps default to the server's
    // now(), so comparing against a client-side clock would skew by any
    // client/server timezone difference on these tz-less columns.
    for (;;) {
      const result = await sql`
        delete from "workflow"."workflow_stream_chunks"
        where ctid in (
          select c.ctid
          from "workflow"."workflow_stream_chunks" c
          join "workflow"."workflow_runs" r on r.id = c.run_id
          where c.eof = false
            and r.status in ('completed', 'failed', 'cancelled')
            and coalesce(r.completed_at, r.updated_at) < now() - make_interval(secs => ${input.retentionMs / 1_000})
          limit ${input.batchSize}
        )
      `;
      total += result.count;
      if (result.count < input.batchSize) return total;
    }
  } finally {
    await sql.end();
  }
}
