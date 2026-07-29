import type { Job } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import {
  decryptSecretValue,
  maskKnownSecrets,
} from "@eveland/core/server/secrets";
import type { Store } from "@eveland/db";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { waitForOwnedHttpHealth } from "../runtime/health.js";
import { createRuntimeAdapterFromEnv } from "../runtime/select.js";
import { processSafeName } from "../runtime/types.js";
import { PLATFORM_WORKFLOW_WORLD } from "../runtime/workflow-world.js";
import { getGitCommitSha, importGitSource } from "../source/importer.js";
import { scanEveSource } from "../source/scan.js";

import { processRuntimeJob } from "./process-runtime-job.js";
import { prepareDeploymentObservability } from "./process-observability.js";
import {
  allocateAvailableHostPort,
  composeDeploymentEnv,
  devSecretKey,
  invalidateGatewayRouteCache,
  parseEncryptedSecret,
  readGitCredentialPayload,
  resolveRuntimeCommandContext,
  resolveSandboxCacheDirs,
  stopStartedProcessOnFailure,
} from "./process-support.js";
import type { ProcessJobOptions } from "./process-types.js";

export async function processJob(
  store: Store,
  job: Job,
  options: ProcessJobOptions,
): Promise<void> {
  switch (job.type) {
    case "import_source": {
      const project = await store.getProject(job.projectId);
      if (!project) {
        throw new Error(`Project ${job.projectId} not found.`);
      }

      const sourcePathFromPayload =
        typeof job.payload.sourcePath === "string"
          ? job.payload.sourcePath
          : null;
      const gitCredential = readGitCredentialPayload(job.payload.gitCredential);
      let sourcePath = sourcePathFromPayload;
      let commitSha: string | null = null;

      if (!sourcePath && project.importKind === "git") {
        const gitUrl =
          typeof job.payload.gitUrl === "string"
            ? job.payload.gitUrl
            : project.gitUrl;
        if (!gitUrl) {
          throw new Error("Git import missing gitUrl.");
        }
        sourcePath = path.join(
          process.env.EVELAND_DATA_DIR ?? ".eveland-data",
          "sources",
          job.projectId,
          job.id,
        );
        await importGitSource({
          gitUrl,
          targetDir: sourcePath,
          ...(gitCredential
            ? {
                credential: {
                  host: gitCredential.host,
                  token: decryptSecretValue(
                    parseEncryptedSecret(gitCredential.encryptedToken),
                    options.appSecretKey ??
                      process.env.APP_SECRET_KEY ??
                      devSecretKey,
                  ),
                },
              }
            : {}),
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
        await store.upsertGitCredential(
          gitCredential.userId,
          gitCredential.host,
          gitCredential.encryptedToken,
        );
      }
      await store.appendLog({
        projectId: job.projectId,
        type: "build",
        line: `Source import completed for ${project.name}.`,
      });

      // A re-sync can opt into deploying the freshly imported source in one step;
      // enqueued only after a successful import so a failed pull never deploys.
      if (job.payload.deployAfterImport === true) {
        await store.enqueueJob(job.projectId, "build_deploy", {
          promoteAfterDeploy: job.payload.promoteAfterDeploy === true,
        });
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
        throw new Error(
          `Project ${job.projectId} has no source revision to deploy.`,
        );
      }

      const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
      const isProduction = nodeEnv === "production";
      const workflowPostgresUrl =
        options.workflowPostgresUrl ?? process.env.WORKFLOW_POSTGRES_URL;

      if (isProduction && !workflowPostgresUrl) {
        const detail =
          "No WORKFLOW_POSTGRES_URL is configured for the platform-owned durable workflow world.";
        await store.appendLog({
          projectId: job.projectId,
          type: "deploy",
          line: `Deploy blocked: ${detail}`,
        });
        throw new Error(detail);
      }

      const runtime = options.runtime ?? createRuntimeAdapterFromEnv();
      const previousDeployment = await store.getCurrentDeployment(
        job.projectId,
      );
      const releaseId = createId("rel");
      const deploymentId = createId("dep");
      const processName = `eveland-${processSafeName(project.id)}-${processSafeName(deploymentId)}`;
      const buildDir = path.join(
        process.env.EVELAND_DATA_DIR ?? ".eveland-data",
        "builds",
        project.id,
        releaseId,
      );
      // A Deployment is an immutable previewable version. Never recycle a port
      // from the production target: old and new versions must be able to run
      // concurrently until an explicit promote/drain decision is made.
      const hostPort = options.allocateHostPort
        ? await options.allocateHostPort()
        : await allocateAvailableHostPort(
            undefined,
            undefined,
            new Set(await store.listReservedDeploymentHostPorts()),
          );
      const { env, secretValues } = await composeDeploymentEnv(
        store,
        project.id,
        deploymentId,
        options,
      );
      const commandContext = await resolveRuntimeCommandContext(
        revision.sourcePath,
      );

      await store.updateProjectState(job.projectId, {
        status: "build_pending",
        deploymentStatus: "building",
      });
      await store.appendLog({
        projectId: job.projectId,
        type: "build",
        line: `Building release ${releaseId} from ${revision.sourcePath}.`,
      });

      let build;
      try {
        build = await runtime.buildRelease({
          projectId: project.id,
          releaseId,
          sourcePath: revision.sourcePath,
          buildDir,
          commandContext,
          ...(workflowPostgresUrl && commandContext.isEveProject
            ? { workflowWorld: PLATFORM_WORKFLOW_WORLD }
            : {}),
        });
      } catch (error) {
        await rm(buildDir, { recursive: true, force: true });
        throw error;
      }
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
          definitions: build.schedulerDefinitions.map(
            ({ key, kind, cron, sourcePath, definitionHash }) => ({
              key,
              kind,
              cron,
              sourcePath,
              definitionHash,
            }),
          ),
        });
      }

      const sandboxCache = resolveSandboxCacheDirs(process.env, project.id);
      await mkdir(sandboxCache.workerDir, { recursive: true });
      const observability = await prepareDeploymentObservability({
        store,
        env: process.env,
        projectId: project.id,
        releaseId,
        deploymentId,
        runtimeKind: runtime.name,
        nodeEnv: options.nodeEnv ?? process.env.NODE_ENV,
      });
      // Only the process started by this job is its cleanup responsibility.
      let startedProcess: string | null = null;
      let deploymentRecorded = false;
      try {
        const started = await runtime.startProcess({
          processName,
          releaseRef: build.releaseRef,
          port: hostPort,
          env: { ...env, EVELAND_DEPLOYMENT_ID: deploymentId },
          commandContext,
          sandboxCacheDir:
            runtime.name === "docker"
              ? sandboxCache.hostDir
              : sandboxCache.workerDir,
          observabilityPolicyDir:
            runtime.name === "docker"
              ? observability.hostDir
              : observability.workerDir,
        });
        startedProcess = processName;
        await waitForOwnedHttpHealth({
          host: "127.0.0.1",
          port: hostPort,
          timeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
          processName,
          runtime,
          ...(options.waitForDeployment ? { waitForHealth: options.waitForDeployment } : {}),
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
        deploymentRecorded = true;
        if (!previousDeployment && build.schedulerDefinitions?.length) {
          await store.setProjectSchedulerTarget(project.id, deployment.id);
        }
        const materializedRoutes = await store.ensureDeploymentRoutes(
          project.id,
          deployment.id,
          (process.env.EVELAND_AGENT_BASE_DOMAINS ?? "agent.localhost")
            .split(",")[0]!
            .trim(),
        );
        if (job.payload.promoteAfterDeploy === true) {
          await store.promoteDeployment(
            project.id,
            deployment.id,
          );
          await store.appendLog({
            projectId: project.id,
            deploymentId: deployment.id,
            type: "deploy",
            line: `Promoted deployment ${deployment.deploymentKey} to the stable route.`,
          });
        }
        await invalidateGatewayRouteCache(
          process.env,
          materializedRoutes,
        ).catch(async (error) => {
          await store.appendLog({
            projectId: project.id,
            deploymentId: deployment.id,
            type: "deploy",
            line: `Gateway cache invalidation deferred to TTL: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
        await store.updateProjectState(job.projectId, {
          status: "deployed",
          deploymentStatus: "running",
        });
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
          await stopStartedProcessOnFailure(
            store,
            job.projectId,
            runtime,
            startedProcess,
            "deploy",
            secretValues,
          );
        }
        if (!deploymentRecorded) {
          const cleanupErrors: string[] = [];
          if (runtime.removeRelease) {
            try {
              await runtime.removeRelease(build.releaseRef);
            } catch (cleanupError) {
              cleanupErrors.push(
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
              );
            }
          }
          try {
            await rm(buildDir, { recursive: true, force: true });
          } catch (cleanupError) {
            cleanupErrors.push(
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
            );
          }
          if (cleanupErrors.length > 0) {
            await store.appendLog({
              projectId: job.projectId,
              type: "deploy",
              line: maskKnownSecrets(
                `Cleanup after failed deploy also failed: ${cleanupErrors.join("; ")}`,
                secretValues,
              ),
            });
          }
        }
        throw error;
      }
      return;
    }
    default:
      return processRuntimeJob(store, job, options);
  }
}
