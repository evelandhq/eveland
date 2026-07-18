import type { Job, PlatformSecretProfileRecord } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import { isSupportedEveDependency, unsupportedEveVersionMessage } from "@eveland/core/source";
import {
  decryptSecretValue,
  maskKnownSecrets,
  mergeRuntimeEnvironment,
  type EncryptedSecret,
} from "@eveland/core/server/secrets";
import {
  createScheduleDispatchCredential,
  resolveSchedulerDispatchSecret,
  resolveSchedulerRuntimeSecret,
} from "@eveland/core/server/scheduler-dispatch";
import type { Store } from "@eveland/db";
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
  resolveObserverOutboxDirs,
  resolveSandboxCacheDirs,
} from "./process-support.js";

export async function processNextJob(store: Store, workerId: string, options: ProcessJobOptions = {}): Promise<boolean> {
  const job = await store.claimNextJob(workerId);
  if (!job) {
    return false;
  }

  try {
    await runWithJobHeartbeat({
      intervalMs: options.jobHeartbeatIntervalMs ?? Number(process.env.WORKER_JOB_HEARTBEAT_INTERVAL_MS ?? 30_000),
      heartbeat: () => store.heartbeatJob(job.id, job.attempts),
      work: () => processJob(store, job, options),
    });
    await clearTemporaryGitCredential(store, job);
    await store.completeJob(job.id, job.attempts);
    return true;
  } catch (error) {
    const message = errorMessage(error);
    await clearTemporaryGitCredential(store, job);
    const failed = await store.failJob(job.id, message, job.attempts);
    if (!failed) return true;
    // A failed import never touches the running container, so it must not report a
    // live deployment as failed; only deploy/restart jobs change deployment status.
    if (job.type === "delete_project") {
      await store.setProjectDeletionFailed(job.projectId, message);
    } else if (job.type === "build_deploy") {
      const production = await store.getCurrentDeployment(job.projectId);
      await store.updateProjectState(
        job.projectId,
        production && (production.status === "running" || production.status === "draining")
          ? { status: "failed", deploymentStatus: production.status }
          : { status: "failed", deploymentStatus: "failed" },
      );
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
  }
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
  if (job.type !== "import_source" || !("gitCredential" in job.payload)) return;
  const { gitCredential: _gitCredential, ...payload } = job.payload;
  await store.replaceJobPayload(job.id, payload, job.attempts);
}

export async function runWithJobHeartbeat<T>(input: {
  intervalMs: number;
  heartbeat: () => Promise<boolean>;
  work: () => Promise<T>;
}): Promise<T> {
  const timer = setInterval(() => {
    void input.heartbeat().catch(() => undefined);
  }, input.intervalMs);
  timer.unref();
  try {
    return await input.work();
  } finally {
    clearInterval(timer);
  }
}
