import type { Job } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import { isSupportedEveDependency, unsupportedEveVersionMessage } from "@eveland/core/source";
import { decryptSecretValue, maskKnownSecrets, type EncryptedSecret } from "@eveland/core/server/secrets";
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

const devSecretKey = "eveland-dev-secret-key-000000000";
const runtimeDiagnosticMaxCharacters = 32_000;

export type ProcessJobOptions = {
  runtime?: RuntimeAdapter;
  // Test injection point mirroring `runtime`, used to resolve the adapter that
  // owns a *previous* deployment when its runtimeKind differs from the
  // worker's current runtime.
  runtimeForKind?: (kind: "docker" | "systemd") => RuntimeAdapter;
  appSecretKey?: string;
  allocateHostPort?: () => number | Promise<number>;
  waitForDeployment?: (input: { host: string; port: number; timeoutMs: number }) => Promise<void>;
  workflowPostgresUrl?: string;
  ensureProjectWorkflowWorld?: (env: NodeJS.ProcessEnv, projectId: string) => Promise<string | undefined>;
  dropProjectWorkflowWorld?: (env: NodeJS.ProcessEnv, projectId: string) => Promise<void>;
  nodeEnv?: string;
  dataDir?: string;
  schedulerDispatchSecret?: string;
  schedulerRuntimeSecret?: string;
  schedulerRedeemUrl?: string;
  jobHeartbeatIntervalMs?: number;
  dispatchSchedule?: (input: ScheduleDispatchInput) => Promise<{ sessionIds: string[] }>;
};

export type ScheduleDispatchInput = {
  scheduleRunId: string;
  scheduleKey: string;
  deploymentId: string;
  hostPort: number;
  credential: string;
  runtimeSecret: string;
};

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

async function processJob(store: Store, job: Job, options: ProcessJobOptions): Promise<void> {
  switch (job.type) {
    case "import_source": {
      const project = await store.getProject(job.projectId);
      if (!project) {
        throw new Error(`Project ${job.projectId} not found.`);
      }

      const sourcePathFromPayload = typeof job.payload.sourcePath === "string" ? job.payload.sourcePath : null;
      const gitCredential = readGitCredentialPayload(job.payload.gitCredential);
      let sourcePath = sourcePathFromPayload;
      let commitSha: string | null = null;

      if (!sourcePath && project.importKind === "git") {
        const gitUrl = typeof job.payload.gitUrl === "string" ? job.payload.gitUrl : project.gitUrl;
        if (!gitUrl) {
          throw new Error("Git import missing gitUrl.");
        }
        sourcePath = path.join(process.env.EVELAND_DATA_DIR ?? ".eveland-data", "sources", job.projectId, job.id);
        await importGitSource({
          gitUrl,
          targetDir: sourcePath,
          ...(gitCredential ? {
            credential: {
              host: gitCredential.host,
              token: decryptSecretValue(
                parseEncryptedSecret(gitCredential.encryptedToken),
                options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey,
              ),
            },
          } : {}),
          onRetry: async (attempt, detail) => {
            await store.appendLog({
              projectId: job.projectId,
              type: "build",
              line: `Retrying repository fetch (attempt ${attempt}): ${detail}`,
            });
          },
        });
        commitSha = await getGitCommitSha(sourcePath);
      }

      if (!sourcePath) {
        throw new Error("Source import missing sourcePath.");
      }

      const scan = await scanEveSource({
        kind: project.importKind,
        sourcePath,
        commitSha,
      });
      await store.recordSourceRevision({
        projectId: job.projectId,
        ...scan,
      });
      if (gitCredential?.persistAfterImport) {
        await store.upsertGitCredential(gitCredential.userId, gitCredential.host, gitCredential.encryptedToken);
      }
      await store.appendLog({
        projectId: job.projectId,
        type: "build",
        line: `Source import completed for ${project.name}.`,
      });

      // A re-sync can opt into deploying the freshly imported source in one step;
      // enqueued only after a successful import so a failed pull never deploys.
      if (job.payload.deployAfterImport === true) {
        await store.enqueueJob(job.projectId, "build_deploy");
        await store.appendLog({
          projectId: job.projectId,
          type: "build",
          line: `Queued deploy of the latest source for ${project.name}.`,
        });
      }
      return;
    }
    case "build_deploy": {
      const project = await store.getProject(job.projectId);
      if (!project) {
        throw new Error(`Project ${job.projectId} not found.`);
      }

      const revision = await store.getCurrentSourceRevision(job.projectId);
      if (!revision) {
        throw new Error(`Project ${job.projectId} has no source revision to deploy.`);
      }

      const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
      const isProduction = nodeEnv === "production";
      const workflowPostgresUrl = options.workflowPostgresUrl ?? process.env.WORKFLOW_POSTGRES_URL;

      if (isProduction && !workflowPostgresUrl) {
        const detail = "No WORKFLOW_POSTGRES_URL is configured for the platform-owned durable workflow world.";
        await store.appendLog({ projectId: job.projectId, type: "deploy", line: `Deploy blocked: ${detail}` });
        throw new Error(detail);
      }

      const runtime = options.runtime ?? createRuntimeAdapterFromEnv();
      const previousDeployment = await store.getCurrentDeployment(job.projectId);
      const releaseId = createId("rel");
      const deploymentId = createId("dep");
      const processName = `eveland-${processSafeName(project.id)}-${processSafeName(deploymentId)}`;
      const buildDir = path.join(process.env.EVELAND_DATA_DIR ?? ".eveland-data", "builds", project.id, releaseId);
      // A Deployment is an immutable previewable version. Never recycle a port
      // from the production target: old and new versions must be able to run
      // concurrently until an explicit promote/drain decision is made.
      const hostPort = await (options.allocateHostPort ?? allocateAvailableHostPort)();
      const { env, secretValues } = await composeDeploymentEnv(store, project.id, options);
      const commandContext = await resolveRuntimeCommandContext(revision.sourcePath);

      await store.updateProjectState(job.projectId, { status: "build_pending", deploymentStatus: "building" });
      await store.appendLog({
        projectId: job.projectId,
        type: "build",
        line: `Building release ${releaseId} from ${revision.sourcePath}.`,
      });

      const build = await runtime.buildRelease({
        projectId: project.id,
        releaseId,
        sourcePath: revision.sourcePath,
        buildDir,
        commandContext,
        ...(workflowPostgresUrl && commandContext.isEveProject ? { workflowWorld: PLATFORM_WORKFLOW_WORLD } : {}),
      });
      if (build.log.trim()) {
        await store.appendLog({
          projectId: job.projectId,
          type: "build",
          line: maskKnownSecrets(build.log.trim(), secretValues),
        });
      }
      if (build.schedulerDefinitions) {
        await store.recordScheduleVersions({
          projectId: project.id,
          sourceRevisionId: revision.id,
          definitions: build.schedulerDefinitions.map(({ key, kind, cron, sourcePath, definitionHash }) => ({
            key,
            kind,
            cron,
            sourcePath,
            definitionHash,
          })),
        });
      }

      const sandboxCache = resolveSandboxCacheDirs(process.env, project.id);
      const observerOutbox = resolveObserverOutboxDirs(process.env, project.id, deploymentId);
      await mkdir(sandboxCache.workerDir, { recursive: true });
      await mkdir(observerOutbox.workerDir, { recursive: true });
      // Only the process started by this job is its cleanup responsibility.
      let startedProcess: string | null = null;
      try {
        const started = await runtime.startProcess({
          processName,
          releaseRef: build.releaseRef,
          port: hostPort,
          env: { ...env, EVELAND_DEPLOYMENT_ID: deploymentId },
          commandContext,
          sandboxCacheDir: runtime.name === "docker" ? sandboxCache.hostDir : sandboxCache.workerDir,
          observerOutboxDir: runtime.name === "docker" ? observerOutbox.hostDir : observerOutbox.workerDir,
        });
        startedProcess = processName;
        await (options.waitForDeployment ?? waitForHttpHealth)({
          host: "127.0.0.1",
          port: hostPort,
          timeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
        });

        const deployment = await store.recordDeployment({
          releaseId,
          deploymentId,
          projectId: job.projectId,
          sourceRevisionId: revision.id,
          imageTag: build.releaseRef,
          containerName: processName,
          internalPort: started.internalPort,
          hostPort,
          runtimeKind: runtime.name,
        });
        if (!previousDeployment && build.schedulerDefinitions?.length) {
          await store.setProjectSchedulerTarget(project.id, deployment.id);
        }
        const materializedRoutes = await store.ensureDeploymentRoutes(
          project.id,
          deployment.id,
          (process.env.EVELAND_AGENT_BASE_DOMAINS ?? "agent.localhost").split(",")[0]!.trim(),
        );
        await invalidateGatewayRouteCache(process.env, materializedRoutes).catch(async (error) => {
          await store.appendLog({
            projectId: project.id,
            deploymentId: deployment.id,
            type: "deploy",
            line: `Gateway cache invalidation deferred to TTL: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
        await store.updateProjectState(job.projectId, { status: "deployed", deploymentStatus: "running" });
        await store.appendLog({
          projectId: job.projectId,
          deploymentId: deployment.id,
          type: "deploy",
          line: `Deployment running on 127.0.0.1:${hostPort}.`,
        });
      } catch (error) {
        if (startedProcess) {
          // The systemd adapter's stopProcess already removes the decrypted
          // EnvironmentFile and the unit's exit frees the port -- stopping the
          // process we just started IS the full cleanup, nothing further.
          await stopStartedProcessOnFailure(store, job.projectId, runtime, startedProcess, "deploy", secretValues);
        }
        throw error;
      }
      return;
    }
    case "restart_deployment": {
      // Flip to "starting" and log immediately, before any of the loads below can
      // throw -- a restart that fails loudly still leaves a visible trail (the
      // generic failure path in processNextJob then overwrites this to "failed").
      await store.updateProjectState(job.projectId, { deploymentStatus: "starting" });
      await store.appendLog({
        projectId: job.projectId,
        type: "deploy",
        line: "Restart requested.",
      });

      const project = await store.getProject(job.projectId);
      if (!project) {
        throw new Error(`Project ${job.projectId} not found.`);
      }
      const requestedDeploymentId = typeof job.payload.deploymentId === "string" ? job.payload.deploymentId : null;
      const deployment = requestedDeploymentId
        ? await store.getDeployment(requestedDeploymentId)
        : await store.getCurrentDeployment(job.projectId);
      if (!deployment) {
        throw new Error(requestedDeploymentId ? `Deployment ${requestedDeploymentId} not found.` : "No deployment to restart.");
      }
      if (deployment.projectId !== job.projectId) {
        throw new Error(`Deployment ${deployment.id} does not belong to project ${job.projectId}.`);
      }
      // A deployment always points at a release and a source revision; either
      // being gone is corrupt state, not a recoverable condition -- fail loudly
      // rather than restart with guessed values.
      const release = await store.getRelease(deployment.releaseId);
      if (!release) {
        throw new Error(`Release ${deployment.releaseId} not found for deployment ${deployment.id}.`);
      }
      const revision = await store.getSourceRevision(release.sourceRevisionId);
      if (!revision) {
        throw new Error(`Source revision ${release.sourceRevisionId} not found for release ${release.id}.`);
      }
      // readPackageJson swallows a vanished sourcePath into {isEveProject:false}
      // rather than throwing, so resolveRuntimeCommandContext below would silently
      // resolve a wrong (non-eve) start command instead of failing -- checked here,
      // before the pre-restart stopProcess, so a missing source dir never takes the
      // currently running process down.
      try {
        await access(revision.sourcePath);
      } catch {
        throw new Error(
          `Source directory for revision ${revision.id} is missing: ${revision.sourcePath}. Re-import the source and deploy instead.`,
        );
      }

      // An injected `options.runtime` wins outright (test convenience, mirrors
      // build_deploy); otherwise resolve strictly by the deployment's recorded
      // kind -- the worker's current default runtime is irrelevant here.
      const adapter = options.runtime ?? (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
      const { env, secretValues } = await composeDeploymentEnv(store, project.id, options);
      const commandContext = await resolveRuntimeCommandContext(revision.sourcePath);

      await adapter.stopProcess(deployment.containerName);
      // Same worker/Docker-host path pairing build_deploy uses.
      const sandboxCache = resolveSandboxCacheDirs(process.env, project.id);
      const observerOutbox = resolveObserverOutboxDirs(process.env, project.id, deployment.id);
      await mkdir(sandboxCache.workerDir, { recursive: true });
      await mkdir(observerOutbox.workerDir, { recursive: true });
      // Tracks whether the restart's own startProcess (above stop notwithstanding)
      // actually came up, so a startProcess failure -- nothing running under this
      // name -- doesn't trigger a pointless (or misleading) extra stop call.
      let restarted = false;
      try {
        await adapter.startProcess({
          processName: deployment.containerName,
          releaseRef: release.imageTag,
          port: deployment.hostPort,
          env: { ...env, EVELAND_DEPLOYMENT_ID: deployment.id },
          commandContext,
          sandboxCacheDir: adapter.name === "docker" ? sandboxCache.hostDir : sandboxCache.workerDir,
          observerOutboxDir: adapter.name === "docker" ? observerOutbox.hostDir : observerOutbox.workerDir,
        });
        restarted = true;
        await (options.waitForDeployment ?? waitForHttpHealth)({
          host: "127.0.0.1",
          port: deployment.hostPort,
          timeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
        });
      } catch (error) {
        if (restarted) {
          // A restart that cannot come up healthy must not leave a
          // crash-looping unit behind while the project reads failed.
          await stopStartedProcessOnFailure(
            store,
            job.projectId,
            adapter,
            deployment.containerName,
            "restart",
            secretValues,
          );
        }
        throw error;
      }

      // Deliberately outside the try above, unlike build_deploy's matching
      // recordDeployment block: this process is already tracked by an
      // existing deployment row, so a store failure here must not stop a
      // healthy, known process the way build_deploy must reap its own
      // untracked new one.
      await store.updateProjectState(job.projectId, { deploymentStatus: "running" });
      await store.appendLog({
        projectId: job.projectId,
        deploymentId: deployment.id,
        type: "deploy",
        line: `Deployment running on 127.0.0.1:${deployment.hostPort}.`,
      });
      return;
    }
    case "archive_deployment": {
      const deploymentId = typeof job.payload.deploymentId === "string" ? job.payload.deploymentId : null;
      if (!deploymentId) throw new Error("Archive job missing deploymentId.");
      const deployment = await store.getDeployment(deploymentId);
      if (!deployment || deployment.projectId !== job.projectId) throw new Error("Deployment not found for archive.");
      const configuredRetention = Number(process.env.EVELAND_RELEASE_RETENTION ?? 3);
      const retention = await store.getDeploymentRetention(
        job.projectId,
        Number.isFinite(configuredRetention) ? Math.max(3, Math.floor(configuredRetention)) : 3,
      );
      const policy = retention.find((entry) => entry.deployment.id === deployment.id);
      if (!policy || policy.protected) {
        throw new Error(`Deployment is protected from archive${policy?.reasons.length ? `: ${policy.reasons.join(", ")}` : "."}`);
      }
      const adapter =
        options.runtime?.name === deployment.runtimeKind
          ? options.runtime
          : (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
      if (deployment.status === "running" || deployment.status === "draining") await adapter.stopProcess(deployment.containerName);
      const release = await store.getRelease(deployment.releaseId);
      if (release && adapter.removeRelease) await adapter.removeRelease(release.imageTag);
      await store.updateDeploymentStatus(deployment.id, "archived");
      await store.appendLog({ projectId: job.projectId, deploymentId, type: "deploy", line: `Deployment ${deployment.deploymentKey} archived by retention policy.` });
      return;
    }
    case "delete_project": {
      const project = await store.getProject(job.projectId);
      if (!project) {
        // Idempotent re-run of a half-finished delete: the project row is
        // already gone, so there is nothing left to stop or remove.
        return;
      }

      // The store only makes this job claimable after other running work for
      // the project has completed, so every process created by an earlier
      // build is represented by a Deployment before cleanup starts.
      const deployments = await store.listDeployments(job.projectId);
      const liveDeployments = deployments.filter(
        (deployment) => deployment.status === "running" || deployment.status === "draining",
      );
      if (liveDeployments.length > 0) {
        await store.appendLog({
          projectId: job.projectId,
          type: "deploy",
          line: `Stopping ${liveDeployments.length} deployment(s) before deleting project.`,
        });
        for (const deployment of liveDeployments) {
          const stopAdapter =
            options.runtime?.name === deployment.runtimeKind
              ? options.runtime
              : (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
          await stopAdapter.stopProcess(deployment.containerName);
        }
      }

      const removedReleases = new Set<string>();
      for (const deployment of deployments) {
        const releaseKey = `${deployment.runtimeKind}:${deployment.releaseId}`;
        if (removedReleases.has(releaseKey)) continue;
        const release = await store.getRelease(deployment.releaseId);
        const adapter =
          options.runtime?.name === deployment.runtimeKind
            ? options.runtime
            : (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
        if (release && adapter.removeRelease) await adapter.removeRelease(release.imageTag);
        removedReleases.add(releaseKey);
      }

      // The project's derived workflow database goes with the project.
      // Dropped before deleteProject so a failed drop leaves the project row
      // in place for a retried deletion instead of leaking an orphan database.
      await (options.dropProjectWorkflowWorld ?? dropProjectWorkflowWorld)(process.env, job.projectId);

      const sourceRevisions = await store.listSourceRevisions(job.projectId);
      const pendingSourcePaths = Array.isArray(job.payload.sourcePaths)
        ? job.payload.sourcePaths.filter((sourcePath): sourcePath is string => typeof sourcePath === "string")
        : [];
      await removeManagedProjectFiles(
        options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data",
        job.projectId,
        [...sourceRevisions.map((revision) => revision.sourcePath), ...pendingSourcePaths],
        deployments.map((deployment) => deployment.containerName),
      );

      // Must be the last statement in this case, and nothing may follow it --
      // the Postgres store enforces FK integrity, so any write referencing
      // this project once its row is gone (a log line, a state update) would
      // throw. On any throw here -- before or during this call, since
      // deleteProject is not transactional -- the project row still exists,
      // because both stores delete the projects row last inside deleteProject;
      // that's what keeps processNextJob's generic failure path
      // (updateProjectState + appendLog against job.projectId) safe.
      await store.deleteProject(job.projectId);
      return;
    }
    case "ensure_deployment_running": {
      const deploymentId = typeof job.payload.deploymentId === "string" ? job.payload.deploymentId : null;
      const runtimeInstanceId = typeof job.payload.runtimeInstanceId === "string" ? job.payload.runtimeInstanceId : null;
      if (!deploymentId || !runtimeInstanceId) throw new Error("Deployment activation job is missing its target.");
      const deployment = await store.getDeployment(deploymentId);
      const runtimeInstance = await store.getRuntimeInstance(runtimeInstanceId);
      if (!deployment || deployment.projectId !== job.projectId) throw new Error("Deployment activation target is invalid.");
      if (!runtimeInstance || runtimeInstance.deploymentId !== deployment.id) throw new Error("RuntimeInstance activation target is invalid.");
      const release = await store.getRelease(deployment.releaseId);
      if (!release) throw new Error("Deployment activation Release is missing.");
      const revision = await store.getSourceRevision(release.sourceRevisionId);
      if (!revision) throw new Error("Deployment activation SourceRevision is missing.");
      const runtime = options.runtime ?? (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
      const { env } = await composeDeploymentEnv(store, job.projectId, options);
      const commandContext = await resolveRuntimeCommandContext(revision.sourcePath);
      const sandboxCache = resolveSandboxCacheDirs(process.env, job.projectId);
      const observerOutbox = resolveObserverOutboxDirs(process.env, job.projectId, deployment.id);
      await mkdir(sandboxCache.workerDir, { recursive: true });
      await mkdir(observerOutbox.workerDir, { recursive: true });
      await startRuntimeInstance(store, {
        deployment,
        runtime,
        startInput: {
          processName: deployment.containerName,
          releaseRef: release.imageTag,
          port: deployment.hostPort,
          env: { ...env, EVELAND_DEPLOYMENT_ID: deployment.id },
          commandContext,
          sandboxCacheDir: runtime.name === "docker" ? sandboxCache.hostDir : sandboxCache.workerDir,
          observerOutboxDir: runtime.name === "docker" ? observerOutbox.hostDir : observerOutbox.workerDir,
        },
      }, runtimeInstance.id, {
        waitForHealth: options.waitForDeployment,
        readyTimeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
      });
      await store.updateDeploymentStatus(deployment.id, "running");
      await store.appendLog({
        projectId: job.projectId,
        deploymentId: deployment.id,
        type: "runtime",
        line: `Deployment ${deployment.id} is ready for RuntimeInstance ${runtimeInstance.id}.`,
      });
      return;
    }
    case "trigger_schedule": {
      const scheduleRunId = typeof job.payload.scheduleRunId === "string" ? job.payload.scheduleRunId : null;
      let run = scheduleRunId ? await store.getScheduleRun(scheduleRunId) : null;
      let activationLeaseId: string | null = null;
      try {
        if (!scheduleRunId || !run) throw new Error("Schedule trigger is missing a valid ScheduleRun.");
        const schedule = await store.getProjectSchedule(run.scheduleId);
        const deployment = await store.getDeployment(run.deploymentId);
        const release = await store.getRelease(run.releaseId);
        if (!schedule || schedule.projectId !== job.projectId) throw new Error("ScheduleRun does not belong to this project.");
        if (!schedule.enabled) throw new Error("Schedule is disabled.");
        if (!deployment || deployment.projectId !== job.projectId || deployment.releaseId !== run.releaseId) {
          throw new Error("ScheduleRun Deployment provenance is invalid.");
        }
        if (!release || release.id !== deployment.releaseId) throw new Error("ScheduleRun Release provenance is invalid.");
        const versions = await store.listProjectScheduleVersions(job.projectId, release.sourceRevisionId);
        if (!versions.some((entry) => entry.version.id === run!.scheduleVersionId && entry.schedule.id === schedule.id)) {
          throw new Error("ScheduleRun version does not belong to its pinned Release.");
        }
        const claimedRun = await store.claimScheduleRunActivation(run.id);
        if (!claimedRun) {
          const current = await store.getScheduleRun(run.id);
          if (current && current.status !== "queued") {
            await store.appendLog({
              projectId: job.projectId,
              deploymentId: current.deploymentId,
              type: "runtime",
              line: `Duplicate ScheduleRun job ignored for ${current.id} in ${current.status}.`,
            });
            return;
          }
          throw new Error("ScheduleRun is not eligible for activation.");
        }
        run = claimedRun;
        const dispatchSecret = options.schedulerDispatchSecret ?? resolveSchedulerDispatchSecret(process.env);
        const runtimeSecret = options.schedulerRuntimeSecret ?? resolveSchedulerRuntimeSecret(process.env);
        if (!dispatchSecret || !runtimeSecret) throw new Error("Scheduler dispatch credentials are not configured.");
        const revision = await store.getSourceRevision(release.sourceRevisionId);
        if (!revision) throw new Error("ScheduleRun Release has no SourceRevision.");
        const runtime = options.runtime ?? (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
        const { env } = await composeDeploymentEnv(store, job.projectId, options);
        const commandContext = await resolveRuntimeCommandContext(revision.sourcePath);
        const sandboxCache = resolveSandboxCacheDirs(process.env, job.projectId);
        const observerOutbox = resolveObserverOutboxDirs(process.env, job.projectId, deployment.id);
        await mkdir(sandboxCache.workerDir, { recursive: true });
        await mkdir(observerOutbox.workerDir, { recursive: true });
        const activation = await ensureDeploymentActive(store, {
          deployment,
          runtime,
          kind: "schedule_run",
          ownerId: run.id,
          startInput: {
            processName: deployment.containerName,
            releaseRef: release.imageTag,
            port: deployment.hostPort,
            env: { ...env, EVELAND_DEPLOYMENT_ID: deployment.id },
            commandContext,
            sandboxCacheDir: runtime.name === "docker" ? sandboxCache.hostDir : sandboxCache.workerDir,
            observerOutboxDir: runtime.name === "docker" ? observerOutbox.hostDir : observerOutbox.workerDir,
          },
        }, {
          waitForHealth: options.waitForDeployment,
          readyTimeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
        });
        activationLeaseId = activation.lease.id;
        await store.updateDeploymentStatus(deployment.id, "running");
        const credential = createScheduleDispatchCredential({
          scheduleRunId: run.id,
          deploymentId: deployment.id,
          scheduleKey: schedule.key,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        }, dispatchSecret);
        const result = await (options.dispatchSchedule ?? dispatchScheduleToRuntime)({
          scheduleRunId: run.id,
          scheduleKey: schedule.key,
          deploymentId: deployment.id,
          hostPort: deployment.hostPort,
          credential,
          runtimeSecret,
        });
        const reported = await store.getScheduleRun(run.id);
        if (reported?.status === "dispatching") {
          await store.completeScheduleRun(run.id, { status: "succeeded", eveSessionIds: result.sessionIds });
        } else if (!reported || (reported.status !== "succeeded" && reported.status !== "failed")) {
          throw new Error("Scheduler Channel returned without a durable dispatch result.");
        }
        await store.appendLog({
          projectId: job.projectId,
          deploymentId: deployment.id,
          type: "runtime",
          line: `ScheduleRun ${run.id} dispatched for ${schedule.key}.`,
        });
      } catch (error) {
        const message = errorMessage(error);
        if (run) {
          const current = await store.getScheduleRun(run.id);
          if (current && !["succeeded", "failed", "dispatch_unknown", "skipped"].includes(current.status)) {
            await store.completeScheduleRun(run.id, {
              status: current.status === "dispatching" ? "dispatch_unknown" : "failed",
              error: message,
            });
          }
        }
        await store.appendLog({
          projectId: job.projectId,
          deploymentId: run?.deploymentId ?? null,
          type: "runtime",
          line: `ScheduleRun ${scheduleRunId ?? "unknown"} failed: ${message}`,
        });
      } finally {
        if (activationLeaseId) await store.releaseActivationLease(activationLeaseId);
      }
      return;
    }
  }
}

async function dispatchScheduleToRuntime(input: ScheduleDispatchInput): Promise<{ sessionIds: string[] }> {
  const response = await fetch(`http://127.0.0.1:${input.hostPort}/eveland/scheduler/${encodeURIComponent(input.scheduleRunId)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.credential}`,
      "content-type": "application/json",
      "x-eveland-runtime-secret": input.runtimeSecret,
    },
    body: JSON.stringify({ scheduleKey: input.scheduleKey }),
    signal: AbortSignal.timeout(Number(process.env.EVELAND_SCHEDULER_DISPATCH_TIMEOUT_MS ?? 120_000)),
  });
  if (!response.ok) throw new Error(`Scheduler Channel rejected dispatch with HTTP ${response.status}.`);
  const body = await response.json().catch(() => null) as { sessionIds?: unknown } | null;
  if (!body || !Array.isArray(body.sessionIds) || !body.sessionIds.every((value) => typeof value === "string")) {
    throw new Error("Scheduler Channel returned an invalid dispatch result.");
  }
  return { sessionIds: body.sessionIds };
}

async function removeManagedProjectFiles(
  dataDir: string,
  projectId: string,
  sourcePaths: string[],
  processNames: string[],
): Promise<void> {
  const root = path.resolve(dataDir);
  const safeProjectId = processSafeName(projectId);
  const ownedPaths = new Set([
    path.join(root, "sources", projectId),
    path.join(root, "builds", projectId),
    path.join(root, "observer", safeProjectId),
    path.join(root, "sandbox", safeProjectId),
  ]);
  const allowedSourceRoots = [path.join(root, "sources"), path.join(root, "uploads")];

  for (const processName of processNames) {
    ownedPaths.add(path.join(root, "deployment-env", `${processSafeName(processName)}.env`));
  }

  for (const sourcePath of sourcePaths) {
    const candidate = path.resolve(sourcePath);
    const allowedRoot = allowedSourceRoots.find((entry) => isStrictlyWithin(candidate, entry));
    if (!allowedRoot) continue;
    const relativeSegments = path.relative(allowedRoot, candidate).split(path.sep);
    const ownedCandidate =
      allowedRoot === allowedSourceRoots[1] && relativeSegments[0]?.startsWith("zip-")
        ? path.join(allowedRoot, relativeSegments[0])
        : candidate;
    const [realCandidate, realAllowedRoot] = await Promise.all([
      realpath(ownedCandidate).catch(() => null),
      realpath(allowedRoot).catch(() => null),
    ]);
    if (realCandidate && realAllowedRoot && isStrictlyWithin(realCandidate, realAllowedRoot)) {
      ownedPaths.add(ownedCandidate);
    }
  }

  await Promise.all([...ownedPaths].map((ownedPath) => rm(ownedPath, { recursive: true, force: true })));
}

function isStrictlyWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Shared by build_deploy and restart_deployment: stops a process that this job
// itself just started but that never became healthy. Cleanup failure is only
// ever logged, never thrown, so it can never mask the original deploy/restart
// error that triggered the cleanup.
async function stopStartedProcessOnFailure(
  store: Store,
  projectId: string,
  adapter: RuntimeAdapter,
  processName: string,
  phase: "deploy" | "restart",
  secretValues: string[],
): Promise<void> {
  if (adapter.getProcessDiagnostics) {
    try {
      const diagnostics = await adapter.getProcessDiagnostics(processName);
      const raw = [
        `Runtime startup diagnostics (${adapter.name}) before cleanup:`,
        `State: ${diagnostics.state.trim() || "unavailable"}`,
        `Recent logs:\n${diagnostics.logs.trim() || "(none captured)"}`,
      ].join("\n");
      await store.appendLog({
        projectId,
        type: "runtime",
        line: limitRuntimeDiagnostic(maskKnownSecrets(raw, secretValues)),
      });
    } catch (diagnosticError) {
      await store.appendLog({
        projectId,
        type: "runtime",
        line: maskKnownSecrets(
          `Runtime startup diagnostics (${adapter.name}) unavailable before cleanup: ${errorMessage(diagnosticError)}`,
          secretValues,
        ),
      });
    }
  }
  try {
    await adapter.stopProcess(processName);
  } catch (cleanupError) {
    await store.appendLog({
      projectId,
      type: "runtime",
      line: `Cleanup after failed ${phase} also failed: ${errorMessage(cleanupError)}`,
    });
  }
}

function limitRuntimeDiagnostic(input: string): string {
  if (input.length <= runtimeDiagnosticMaxCharacters) return input;
  const marker = "\n… runtime diagnostics truncated …\n";
  const prefixLength = 2_000;
  const suffixLength = runtimeDiagnosticMaxCharacters - prefixLength - marker.length;
  return `${input.slice(0, prefixLength)}${marker}${input.slice(-suffixLength)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Shared by build_deploy and restart_deployment. Durable-workflow gating is
// NOT part of this: build_deploy only calls this after deciding the deploy may
// proceed, and restart never re-gates an already-deployed release.
async function composeDeploymentEnv(
  store: Store,
  projectId: string,
  options: ProcessJobOptions,
): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const isProduction = nodeEnv === "production";
  const workflowPostgresUrl = options.workflowPostgresUrl ?? process.env.WORKFLOW_POSTGRES_URL;
  // Each project gets its own physical workflow database derived from the
  // platform base URL. A single shared database let any runtime claim any
  // project's queued turns and re-enqueue every project's active runs on
  // startup, so the database is created and bootstrapped here, before any
  // process starts with its URL.
  const ensureWorld = options.ensureProjectWorkflowWorld ?? ensureProjectWorkflowWorld;
  const projectWorkflowUrl = workflowPostgresUrl
    ? await ensureWorld({ ...process.env, WORKFLOW_POSTGRES_URL: workflowPostgresUrl }, projectId)
    : undefined;
  const schedulerRuntimeSecret = options.schedulerRuntimeSecret ?? resolveSchedulerRuntimeSecret(process.env);
  const schedulerRedeemUrl = options.schedulerRedeemUrl ?? process.env.EVELAND_SCHEDULER_REDEEM_URL;
  const secrets = await readRuntimeSecrets(store, projectId, options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey);
  // Project secrets are runtime input, but the workflow database is
  // platform-owned and bootstrapped before this worker accepts jobs. Keep its
  // URL reserved so a project cannot silently redirect the injected world to
  // an uninitialized or tenant-controlled database.
  const injectedCredentials = {
    ...secrets,
    ...(projectWorkflowUrl ? { WORKFLOW_POSTGRES_URL: projectWorkflowUrl } : {}),
    ...(schedulerRuntimeSecret ? { EVELAND_SCHEDULER_RUNTIME_SECRET: schedulerRuntimeSecret } : {}),
    ...(schedulerRedeemUrl ? { EVELAND_SCHEDULER_REDEEM_URL: schedulerRedeemUrl } : {}),
  };
  // NODE_ENV is platform-owned and injected only in production; kept out of the mask list so build logs aren't scrubbed of the word "production".
  const env = {
    ...injectedCredentials,
    ...(isProduction ? { NODE_ENV: "production" } : {}),
  };
  const secretValues = [
    ...Object.values(secrets),
    ...(workflowPostgresUrl ? [workflowPostgresUrl] : []),
    ...(projectWorkflowUrl ? [projectWorkflowUrl] : []),
    ...(schedulerRuntimeSecret ? [schedulerRuntimeSecret] : []),
  ];
  return { env, secretValues };
}

async function readRuntimeSecrets(store: Store, projectId: string, appSecretKey: string): Promise<Record<string, string>> {
  const records = await store.listSecretRecords(projectId);
  const values: Record<string, string> = {};

  for (const record of records) {
    values[record.key] = decryptSecretValue(parseEncryptedSecret(record.encryptedValue), appSecretKey);
  }

  return values;
}

function parseEncryptedSecret(value: string): EncryptedSecret {
  const parsed = JSON.parse(value) as Partial<EncryptedSecret>;
  if (parsed.algorithm !== "aes-256-gcm" || !parsed.iv || !parsed.authTag || !parsed.ciphertext) {
    throw new Error("Invalid encrypted secret payload.");
  }
  return parsed as EncryptedSecret;
}

type GitCredentialPayload = {
  userId: string;
  host: string;
  encryptedToken: string;
  persistAfterImport: boolean;
};

function readGitCredentialPayload(value: unknown): GitCredentialPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<GitCredentialPayload>;
  if (
    typeof candidate.userId !== "string" ||
    typeof candidate.host !== "string" ||
    typeof candidate.encryptedToken !== "string" ||
    typeof candidate.persistAfterImport !== "boolean"
  ) return null;
  return candidate as GitCredentialPayload;
}

async function resolveRuntimeCommandContext(sourcePath: string): Promise<RuntimeCommandContext> {
  const packageJson = await readPackageJson(sourcePath);
  const eveVersion = declaredEveVersion(packageJson);
  if (!isSupportedEveDependency(eveVersion)) {
    throw new Error(unsupportedEveVersionMessage(eveVersion));
  }
  const hasPnpmLockfile = await fileExists(path.join(sourcePath, "pnpm-lock.yaml"));
  const hasNpmLockfile = await fileExists(path.join(sourcePath, "package-lock.json"));
  return {
    isEveProject: true,
    ...(hasPnpmLockfile
      ? { hasLockfile: true as const, packageManager: "pnpm" as const }
      : { hasLockfile: hasNpmLockfile, packageManager: "npm" as const }),
    scripts: packageJson?.scripts ?? {},
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function declaredEveVersion(packageJson: PackageJson | null): string | null {
  const version = packageJson?.dependencies?.eve ?? packageJson?.devDependencies?.eve;
  return typeof version === "string" && version.trim().length > 0 ? version.trim() : null;
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function readPackageJson(sourcePath: string): Promise<PackageJson | null> {
  try {
    const raw = await readFile(path.join(sourcePath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as PackageJson;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function allocateAvailableHostPort(startPort = Number(process.env.EVELAND_DEPLOYMENT_PORT ?? 41000), endPort = startPort + 100): Promise<number> {
  for (let port = startPort; port <= endPort; port += 1) {
    if (await isTcpPortAvailable("127.0.0.1", port)) {
      return port;
    }
  }

  throw new Error(`No available deployment host port in range ${startPort}-${endPort}.`);
}

export function resolveObserverOutboxDirs(
  env: NodeJS.ProcessEnv,
  projectId: string,
  deploymentId: string,
): { workerDir: string; hostDir: string } {
  const dataDir = path.resolve(env.EVELAND_DATA_DIR ?? ".eveland-data");
  const hostDataDir = path.resolve(env.EVELAND_HOST_DATA_DIR ?? dataDir);
  const suffix = path.join("observer", processSafeName(projectId), processSafeName(deploymentId));
  return {
    workerDir: path.join(dataDir, suffix),
    hostDir: path.join(hostDataDir, suffix),
  };
}

/**
 * Maps the worker-visible durable sandbox cache to the path the host Docker
 * daemon resolves for bind mounts. A custom cache inside EVELAND_DATA_DIR is
 * mapped by relative suffix; a cache outside that root is assumed to already
 * be host-visible (the native-worker case).
 */
export function resolveSandboxCacheDirs(
  env: NodeJS.ProcessEnv,
  projectId: string,
): { workerDir: string; hostDir: string } {
  const dataDir = path.resolve(env.EVELAND_DATA_DIR ?? ".eveland-data");
  const hostDataDir = path.resolve(env.EVELAND_HOST_DATA_DIR ?? dataDir);
  const workerRoot = resolveSandboxCacheRoot(env);
  const relativeRoot = path.relative(dataDir, workerRoot);
  const outsideDataDir = relativeRoot === ".." || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot);
  const hostRoot = outsideDataDir ? workerRoot : path.resolve(hostDataDir, relativeRoot);
  return {
    workerDir: resolveProjectSandboxCacheDir(workerRoot, projectId),
    hostDir: resolveProjectSandboxCacheDir(hostRoot, projectId),
  };
}

export async function invalidateGatewayRouteCache(
  env: NodeJS.ProcessEnv,
  routes: Array<{ hostname: string }>,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const gatewayUrl = env.EVELAND_GATEWAY_INTERNAL_URL?.replace(/\/$/, "");
  const serviceToken = env.EVELAND_GATEWAY_SERVICE_TOKEN;
  if (!gatewayUrl || !serviceToken) return;
  for (const route of routes) {
    const response = await fetchImplementation(`${gatewayUrl}/internal/cache/invalidate`, {
      method: "POST",
      headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ hostname: route.hostname }),
    });
    if (!response.ok) throw new Error(`Gateway returned ${response.status} while invalidating ${route.hostname}.`);
  }
}

async function isTcpPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const cleanup = () => {
      server.removeAllListeners();
    };

    server.once("listening", () => {
      server.close((error) => {
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      });
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(port, host);
  });
}
