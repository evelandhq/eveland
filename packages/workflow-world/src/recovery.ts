import {
  getQueueTopicPrefix,
  type Queue,
  type Storage,
  type ValidQueueName,
} from "@workflow/world";

/**
 * Re-enqueue this tenant's active (pending/running) runs so they resume after a
 * restart. The workflow handler is idempotent — it replays the event log — so
 * duplicate enqueues are safe.
 *
 * This exists instead of upstream's `reenqueueActiveRuns` because that function
 * lists runs unfiltered. With one database per project that was merely wasteful;
 * on a shared database it would mean every agent's boot re-enqueues every
 * project's active runs. Passing an already tenant-scoped `runs` makes the
 * scoping structural rather than something this function has to remember.
 */
export async function reenqueueTenantRuns(input: {
  runs: Storage["runs"];
  enqueue: Queue["queue"];
  tenantId: string;
}): Promise<number> {
  const workflowQueuePrefix = getQueueTopicPrefix("workflow");
  let reenqueued = 0;

  for (const status of ["pending", "running"] as const) {
    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const page = await input.runs.list({
        status,
        resolveData: "none",
        pagination: { cursor },
      });
      for (const run of page.data) {
        try {
          const queueName = `${workflowQueuePrefix}${run.workflowName}` as ValidQueueName;
          await input.enqueue(queueName, { runId: run.runId });
          reenqueued += 1;
        } catch (error) {
          console.warn(
            `[eveland workflow world] Failed to re-enqueue run ${run.runId} for ${input.tenantId}: ${String(error)}`,
          );
        }
      }
      hasMore = page.hasMore;
      cursor = page.cursor ?? undefined;
    }
  }

  if (reenqueued > 0) {
    console.log(
      `[eveland workflow world] Re-enqueued ${String(reenqueued)} active run(s) for ${input.tenantId} on startup`,
    );
  }
  return reenqueued;
}
