import type { Job } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import {
  createScheduleDispatchCredential,
  resolveSchedulerDispatchSecret,
  resolveSchedulerRuntimeSecret,
} from "@eveland/core/server/scheduler-dispatch";
import {
  decryptSecretValue,
  maskKnownSecrets,
} from "@eveland/core/server/secrets";
import type { Store } from "@eveland/db";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  ensureDeploymentActive,
  startRuntimeInstance,
} from "../runtime/activation-manager.js";
import { waitForOwnedHttpHealth } from "../runtime/health.js";
import {
  createRuntimeAdapterForKind,
  createRuntimeAdapterFromEnv,
} from "../runtime/select.js";
import { processSafeName } from "../runtime/types.js";
import { dropProjectWorkflowWorld } from "../runtime/workflow-world-bootstrap.js";
import { PLATFORM_WORKFLOW_WORLD } from "../runtime/workflow-world.js";
import { getGitCommitSha, importGitSource } from "../source/importer.js";
import { scanEveSource } from "../source/scan.js";

import {
  allocateAvailableHostPort,
  composeDeploymentEnv,
  devSecretKey,
  dispatchScheduleToRuntime,
  errorMessage,
  invalidateGatewayRouteCache,
  parseEncryptedSecret,
  readGitCredentialPayload,
  removeManagedProjectFiles,
  resolveRuntimeCommandContext,
  resolveSandboxCacheDirs,
  stopStartedProcessOnFailure,
} from "./process-support.js";
import type { ProcessJobOptions } from "./process-types.js";
import { prepareDeploymentObservability } from "./process-observability.js";

export async function processRuntimeJob(
  store: Store,
  job: Job,
  options: ProcessJobOptions,
): Promise<void> {
  switch (job.type) {
    case "restart_deployment": {
      // Flip to "starting" and log immediately, before any of the loads below can
      // throw -- a restart that fails loudly still leaves a visible trail (the
      // generic failure path in processNextJob then overwrites this to "failed").
      await store.updateProjectState(job.projectId, {
        deploymentStatus: "starting",
      });
      await store.appendLog({
        projectId: job.projectId,
        type: "deploy",
        line: "Restart requested.",
      });

      const project = await store.getProject(job.projectId);
      if (!project) {
        throw new Error(`Project ${job.projectId} not found.`);
      }
      const requestedDeploymentId =
        typeof job.payload.deploymentId === "string"
          ? job.payload.deploymentId
          : null;
      const deployment = requestedDeploymentId
        ? await store.getDeployment(requestedDeploymentId)
        : await store.getCurrentDeployment(job.projectId);
      if (!deployment) {
        throw new Error(
          requestedDeploymentId
            ? `Deployment ${requestedDeploymentId} not found.`
            : "No deployment to restart.",
        );
      }
      if (deployment.projectId !== job.projectId) {
        throw new Error(
          `Deployment ${deployment.id} does not belong to project ${job.projectId}.`,
        );
      }
      // A deployment always points at a release and a source revision; either
      // being gone is corrupt state, not a recoverable condition -- fail loudly
      // rather than restart with guessed values.
      const release = await store.getRelease(deployment.releaseId);
      if (!release) {
        throw new Error(
          `Release ${deployment.releaseId} not found for deployment ${deployment.id}.`,
        );
      }
      const revision = await store.getSourceRevision(release.sourceRevisionId);
      if (!revision) {
        throw new Error(
          `Source revision ${release.sourceRevisionId} not found for release ${release.id}.`,
        );
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
      const adapter =
        options.runtime ??
        (options.runtimeForKind ?? createRuntimeAdapterForKind)(
          deployment.runtimeKind,
        );
      const { env, secretValues } = await composeDeploymentEnv(
        store,
        project.id,
        deployment.id,
        options,
      );
      const commandContext = await resolveRuntimeCommandContext(
        revision.sourcePath,
      );

      await adapter.stopProcess(deployment.containerName);
      // Same worker/Docker-host path pairing build_deploy uses.
      const sandboxCache = resolveSandboxCacheDirs(process.env, project.id);
      await mkdir(sandboxCache.workerDir, { recursive: true });
      const observability = await prepareDeploymentObservability({
        store,
        env: process.env,
        projectId: project.id,
        releaseId: release.id,
        deploymentId: deployment.id,
        runtimeKind: adapter.name,
        nodeEnv: options.nodeEnv ?? process.env.NODE_ENV,
      });
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
          sandboxCacheDir:
            adapter.name === "docker"
              ? sandboxCache.hostDir
              : sandboxCache.workerDir,
          observabilityPolicyDir:
            adapter.name === "docker"
              ? observability.hostDir
              : observability.workerDir,
        });
        restarted = true;
        await waitForOwnedHttpHealth({
          host: "127.0.0.1",
          port: deployment.hostPort,
          timeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
          processName: deployment.containerName,
          runtime: adapter,
          ...(options.waitForDeployment ? { waitForHealth: options.waitForDeployment } : {}),
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
      await store.updateProjectState(job.projectId, {
        deploymentStatus: "running",
      });
      await store.appendLog({
        projectId: job.projectId,
        deploymentId: deployment.id,
        type: "deploy",
        line: `Deployment running on 127.0.0.1:${deployment.hostPort}.`,
      });
      return;
    }
    case "archive_deployment": {
      const deploymentId =
        typeof job.payload.deploymentId === "string"
          ? job.payload.deploymentId
          : null;
      if (!deploymentId) throw new Error("Archive job missing deploymentId.");
      const deployment = await store.getDeployment(deploymentId);
      if (!deployment || deployment.projectId !== job.projectId)
        throw new Error("Deployment not found for archive.");
      if (
        job.payload.automatic === true &&
        deployment.status !== "stopped"
      ) {
        return;
      }
      const configuredRetention = Number(
        process.env.EVELAND_RELEASE_RETENTION ?? 3,
      );
      const retention = await store.getDeploymentRetention(
        job.projectId,
        Number.isFinite(configuredRetention)
          ? Math.max(3, Math.floor(configuredRetention))
          : 3,
        {
          playgroundIdleTtlMs: Number(
            process.env.EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS ?? 86_400_000,
          ),
          apiIdleTtlMs: Number(
            process.env.EVELAND_API_SESSION_IDLE_TTL_MS ?? 604_800_000,
          ),
        },
      );
      const policy = retention.find(
        (entry) => entry.deployment.id === deployment.id,
      );
      if (!policy || policy.protected) {
        throw new Error(
          `Deployment is protected from archive${policy?.reasons.length ? `: ${policy.reasons.join(", ")}` : "."}`,
        );
      }
      const adapter =
        options.runtime?.name === deployment.runtimeKind
          ? options.runtime
          : (options.runtimeForKind ?? createRuntimeAdapterForKind)(
              deployment.runtimeKind,
            );
      if (deployment.status === "running" || deployment.status === "draining")
        await adapter.stopProcess(deployment.containerName);
      const release = await store.getRelease(deployment.releaseId);
      if (release && adapter.removeRelease)
        await adapter.removeRelease(release.imageTag);
      await rm(
        path.join(
          options.dataDir ??
            process.env.EVELAND_DATA_DIR ??
            ".eveland-data",
          "builds",
          job.projectId,
          deployment.releaseId,
        ),
        { recursive: true, force: true },
      );
      await store.updateDeploymentStatus(deployment.id, "archived");
      await store.appendLog({
        projectId: job.projectId,
        deploymentId,
        type: "deploy",
        line:
          job.payload.automatic === true
            ? `Deployment ${deployment.deploymentKey} automatically archived by retention policy.`
            : `Deployment ${deployment.deploymentKey} archived.`,
      });
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
        (deployment) =>
          deployment.status === "running" || deployment.status === "draining",
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
              : (options.runtimeForKind ?? createRuntimeAdapterForKind)(
                  deployment.runtimeKind,
                );
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
            : (options.runtimeForKind ?? createRuntimeAdapterForKind)(
                deployment.runtimeKind,
              );
        if (release && adapter.removeRelease)
          await adapter.removeRelease(release.imageTag);
        removedReleases.add(releaseKey);
      }

      // The project's derived workflow database goes with the project.
      // Dropped before deleteProject so a failed drop leaves the project row
      // in place for a retried deletion instead of leaking an orphan database.
      await (options.dropProjectWorkflowWorld ?? dropProjectWorkflowWorld)(
        process.env,
        job.projectId,
      );

      const sourceRevisions = await store.listSourceRevisions(job.projectId);
      const pendingSourcePaths = Array.isArray(job.payload.sourcePaths)
        ? job.payload.sourcePaths.filter(
            (sourcePath): sourcePath is string =>
              typeof sourcePath === "string",
          )
        : [];
      await removeManagedProjectFiles(
        options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data",
        job.projectId,
        [
          ...sourceRevisions.map((revision) => revision.sourcePath),
          ...pendingSourcePaths,
        ],
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
      const deploymentId =
        typeof job.payload.deploymentId === "string"
          ? job.payload.deploymentId
          : null;
      const runtimeInstanceId =
        typeof job.payload.runtimeInstanceId === "string"
          ? job.payload.runtimeInstanceId
          : null;
      if (!deploymentId || !runtimeInstanceId)
        throw new Error("Deployment activation job is missing its target.");
      const deployment = await store.getDeployment(deploymentId);
      const runtimeInstance = await store.getRuntimeInstance(runtimeInstanceId);
      if (!deployment || deployment.projectId !== job.projectId)
        throw new Error("Deployment activation target is invalid.");
      if (!runtimeInstance || runtimeInstance.deploymentId !== deployment.id)
        throw new Error("RuntimeInstance activation target is invalid.");
      const release = await store.getRelease(deployment.releaseId);
      if (!release)
        throw new Error("Deployment activation Release is missing.");
      const revision = await store.getSourceRevision(release.sourceRevisionId);
      if (!revision)
        throw new Error("Deployment activation SourceRevision is missing.");
      let persistedSourceFiles: Awaited<
        ReturnType<Store["listSourceRevisionFiles"]>
      > = [];
      try {
        await access(revision.sourcePath);
      } catch {
        persistedSourceFiles = await store.listSourceRevisionFiles(revision.id);
        if (!persistedSourceFiles.some((file) => file.path === "package.json")) {
          throw new Error(
            `Source directory for revision ${revision.id} is missing: ${revision.sourcePath}. Re-import the source and deploy instead.`,
          );
        }
      }
      const runtime =
        options.runtime ??
        (options.runtimeForKind ?? createRuntimeAdapterForKind)(
          deployment.runtimeKind,
        );
      const { env } = await composeDeploymentEnv(
        store,
        job.projectId,
        deployment.id,
        options,
      );
      const commandContext = await resolveRuntimeCommandContext(
        revision.sourcePath,
        persistedSourceFiles,
      );
      const sandboxCache = resolveSandboxCacheDirs(process.env, job.projectId);
      await mkdir(sandboxCache.workerDir, { recursive: true });
      const observability = await prepareDeploymentObservability({
        store,
        env: process.env,
        projectId: job.projectId,
        releaseId: release.id,
        deploymentId: deployment.id,
        runtimeKind: runtime.name,
        nodeEnv: options.nodeEnv ?? process.env.NODE_ENV,
      });
      await startRuntimeInstance(
        store,
        {
          deployment,
          runtime,
          startInput: {
            processName: deployment.containerName,
            releaseRef: release.imageTag,
            port: deployment.hostPort,
            env: { ...env, EVELAND_DEPLOYMENT_ID: deployment.id },
            commandContext,
            sandboxCacheDir:
              runtime.name === "docker"
                ? sandboxCache.hostDir
                : sandboxCache.workerDir,
            observabilityPolicyDir:
              runtime.name === "docker"
                ? observability.hostDir
                : observability.workerDir,
          },
        },
        runtimeInstance.id,
        {
          waitForHealth: options.waitForDeployment,
          readyTimeoutMs: Number(
            process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000,
          ),
        },
      );
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
      const scheduleRunId =
        typeof job.payload.scheduleRunId === "string"
          ? job.payload.scheduleRunId
          : null;
      let run = scheduleRunId
        ? await store.getScheduleRun(scheduleRunId)
        : null;
      let activationLeaseId: string | null = null;
      let activationLeaseHandedOff = false;
      const startedAtMs = Date.now();
      let failurePhase = "ScheduleRun validation";
      try {
        if (!scheduleRunId || !run)
          throw new Error("Schedule trigger is missing a valid ScheduleRun.");
        const schedule = await store.getProjectSchedule(run.scheduleId);
        const deployment = await store.getDeployment(run.deploymentId);
        const release = await store.getRelease(run.releaseId);
        if (!schedule || schedule.projectId !== job.projectId)
          throw new Error("ScheduleRun does not belong to this project.");
        if (!schedule.enabled) throw new Error("Schedule is disabled.");
        if (
          !deployment ||
          deployment.projectId !== job.projectId ||
          deployment.releaseId !== run.releaseId
        ) {
          throw new Error("ScheduleRun Deployment provenance is invalid.");
        }
        if (!release || release.id !== deployment.releaseId)
          throw new Error("ScheduleRun Release provenance is invalid.");
        const versions = await store.listProjectScheduleVersions(
          job.projectId,
          release.sourceRevisionId,
        );
        if (
          !versions.some(
            (entry) =>
              entry.version.id === run!.scheduleVersionId &&
              entry.schedule.id === schedule.id,
          )
        ) {
          throw new Error(
            "ScheduleRun version does not belong to its pinned Release.",
          );
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
        const dispatchSecret =
          options.schedulerDispatchSecret ??
          resolveSchedulerDispatchSecret(process.env);
        const runtimeSecret =
          options.schedulerRuntimeSecret ??
          resolveSchedulerRuntimeSecret(process.env);
        if (!dispatchSecret || !runtimeSecret)
          throw new Error("Scheduler dispatch credentials are not configured.");
        const revision = await store.getSourceRevision(
          release.sourceRevisionId,
        );
        if (!revision)
          throw new Error("ScheduleRun Release has no SourceRevision.");
        const runtime =
          options.runtime ??
          (options.runtimeForKind ?? createRuntimeAdapterForKind)(
            deployment.runtimeKind,
          );
        const { env } = await composeDeploymentEnv(
          store,
          job.projectId,
          deployment.id,
          options,
        );
        const commandContext = await resolveRuntimeCommandContext(
          revision.sourcePath,
        );
        const sandboxCache = resolveSandboxCacheDirs(
          process.env,
          job.projectId,
        );
        await mkdir(sandboxCache.workerDir, { recursive: true });
        const maxRuntimeMs = scheduleRunMaxRuntimeMs(options);
        failurePhase = "Deployment activation";
        await store.appendLog({
          projectId: job.projectId,
          deploymentId: deployment.id,
          type: "runtime",
          line: `ScheduleRun ${run.id} activating ${schedule.key} on Deployment ${deployment.id} (Release ${release.id}, runtime=${deployment.runtimeKind}).`,
        });
        const observability = await prepareDeploymentObservability({
          store,
          env: process.env,
          projectId: job.projectId,
          releaseId: release.id,
          deploymentId: deployment.id,
          runtimeKind: runtime.name,
          nodeEnv: options.nodeEnv ?? process.env.NODE_ENV,
        });
        const activation = await ensureDeploymentActive(
          store,
          {
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
              sandboxCacheDir:
                runtime.name === "docker"
                  ? sandboxCache.hostDir
                  : sandboxCache.workerDir,
              observabilityPolicyDir:
                runtime.name === "docker"
                  ? observability.hostDir
                  : observability.workerDir,
            },
          },
          {
            waitForHealth: options.waitForDeployment,
            readyTimeoutMs: Number(
              process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000,
            ),
            leaseTtlMs: maxRuntimeMs,
          },
        );
        activationLeaseId = activation.lease.id;
        await store.updateDeploymentStatus(deployment.id, "running");
        failurePhase = "Scheduler Channel dispatch";
        await store.appendLog({
          projectId: job.projectId,
          deploymentId: deployment.id,
          type: "runtime",
          line: `ScheduleRun ${run.id} dispatching ${schedule.key} to the Scheduler Channel on Deployment ${deployment.id}.`,
        });
        const credential = createScheduleDispatchCredential(
          {
            scheduleRunId: run.id,
            deploymentId: deployment.id,
            scheduleKey: schedule.key,
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          },
          dispatchSecret,
        );
        const result = await (
          options.dispatchSchedule ?? dispatchScheduleToRuntime
        )({
          scheduleRunId: run.id,
          scheduleKey: schedule.key,
          deploymentId: deployment.id,
          hostPort: deployment.hostPort,
          credential,
          runtimeSecret,
        });
        let reported = await store.getScheduleRun(run.id);
        if (reported?.status === "dispatching") {
          reported = await store.completeScheduleRun(run.id, {
            status: "succeeded",
            eveSessionIds: result.sessionIds,
          });
        } else if (
          !reported ||
          !["running", "succeeded", "failed"].includes(reported.status)
        ) {
          throw new Error(
            "Scheduler Channel returned without a durable dispatch result.",
          );
        }
        if (reported?.status === "running") {
          const renewed = await store.renewActivationLease(
            activationLeaseId,
            new Date(Date.now() + maxRuntimeMs),
          );
          if (!renewed)
            throw new Error("ScheduleRun activation lease could not be extended.");
          activationLeaseHandedOff = true;
        }
        await store.appendLog({
          projectId: job.projectId,
          deploymentId: deployment.id,
          type: "runtime",
          line: `ScheduleRun ${run.id} ${activationLeaseHandedOff ? "started" : "succeeded for"} ${schedule.key} with ${result.sessionIds.length} ${result.sessionIds.length === 1 ? "Session" : "Sessions"} after ${Date.now() - startedAtMs}ms.`,
        });
      } catch (error) {
        const rawMessage = errorMessage(error);
        const message = `${failurePhase} failed: ${rawMessage}`;
        let durableExecutionContinues = false;
        if (run) {
          const current = await store.getScheduleRun(run.id);
          if (
            current?.status === "running" &&
            activationLeaseId
          ) {
            const renewed = await store.renewActivationLease(
              activationLeaseId,
              new Date(Date.now() + scheduleRunMaxRuntimeMs(options)),
            );
            if (renewed) {
              activationLeaseHandedOff = true;
              durableExecutionContinues = true;
            }
          } else if (
            current &&
            !["succeeded", "failed", "dispatch_unknown", "skipped"].includes(
              current.status,
            )
          ) {
            await store.completeScheduleRun(run.id, {
              status:
                current.status === "dispatching"
                  ? "dispatch_unknown"
                  : "failed",
              error: message,
            });
          }
        }
        await store.appendLog({
          projectId: job.projectId,
          deploymentId: run?.deploymentId ?? null,
          type: "runtime",
          line: durableExecutionContinues
            ? `ScheduleRun ${scheduleRunId ?? "unknown"} continued after its durable Session result was recorded but the Scheduler Channel response failed after ${Date.now() - startedAtMs}ms: ${rawMessage}`
            : `ScheduleRun ${scheduleRunId ?? "unknown"} failed during ${failurePhase} after ${Date.now() - startedAtMs}ms: ${rawMessage}`,
        });
      } finally {
        if (activationLeaseId && !activationLeaseHandedOff)
          await store.releaseActivationLease(activationLeaseId);
      }
      return;
    }
    default:
      throw new Error(`Unsupported runtime job type: ${job.type}`);
  }
}

function scheduleRunMaxRuntimeMs(options: ProcessJobOptions): number {
  const value =
    options.scheduleRunMaxRuntimeMs ??
    Number(process.env.EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS ?? 86_400_000);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      "EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS must be a positive integer.",
    );
  }
  return value;
}
