import type { WorkflowDispatchWorkload } from "@evelandhq/core/instance-health";
import postgres from "postgres";

/**
 * Operator-facing dispatch counts from the shared `@evelandhq/workflow-world`
 * database: unresolved dead letters (the count query is what the world's
 * partial `... where resolved_at is null` index exists for) and active runs,
 * split out by whether an unresolved dead letter quarantines them — those are
 * permanently stuck, because boot recovery anti-joins them away.
 *
 * Returns null when no world is configured, so the health report can omit the
 * component instead of alarming on a run-out instance. A configured world
 * that fails to answer is different: reporting zeros over dropped work would
 * be exactly the invisibility this exists to end, so the error propagates and
 * the caller reports the component unavailable.
 */
export async function collectWorkflowDispatchWorkload(
  worldUrl: string | undefined,
): Promise<WorkflowDispatchWorkload | null> {
  if (!worldUrl) return null;
  const sql = postgres(worldUrl, { max: 1 });
  try {
    const [deadLetters] = await sql`
      select count(*)::int as count, min(created_at) as oldest_at
        from "workflow"."dispatch_dead_letters"
       where resolved_at is null
    `;
    const runs = await sql`
      select runs.status,
             count(*)::int as count,
             (count(*) filter (where exists (
               select 1
                 from "workflow"."dispatch_dead_letters" as dead
                where dead.tenant_id = runs.tenant_id
                  and dead.run_id = runs.id
                  and dead.resolved_at is null
             )))::int as stuck
        from "workflow"."workflow_runs" as runs
       where runs.status in ('pending', 'running')
       group by runs.status
    `;
    const byStatus = new Map(runs.map((row) => [row.status as string, row]));
    const oldestAt = deadLetters?.oldest_at;
    return {
      pendingRuns: (byStatus.get("pending")?.count as number) ?? 0,
      runningRuns: (byStatus.get("running")?.count as number) ?? 0,
      stuckRuns: runs.reduce((total, row) => total + (row.stuck as number), 0),
      unresolvedDeadLetters: (deadLetters?.count as number) ?? 0,
      oldestUnresolvedDeadLetterAt: oldestAt instanceof Date ? oldestAt.toISOString() : null,
    };
  } catch (error) {
    throw new Error("Failed to read dispatch workload from the platform workflow world.", {
      cause: error,
    });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
