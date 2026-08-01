import type { Job } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import { isSupportedEveDependency, unsupportedEveVersionMessage } from "@eveland/core/source";
import {
  decryptSecretValue,
  maskKnownSecrets,
  type EncryptedSecret,
} from "@eveland/core/server/secrets";
import {
  createScheduleDispatchCredential,
  resolveSchedulerDispatchSecret,
  resolveSchedulerRuntimeSecret,
} from "@eveland/core/server/scheduler-dispatch";
import type { Store } from "@eveland/db";
import {
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import net from "node:net";
import { access, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { waitForHttpHealth } from "../runtime/health.js";
import { createRuntimeAdapterForKind, createRuntimeAdapterFromEnv } from "../runtime/select.js";
import { resolveProjectSandboxCacheDir, resolveSandboxCacheRoot } from "../runtime/systemd.js";
import { processSafeName, type RuntimeAdapter, type RuntimeCommandContext } from "../runtime/types.js";
import { PLATFORM_WORKFLOW_WORLD } from "../runtime/workflow-world.js";
import { dropProjectWorkflowWorld, ensureProjectWorkflowWorld } from "../runtime/workflow-world-bootstrap.js";
import { ensureDeploymentActive, startRuntimeInstance } from "../runtime/activation-manager.js";
import { importGitSource, getGitCommitSha } from "../source/importer.js";
import { scanEveSource } from "../source/scan.js";

import { processJob } from "./process-job.js";
import { devSecretKey, errorMessage, parseEncryptedSecret } from "./process-support.js";
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
          work: (signal) => processJob(store, job, { ...options, signal }),
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
        if (job.type === "ensure_deployment_running") {
          await store.updateRuntimeInstance(job.payload.runtimeInstanceId, {
            status: "failed",
            error: message,
          });
        }
        // A failed import never touches the running container, so it must not report a
        // live deployment as failed; only deploy/restart jobs change deployment status.
        if (job.type === "delete_project") {
          await store.setProjectDeletionFailed(job.projectId, message);
        } else if (job.type === "build_deploy") {
          const production = await store.getCurrentDeployment(job.projectId);
          await store.updateProjectState(
            job.projectId,
            production &&
              (production.status === "running" ||
                production.status === "draining")
              ? {
                  status: "failed",
                  deploymentStatus: production.status,
                }
              : { status: "failed", deploymentStatus: "failed" },
          );
        } else if (job.type === "ensure_deployment_running") {
          const production = await store.getCurrentDeployment(job.projectId);
          if (production?.id === job.payload.deploymentId) {
            await store.updateProjectState(job.projectId, {
              status: "failed",
            });
          }
        } else if (job.type !== "archive_deployment") {
          await store.updateProjectState(
            job.projectId,
            job.type === "restart_deployment"
              ? { status: "failed", deploymentStatus: "failed" }
              : { status: "failed" },
          );
        }
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
export async function processNextSourcePreflight(
  store: Store,
  workerId: string,
  options: ProcessJobOptions = {},
): Promise<boolean> {
  const preflight = await store.claimNextSourcePreflight(workerId);
  if (!preflight) return false;
  let managedAttemptDir: string | null = null;

  try {
    await runWithJobHeartbeat({
      intervalMs: options.jobHeartbeatIntervalMs ?? Number(process.env.WORKER_JOB_HEARTBEAT_INTERVAL_MS ?? 30_000),
      heartbeat: () => store.heartbeatSourcePreflight(preflight.id, preflight.attempts),
      work: async () => {
        let sourcePath = preflight.sourcePath;
        let commitSha = preflight.commitSha;
        if (!sourcePath && preflight.kind === "git") {
          if (!preflight.gitUrl) throw new Error("Git preflight missing gitUrl.");
          managedAttemptDir = path.join(
            options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data",
            "preflights",
            preflight.id,
            `attempt-${preflight.attempts}`,
          );
          sourcePath = path.join(
            managedAttemptDir,
            "source",
          );
          await importGitSource({
            gitUrl: preflight.gitUrl,
            targetDir: sourcePath,
            ...(preflight.gitCredential ? {
              credential: {
                host: preflight.gitCredential.host,
                token: decryptSecretValue(
                  parseEncryptedSecret(preflight.gitCredential.encryptedToken),
                  options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey,
                ),
              },
            } : {}),
          });
          commitSha = await getGitCommitSha(sourcePath);
        }
        if (!sourcePath) throw new Error("Source preflight missing sourcePath.");

        const scan = await scanEveSource({ kind: preflight.kind, sourcePath, commitSha });
        const completed = await store.completeSourcePreflight(preflight.id, preflight.attempts, {
          sourcePath,
          commitSha,
          summary: scan.summary,
        });
        if (!completed) throw new Error(`Source preflight ${preflight.id} lost its worker lease.`);
      },
    });
    return true;
  } catch (error) {
    if (managedAttemptDir) await rm(managedAttemptDir, { recursive: true, force: true });
    await store.failSourcePreflight(preflight.id, preflight.attempts, errorMessage(error));
    return true;
  }
}

export async function cleanupExpiredSourcePreflights(
  store: Store,
  dataDir = process.env.EVELAND_DATA_DIR ?? ".eveland-data",
  now = new Date(),
): Promise<number> {
  const paths = await store.expireSourcePreflights(now, 25);
  const root = path.resolve(dataDir);
  let removed = 0;
  for (const sourcePath of paths) {
    const resolved = path.resolve(sourcePath);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) continue;
    let cleanupTarget = resolved;
    for (let cursor = resolved; cursor !== root; cursor = path.dirname(cursor)) {
      const name = path.basename(cursor);
      if (name.startsWith("zip-") || name.startsWith("pre_")) {
        cleanupTarget = cursor;
        break;
      }
      if (path.dirname(cursor) === cursor) break;
    }
    await rm(cleanupTarget, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
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
