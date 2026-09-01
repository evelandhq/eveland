import { z } from "zod";

import type { Job, JobPayloadMap, JobStatus, JobType, PublicJob } from "./contracts.js";

const gitCredentialSchema = z
  .object({
    userId: z.string(),
    host: z.string(),
    encryptedToken: z.string(),
    persistAfterImport: z.boolean(),
  })
  .passthrough();

const jobPayloadSchemas: {
  [Type in JobType]: z.ZodType<JobPayloadMap[Type]>;
} = {
  import_source: z
    .object({
      importKind: z.enum(["git", "zip"]).optional(),
      gitUrl: z.string().nullable().optional(),
      sourcePath: z.string().nullable().optional(),
      gitCredential: gitCredentialSchema.optional(),
      deployAfterImport: z.boolean().optional(),
      promoteAfterDeploy: z.boolean().optional(),
    })
    .passthrough(),
  build_deploy: z.object({ promoteAfterDeploy: z.boolean().optional() }).passthrough(),
  restart_deployment: z
    .object({
      deploymentId: z.string().optional(),
      reason: z.string().optional(),
    })
    .passthrough(),
  trigger_schedule: z.object({ scheduleRunId: z.string() }).passthrough(),
  ensure_deployment_running: z
    .object({
      deploymentId: z.string(),
      runtimeInstanceId: z.string(),
    })
    .passthrough(),
  archive_deployment: z
    .object({
      deploymentId: z.string(),
      automatic: z.boolean().optional(),
    })
    .passthrough(),
  delete_project: z.object({ sourcePaths: z.array(z.string()).optional() }).passthrough(),
};

/**
 * Job types that run a full build (`npm ci` + `npx eve build`, 1-2 GB peak
 * each) and therefore count against the worker's global heavy-job concurrency
 * cap. Every other job type — including import_source, which only fetches and
 * scans source before enqueueing a separate build_deploy — is cheap and must
 * never queue behind a build.
 */
export const HEAVY_JOB_TYPES = ["build_deploy"] as const satisfies readonly JobType[];

/**
 * Job types on the session-critical path: a queued activation or schedule
 * dispatch is racing Eve's fixed 30-second command-hook wait (a session create
 * fails with HTTP 500 when its run is not dispatched in time), so claiming
 * lets them jump ahead of operator-paced work (imports, builds, restarts) and
 * cleanup. Among themselves, and within every other type, FIFO order holds.
 */
export const LATENCY_SENSITIVE_JOB_TYPES = [
  "ensure_deployment_running",
  "trigger_schedule",
] as const satisfies readonly JobType[];

const jobTypeSet = new Set<JobType>(Object.keys(jobPayloadSchemas) as JobType[]);
const jobStatusSet = new Set<JobStatus>(["queued", "running", "completed", "failed"]);

export function isJobType(value: string): value is JobType {
  return jobTypeSet.has(value as JobType);
}

export function isJobStatus(value: string): value is JobStatus {
  return jobStatusSet.has(value as JobStatus);
}

export function decodeJobPayload<Type extends JobType>(
  type: Type,
  payload: unknown,
): JobPayloadMap[Type] {
  return jobPayloadSchemas[type].parse(payload);
}

export function toPublicJob(job: Job): PublicJob {
  return {
    id: job.id,
    projectId: job.projectId,
    type: job.type,
    status: job.status,
    payload: {},
    attempts: job.attempts,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
