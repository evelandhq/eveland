/**
 * Every transition that makes a job row claimable NOTIFYs this channel, so an
 * idle worker wakes immediately instead of waiting out its poll interval.
 * Delivery is best-effort by design: polling remains the correctness
 * fallback, a lost notification only costs latency.
 */
export const JOB_QUEUE_CHANNEL = "eveland_job_queue";

import type { Database } from "./client.js";

export type JobQueueListener = {
  close(): Promise<void>;
};

/**
 * Subscribes to JOB_QUEUE_CHANNEL on a dedicated connection (postgres.js
 * establishes it lazily, outside the pool, and re-subscribes after connection
 * loss on its own). `onQueued` also fires on every (re)subscription, because
 * notifications sent while the connection was down are gone — the worker must
 * re-check the queue rather than trust the gap.
 */
export async function listenForQueuedJobs(
  database: Database,
  onQueued: () => void,
): Promise<JobQueueListener> {
  const { unlisten } = await database.client.listen(
    JOB_QUEUE_CHANNEL,
    () => onQueued(),
    () => onQueued(),
  );
  return { close: unlisten };
}
