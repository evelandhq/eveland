import postgres from "postgres";

/**
 * Reads and writes `workflow.dispatch_dead_letters` in the shared workflow
 * world, for the one operator action the table was always designed around and
 * never had a tool for: deciding that a dropped dispatch either gets replayed
 * or stops asking.
 *
 * Straight SQL rather than a World API call. `eveland-ctl` supervises a machine
 * whose platform processes may all be down — which is exactly when an operator
 * reaches for it — so it must not need the API, the dispatcher, or the
 * `@evelandhq/workflow-world` package to answer.
 */

/** Seconds. The world may be a managed instance rather than a loopback container. */
const CONNECT_TIMEOUT = 10;

/** One deployment's outstanding letters, as an operator has to act on them. */
export type DeadLetterGroup = {
  projectId: string;
  deploymentId: string | null;
  letters: number;
  /** Distinct runs named by these letters; a letter may name none. */
  runs: number;
  /** Of those runs, the ones still `pending`/`running` — the work actually stuck. */
  activeRuns: number;
  /** Letters naming no run at all: a dropped message with nothing to replay into. */
  runlessLetters: number;
  oldestAt: Date;
  latestReason: string;
};

export type DeadLetterSelector =
  | { kind: "all" }
  | { kind: "run"; runId: string }
  | { kind: "deployment"; deploymentId: string };

export type DeadLetterResolution = {
  letters: number;
  /** Quarantined runs the resolution just made eligible for boot recovery again. */
  replayableRuns: number;
};

export type DeadLetterStore = {
  summarize: (worldUrl: string) => Promise<DeadLetterGroup[]>;
  resolve: (worldUrl: string, selector: DeadLetterSelector) => Promise<DeadLetterResolution>;
};

type Sql = ReturnType<typeof postgres>;

async function withWorld<T>(worldUrl: string, run: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(worldUrl, {
    max: 1,
    connect_timeout: CONNECT_TIMEOUT,
    idle_timeout: CONNECT_TIMEOUT,
    onnotice: () => {},
  });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export function defaultDeadLetterStore(): DeadLetterStore {
  return {
    summarize: (worldUrl) =>
      withWorld(worldUrl, async (sql) => {
        const rows = await sql<
          {
            project_id: string;
            deployment_id: string | null;
            letters: number;
            runs: number;
            active_runs: number;
            runless_letters: number;
            oldest_at: Date;
            latest_reason: string;
          }[]
        >`
          select dead.tenant_id as project_id,
                 dead.deployment_id,
                 count(*)::int as letters,
                 count(distinct dead.run_id)::int as runs,
                 count(distinct dead.run_id)
                   filter (where runs.status in ('pending', 'running'))::int as active_runs,
                 count(*) filter (where dead.run_id is null)::int as runless_letters,
                 min(dead.created_at) as oldest_at,
                 (array_agg(dead.reason order by dead.created_at desc))[1] as latest_reason
            from "workflow"."dispatch_dead_letters" as dead
            left join "workflow"."workflow_runs" as runs
              on runs.tenant_id = dead.tenant_id and runs.id = dead.run_id
           where dead.resolved_at is null
           group by dead.tenant_id, dead.deployment_id
           order by count(*) desc, dead.tenant_id, dead.deployment_id
        `;
        return rows.map((row) => ({
          projectId: row.project_id,
          deploymentId: row.deployment_id,
          letters: row.letters,
          runs: row.runs,
          activeRuns: row.active_runs,
          runlessLetters: row.runless_letters,
          oldestAt: row.oldest_at,
          latestReason: row.latest_reason,
        }));
      }),

    resolve: (worldUrl, selector) =>
      withWorld(worldUrl, async (sql) => {
        const match =
          selector.kind === "all"
            ? sql`true`
            : selector.kind === "run"
              ? sql`dead.run_id = ${selector.runId}`
              : sql`dead.deployment_id = ${selector.deploymentId}`;
        // One statement: the runs a resolution frees have to be counted from
        // the rows it actually updated, and a second query would count a
        // different set the moment anything else is writing.
        const [row] = await sql<{ letters: number; replayable_runs: number }[]>`
          with resolved as (
            update "workflow"."dispatch_dead_letters" as dead
               set resolved_at = now()
             where dead.resolved_at is null
               and ${match}
            returning dead.tenant_id, dead.run_id
          )
          select count(*)::int as letters,
                 count(distinct (resolved.tenant_id, resolved.run_id))
                   filter (where runs.status in ('pending', 'running'))::int as replayable_runs
            from resolved
            left join "workflow"."workflow_runs" as runs
              on runs.tenant_id = resolved.tenant_id and runs.id = resolved.run_id
        `;
        return { letters: row?.letters ?? 0, replayableRuns: row?.replayable_runs ?? 0 };
      }),
  };
}
