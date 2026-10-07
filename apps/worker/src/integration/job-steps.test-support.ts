import type { Job, JobStatus, JobType } from "@evelandhq/core/contracts";
import type { Store } from "@evelandhq/db";
import { runClaimedJob, type ProcessJobOptions } from "../jobs/process.js";

export type ExpectedJob = {
  projectId: string;
  type: JobType;
  /** The exact row, when the harness enqueued it and holds its id. */
  id?: string;
  /** A follow-up the worker queued itself names its parent (import_source -> build_deploy). */
  parentJobId?: string;
  /** How the job must settle; a harness proving a failure path expects "failed". */
  status?: Extract<JobStatus, "completed" | "failed">;
};

// Builds append their whole output as one log line; the error is at its end.
const LOG_LINE_TAIL_CHARS = 4_000;
const LOG_TAIL_ROWS = 40;

/**
 * Claims the next job, asserts it is the one the harness expects, runs it,
 * and asserts how it settled. `processNextJob` only reports that *some* job
 * ran: a different claimable job, or the expected one failing (its error
 * lives only in the in-memory store's `jobs.last_error`, gone when the
 * harness exits), both read as success, and the harness then failed a step
 * later with no cause. Every mismatch throws with the project's job table and
 * log tail, so a Lima flake is diagnosable from the run's output alone.
 */
export async function runExpectedJob(
  store: Store,
  workerId: string,
  expected: ExpectedJob,
  options: ProcessJobOptions = {},
): Promise<Job> {
  const label = describeExpectation(expected);
  const claimed = await store.claimNextJob(workerId, undefined, {
    maxConcurrentHeavyJobs: options.maxConcurrentHeavyJobs,
  });
  if (!claimed) {
    throw await jobStepError(store, expected.projectId, `${label}: no claimable job.`);
  }
  if (!matchesExpectation(claimed, expected)) {
    throw await jobStepError(
      store,
      expected.projectId,
      `${label}: claimed ${claimed.type} ${claimed.id} (project ${claimed.projectId}${
        jobParentId(claimed) ? `, parent ${jobParentId(claimed)}` : ""
      }) instead.`,
    );
  }

  await runClaimedJob(store, claimed, options);

  const wantedStatus = expected.status ?? "completed";
  const settled = (await store.listProjectJobs(expected.projectId, { limit: 100 })).find(
    (job) => job.id === claimed.id,
  );
  if (!settled) {
    // A completed delete_project removes its project's rows with it.
    if (claimed.type === "delete_project" && wantedStatus === "completed") return claimed;
    throw await jobStepError(
      store,
      expected.projectId,
      `${label}: job row vanished after running.`,
    );
  }
  if (settled.status !== wantedStatus) {
    throw await jobStepError(
      store,
      expected.projectId,
      `${label}: settled ${settled.status}, expected ${wantedStatus}.`,
    );
  }
  return settled;
}

/** The project's jobs (oldest first) and recent logs, for a failure message. */
export async function describeProjectJobs(store: Store, projectId: string): Promise<string> {
  const jobs = [...(await store.listProjectJobs(projectId, { limit: 100 }))].reverse();
  const { logs } = await store.listLogsPage(projectId, undefined, { limit: LOG_TAIL_ROWS });
  const jobLines = jobs.map((job) =>
    [
      `  ${job.id} ${job.type}`,
      `status=${job.status}`,
      `attempts=${job.attempts}`,
      ...(jobParentId(job) ? [`parent=${jobParentId(job)}`] : []),
      `created=${job.createdAt}`,
      `lastError=${job.lastError === null ? "-" : JSON.stringify(job.lastError)}`,
    ].join(" "),
  );
  const logLines = logs.map((log) => {
    const line =
      log.line.length > LOG_LINE_TAIL_CHARS
        ? `...${log.line.slice(-LOG_LINE_TAIL_CHARS)}`
        : log.line;
    return `  [${log.type}] ${line}`;
  });
  return [
    `Jobs for project ${projectId}:`,
    ...(jobLines.length > 0 ? jobLines : ["  (none)"]),
    `Last ${LOG_TAIL_ROWS} log lines:`,
    ...(logLines.length > 0 ? logLines : ["  (none)"]),
  ].join("\n");
}

async function jobStepError(store: Store, projectId: string, message: string): Promise<Error> {
  return new Error(`${message}\n${await describeProjectJobs(store, projectId)}`);
}

function matchesExpectation(job: Job, expected: ExpectedJob): boolean {
  return (
    job.projectId === expected.projectId &&
    job.type === expected.type &&
    (expected.id === undefined || job.id === expected.id) &&
    (expected.parentJobId === undefined || jobParentId(job) === expected.parentJobId)
  );
}

function jobParentId(job: Job): string | undefined {
  return job.type === "build_deploy" ? job.payload.parentJobId : undefined;
}

function describeExpectation(expected: ExpectedJob): string {
  const qualifiers = [
    `project ${expected.projectId}`,
    ...(expected.id ? [`id ${expected.id}`] : []),
    ...(expected.parentJobId ? [`parent ${expected.parentJobId}`] : []),
  ];
  return `Expected ${expected.type} (${qualifiers.join(", ")})`;
}
