import { OBSERVER_RUNTIME_CONTRACT } from "@evelandhq/agent-observer";
import type { Job } from "@evelandhq/core/contracts";
import {
  assessDispatcherReadiness,
  resolveDispatcherHeartbeatTtlMs,
} from "@evelandhq/core/workflow-dispatch";
import { projectDiscoveryManifest } from "@evelandhq/core/discovery";
import { createId } from "@evelandhq/core/ids";
import { maskKnownSecrets } from "@evelandhq/core/server/secrets";
import type { Store } from "@evelandhq/db";
import { rm } from "node:fs/promises";
import path from "node:path";
import { waitForOwnedHttpHealth } from "../runtime/health.js";
import { createRuntimeAdapterFromEnv } from "../runtime/select.js";
import { processSafeName } from "../runtime/types.js";
import { resolveWorkflowWorldDeploymentUrl } from "@evelandhq/core/workflow-world-url";
import { resolveWorldClusterIdentity } from "@evelandhq/db/workflow-world-identity";
import {
  deriveWorkflowWorldAttestation,
  EVELAND_WORKFLOW_WORLD,
} from "../runtime/workflow-world.js";
import {
  createDeploymentStartInput,
  ensureDeploymentLaunchSandbox,
  materializeDeploymentLaunchContext,
  resolveDeploymentLaunchPrerequisites,
  type LaunchInputStore,
} from "./deployment-launch-context.js";
import {
  allocateAvailableHostPort,
  claimInFlightPort,
  composeBuildVariables,
  invalidateGatewayRouteCache,
  releaseInFlightPort,
  stopStartedProcessOnFailure,
} from "./process-support.js";
import type { ProcessJobOptions } from "./process-types.js";

// The narrow persistence port this handler actually needs: its own reads
// and writes plus the launch-context port it passes through.
type BuildDeployStore = LaunchInputStore &
  Pick<
    Store,
    | "getProject"
    | "getCurrentSourceRevision"
    | "getCurrentDeployment"
    | "updateProjectState"
    | "appendLog"
    | "recordScheduleVersions"
    | "listReservedDeploymentHostPorts"
    | "getWorkflowDispatcherRegistration"
    | "recordDeployment"
    | "setProjectSchedulerTarget"
    | "ensureDeploymentRoutes"
    | "promoteDeployment"
  >;

export async function handleBuildDeployJob(
  store: BuildDeployStore,
  job: Job<"build_deploy">,
  options: ProcessJobOptions,
): Promise<void> {
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
  const evelandWorkflowWorldUrl =
    options.evelandWorkflowWorldUrl ?? resolveWorkflowWorldDeploymentUrl(process.env);

  if (isProduction && !evelandWorkflowWorldUrl) {
    const detail =
      "No EVELAND_WORKFLOW_WORLD_URL is configured for the shared durable workflow world every new build uses.";
    await store.appendLog({
      projectId: job.projectId,
      type: "deploy",
      line: `Deploy blocked: ${detail}`,
    });
    throw new Error(detail);
  }

  // A shared build only makes sense while the external dispatcher can be
  // proven to be claiming; machine-readable readiness gates the deploy, never
  // a stdout token or systemd's "active".
  if (isProduction) {
    // The dispatcher must be claiming from the same World this deploy
    // injects — proven by the database's own cluster fingerprint, never by
    // comparing URLs, which fails open across unrelated servers.
    const expectedWorldIdentity =
      options.worldClusterIdentity ?? (await resolveWorldClusterIdentity(process.env));
    const readiness = assessDispatcherReadiness(await store.getWorkflowDispatcherRegistration(), {
      ttlMs: resolveDispatcherHeartbeatTtlMs(process.env),
      expectedWorldDatabaseIdentity: expectedWorldIdentity,
    });
    if (!readiness.ready) {
      await store.appendLog({
        projectId: job.projectId,
        type: "deploy",
        line: `Deploy blocked: ${readiness.reason}`,
      });
      throw new Error(readiness.reason);
    }
  }

  const runtime = options.runtime ?? createRuntimeAdapterFromEnv();
  const previousDeployment = await store.getCurrentDeployment(job.projectId);
  const releaseId = createId("rel");
  const deploymentId = createId("dep");
  const processName = `eveland-${processSafeName(project.id)}-${processSafeName(deploymentId)}`;
  const buildDir = path.join(
    process.env.EVELAND_DATA_DIR ?? ".eveland-data",
    "builds",
    project.id,
    releaseId,
  );
  const launchPrerequisites = await resolveDeploymentLaunchPrerequisites({
    store,
    workerEnv: process.env,
    projectId: project.id,
    deploymentId,
    runtimeKind: runtime.name,
    sourcePath: revision.sourcePath,
    options,
  });
  // A Release is immutable and an environment change only restarts live
  // Deployments onto the existing one, so a later variable change reaches the
  // compiled manifest no earlier than the next deploy.
  const buildVariables = await composeBuildVariables(
    store,
    project.id,
    // The same key composeDeploymentEnv just decrypted this deploy's runtime
    // environment with -- resolved once, above, from the injected worker env.
    launchPrerequisites.observability.appSecretKey,
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
    options.signal?.throwIfAborted();
    build = await runtime.buildRelease({
      projectId: project.id,
      releaseId,
      sourcePath: revision.sourcePath,
      buildDir,
      commandContext: launchPrerequisites.commandContext,
      buildVariables,
      ...(options.signal ? { signal: options.signal } : {}),
      // Every new Release unconditionally bakes in the shared workflow world;
      // the legacy per-project world and the rollout flag that selected it are
      // no longer build options.
      workflowWorld: EVELAND_WORKFLOW_WORLD,
    });
  } catch (error) {
    await rm(buildDir, { recursive: true, force: true });
    throw error;
  }
  if (build.log.trim()) {
    await store.appendLog({
      projectId: job.projectId,
      type: "build",
      line: maskKnownSecrets(build.log.trim(), launchPrerequisites.secretValues),
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
  // eve's own discovery manifest is the authority on what was actually
  // built; the import-time static scan stays as the pre-install preview.
  // Release-scoped (the same revision can be rebuilt with different
  // resolved dependencies) and persisted only below, with the release row,
  // so a failed start never leaves summary from a nonexistent release.
  const discoveryProjection = build.discovery
    ? projectDiscoveryManifest(build.discovery.manifest)
    : null;
  const releaseSummary = discoveryProjection
    ? {
        ...discoveryProjection,
        ...(build.discovery?.resolvedEveVersion
          ? { eveVersionResolved: build.discovery.resolvedEveVersion }
          : {}),
      }
    : null;
  if (build.discovery && !discoveryProjection) {
    await store.appendLog({
      projectId: job.projectId,
      type: "build",
      line: "WARNING: the release's eve discovery manifest was not recognized; recording the release without a build summary.",
    });
  }

  await ensureDeploymentLaunchSandbox(launchPrerequisites);
  const launchContext = await materializeDeploymentLaunchContext({
    store,
    releaseId,
    prerequisites: launchPrerequisites,
  });
  // A Deployment is an immutable previewable version. Never recycle a port
  // from the production target: old and new versions must be able to run
  // concurrently until an explicit promote/drain decision is made.
  // Allocated only now -- after the minutes-long build -- so the window in
  // which the port is invisible to the DB reserved set is seconds, and the
  // in-flight claim below covers even that for this worker process.
  const hostPort = options.allocateHostPort
    ? await options.allocateHostPort()
    : await allocateAvailableHostPort(
        undefined,
        undefined,
        new Set(await store.listReservedDeploymentHostPorts()),
      );
  claimInFlightPort(hostPort);
  // Only the process started by this job is its cleanup responsibility.
  let startedProcess: string | null = null;
  let deploymentRecorded = false;
  try {
    options.signal?.throwIfAborted();
    const started = await runtime.startProcess(
      createDeploymentStartInput({
        processName,
        releaseRef: build.releaseRef,
        port: hostPort,
        launchContext,
      }),
    );
    startedProcess = processName;
    await waitForOwnedHttpHealth({
      host: "127.0.0.1",
      port: hostPort,
      timeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
      processName,
      runtime,
      ...(options.waitForDeployment ? { waitForHealth: options.waitForDeployment } : {}),
    });

    options.signal?.throwIfAborted();
    const deployment = await store.recordDeployment({
      releaseId,
      deploymentId,
      projectId: job.projectId,
      sourceRevisionId: revision.id,
      imageTag: build.releaseRef,
      // The delivery contract is a property of this Worker's agent-observer,
      // embedded by prepareReleaseTree inside every adapter build.
      observerContract: OBSERVER_RUNTIME_CONTRACT,
      summary: releaseSummary,
      containerName: processName,
      internalPort: started.internalPort,
      hostPort,
      runtimeKind: runtime.name,
      // Attest what the build actually injected. A build result without an
      // injected world records the Release as unknown, which blocks its
      // launches rather than guessing a topology.
      ...(build.workflowWorld
        ? { workflowWorld: deriveWorkflowWorldAttestation(build.workflowWorld) }
        : {}),
    });
    deploymentRecorded = true;
    if (releaseSummary) {
      await store.appendLog({
        projectId: job.projectId,
        type: "build",
        line:
          `Recorded the release summary from eve's discovery manifest (v${discoveryProjection!.manifestVersion}` +
          (build.discovery?.resolvedEveVersion
            ? `, eve ${build.discovery.resolvedEveVersion}`
            : "") +
          ").",
      });
    }
    if (!previousDeployment && build.schedulerDefinitions?.length) {
      await store.setProjectSchedulerTarget(project.id, deployment.id);
    }
    const materializedRoutes = await store.ensureDeploymentRoutes(
      project.id,
      deployment.id,
      (process.env.EVELAND_AGENT_BASE_DOMAINS ?? "agent.localhost").split(",")[0]!.trim(),
    );
    if (job.payload.promoteAfterDeploy === true) {
      options.signal?.throwIfAborted();
      await store.promoteDeployment(project.id, deployment.id);
      await store.appendLog({
        projectId: project.id,
        deploymentId: deployment.id,
        type: "deploy",
        line: `Promoted deployment ${deployment.deploymentKey} to the stable route.`,
      });
    }
    await invalidateGatewayRouteCache(process.env, materializedRoutes).catch(async (error) => {
      await store.appendLog({
        projectId: project.id,
        deploymentId: deployment.id,
        type: "deploy",
        line: `Agent Gateway cache invalidation deferred to TTL: ${error instanceof Error ? error.message : String(error)}`,
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
        launchContext.secretValues,
      );
    }
    if (!deploymentRecorded) {
      const cleanupErrors: string[] = [];
      if (runtime.removeRelease) {
        try {
          await runtime.removeRelease(build.releaseRef);
        } catch (cleanupError) {
          cleanupErrors.push(
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          );
        }
      }
      try {
        await rm(buildDir, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        );
      }
      if (cleanupErrors.length > 0) {
        await store.appendLog({
          projectId: job.projectId,
          type: "deploy",
          line: maskKnownSecrets(
            `Cleanup after failed deploy also failed: ${cleanupErrors.join("; ")}`,
            launchContext.secretValues,
          ),
        });
      }
    }
    throw error;
  } finally {
    // Recorded: the DB reserved set covers the port from here. Failed: the
    // cleanup above stopped anything that bound it.
    releaseInFlightPort(hostPort);
  }
}
