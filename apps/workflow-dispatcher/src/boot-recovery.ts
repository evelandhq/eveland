import { getQueueTopicPrefix } from "@workflow/world";
import { MessageData } from "@eveland/workflow-world";
import type { WorkerUtils } from "graphile-worker";
import type { Pool } from "pg";
import { FLOW_JOB_NAME } from "./runner.js";

/**
 * A dispatcher that dies mid-POST leaves its graphile jobs locked to a worker
 * id that will never come back. graphile only releases those after a multi-hour
 * abandonment timeout, which for a durable timer is indistinguishable from
 * being lost.
 *
 * Every generation of the dispatcher therefore takes a distinct worker-id
 * prefix and force-unlocks the previous generations' at boot. All claim state
 * lives in Postgres, so a restart is a brief pause, never data loss — and
 * nothing here depends on the dispatcher being a singleton.
 */
export const WORKER_ID_PREFIX = "eveland-dispatcher";

export async function releaseAbandonedLocks(input: {
  pool: Pool;
  workerUtils: WorkerUtils;
  currentWorkerId: string;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<number> {
  const { rows } = await input.pool.query<{ worker_id: string }>(
    `select distinct locked_by as worker_id
       from graphile_worker.jobs
      where locked_by is not null
        and locked_by like $1
        and locked_by <> $2`,
    [`${WORKER_ID_PREFIX}%`, input.currentWorkerId],
  );
  const stale = rows.map((row) => row.worker_id);
  if (stale.length === 0) return 0;
  await input.workerUtils.forceUnlockWorkers(stale);
  input.log?.("released locks from previous dispatcher generations", {
    workers: stale.length,
  });
  return stale.length;
}

/**
 * Re-enqueue every tenant's active runs across the shared database.
 *
 * This is the platform-side counterpart to the world's per-tenant re-enqueue.
 * It is safe to run repeatedly: `jobKey` collapses duplicates, and the workflow
 * handler replays the event log rather than re-executing completed work.
 */
export async function reenqueueActiveRunsForAllTenants(input: {
  pool: Pool;
  workerUtils: WorkerUtils;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<number> {
  const prefix = getQueueTopicPrefix("workflow");
  const { rows } = await input.pool.query<{
    tenant_id: string;
    id: string;
    name: string;
    deployment_id: string;
  }>(
    `select tenant_id, id, name, deployment_id
       from workflow.workflow_runs
      where status in ('pending', 'running')
      order by tenant_id, created_at`,
  );

  let enqueued = 0;
  for (const row of rows) {
    const messageId = `msg_recover_${row.id}`;
    const message: MessageData = {
      id: `${prefix}${row.name}`,
      data: Buffer.from(JSON.stringify({ runId: row.id })),
      attempt: 1,
      messageId: messageId as MessageData["messageId"],
      tenantId: row.tenant_id,
      deploymentId: row.deployment_id,
    };
    try {
      await input.workerUtils.addJob(FLOW_JOB_NAME, MessageData.encode(message), {
        // Stable per run, so a recovery sweep that overlaps a still-queued job
        // collapses instead of doubling it.
        jobKey: messageId,
        maxAttempts: 3,
        flags: [`project:${row.tenant_id}`],
      });
      enqueued += 1;
    } catch (error) {
      input.log?.("failed to re-enqueue run during boot recovery", {
        runId: row.id,
        tenantId: row.tenant_id,
        error: String(error),
      });
    }
  }

  if (enqueued > 0) {
    input.log?.("re-enqueued active runs on boot", { runs: enqueued });
  }
  return enqueued;
}
