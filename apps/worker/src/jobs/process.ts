import type { Job } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";
import {
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

import { dispatchJob, settleJobFailure } from "./job-registry.js";
import { errorMessage } from "./process-support.js";
import type { ProcessJobOptions } from "./process-types.js";

export type { ProcessJobOptions, ScheduleDispatchInput } from "./process-types.js";
export {
  allocateAvailableHostPort,
  invalidateGatewayRouteCache,
  resolveSandboxCacheDirs,
} from "./process-support.js";

export async function processNextJob(store: Store, workerId: string, options: ProcessJobOptions = {}): Promise<boolean> {
  const job = await store.claimNextJob(workerId);
  if (!job) {
    return false;
  }

  const tracer =
    options.tracer ??
    trace.getTracer("@eveland/worker-jobs");
  return tracer.startActiveSpan(
    `eveland.job ${job.type}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "eveland.job.id": job.id,
        "eveland.job.type": job.type,
        "eveland.job.attempt": job.attempts,
        "eveland.project.id": job.projectId,
        "eveland.telemetry.domain": "runtime",
      },
    },
    async (span) => {
      try {
        await runWithJobHeartbeat({
          intervalMs:
            options.jobHeartbeatIntervalMs ??
            Number(
              process.env.WORKER_JOB_HEARTBEAT_INTERVAL_MS ?? 30_000,
            ),
          heartbeat: () => store.heartbeatJob(job.id, job.attempts),
          work: (signal) => dispatchJob(store, job, { ...options, signal }),
        });
        await clearTemporaryGitCredential(store, job);
        await store.completeJob(job.id, job.attempts);
        span.setStatus({ code: SpanStatusCode.OK });
        return true;
      } catch (error) {
        const message = errorMessage(error);
        span.recordException(
          error instanceof Error ? error : new Error(message),
        );
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        await clearTemporaryGitCredential(store, job);
        const failed = await store.failJob(job.id, message, job.attempts);
        if (!failed) return true;
        // What a failed job family means for the project lives with the
        // handlers; only claiming, fencing, and logging stay here.
        await settleJobFailure(store, job, message);
        await store.appendLog({
          projectId: job.projectId,
          type: "runtime",
          line: `Job ${job.id} failed: ${message}`,
        });
        return true;
      } finally {
        span.end();
      }
    },
  );
}
async function clearTemporaryGitCredential(store: Store, job: Job): Promise<void> {
  if (job.type !== "import_source" || !job.payload.gitCredential) return;
  const { gitCredential: _gitCredential, ...payload } = job.payload;
  await store.replaceJobPayload(
    job.id,
    "import_source",
    payload,
    job.attempts,
  );
}

/** The job row was fenced away from this execution (recovered as stale and re-claimed). */
export class JobLeaseLostError extends Error {
  constructor(message = "Job lease lost; another execution owns this job now.") {
    super(message);
    this.name = "JobLeaseLostError";
  }
}

export async function runWithJobHeartbeat<T>(input: {
  intervalMs: number;
  heartbeat: () => Promise<boolean>;
  work: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const timer = setInterval(() => {
    void input
      .heartbeat()
      .then((held) => {
        // `false` means the attempt-fenced row rejected our heartbeat: the job
        // was recovered as stale and re-claimed. The row itself is safe, but
        // this execution's host side effects (build, start, promote) are not
        // fenced -- abort them instead of racing the new execution. A thrown
        // heartbeat (transient DB failure) is NOT a lost lease and stays
        // swallowed; only an explicit rejection aborts.
        if (!held && !controller.signal.aborted) {
          controller.abort(new JobLeaseLostError());
        }
      })
      .catch(() => undefined);
  }, input.intervalMs);
  timer.unref();
  try {
    return await input.work(controller.signal);
  } finally {
    clearInterval(timer);
  }
}
