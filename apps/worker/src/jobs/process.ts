import type { Job } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import { decryptSecretValue, maskKnownSecrets, type EncryptedSecret } from "@eveland/core/server/secrets";
import type { Store } from "@eveland/db";
import net from "node:net";
import { access, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { waitForHttpHealth } from "../runtime/health.js";
import { createRuntimeAdapterForKind, createRuntimeAdapterFromEnv } from "../runtime/select.js";
import { resolveProjectSandboxCacheDir, resolveSandboxCacheRoot } from "../runtime/systemd.js";
import { processSafeName, type RuntimeAdapter, type RuntimeCommandContext } from "../runtime/types.js";
import { PLATFORM_WORKFLOW_WORLD } from "../runtime/workflow-world.js";
import { importGitSource, getGitCommitSha } from "../source/importer.js";
import { scanEveSource } from "../source/scan.js";

const devSecretKey = "eveland-dev-secret-key-000000000";

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
  nodeEnv?: string;
  dataDir?: string;
};

export async function processNextJob(store: Store, workerId: string, options: ProcessJobOptions = {}): Promise<boolean> {
  const job = await store.claimNextJob(workerId);
  if (!job) {
    return false;
  }

  try {
    await processJob(store, job, options);
    await store.completeJob(job.id);
    return true;
  } catch (error) {
    const message = errorMessage(error);
    await store.failJob(job.id, message);
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

async function processJob(store: Store, job: Job, options: ProcessJobOptions): Promise<void> {
  switch (job.type) {
    case "import_source": {
      const project = await store.getProject(job.projectId);
      if (!project) {
        throw new Error(`Project ${job.projectId} not found.`);
      }

      const sourcePathFromPayload = typeof job.payload.sourcePath === "string" ? job.payload.sourcePath : null;
      let sourcePath = sourcePathFromPayload;
      let commitSha: string | null = null;

      if (!sourcePath && project.importKind === "git") {
        const gitUrl = typeof job.payload.gitUrl === "string" ? job.payload.gitUrl : project.gitUrl;
        if (!gitUrl) {
          throw new Error("Git import missing gitUrl.");
        }
        sourcePath = path.join(process.env.EVELAND_DATA_DIR ?? ".eveland-data", "sources", job.projectId, job.id);
        await importGitSource({ gitUrl, targetDir: sourcePath });
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
          await stopStartedProcessOnFailure(store, job.projectId, runtime, startedProcess, "deploy");
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
      const { env } = await composeDeploymentEnv(store, project.id, options);
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
          await stopStartedProcessOnFailure(store, job.projectId, adapter, deployment.containerName, "restart");
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
    case "trigger_schedule": {
      await store.appendLog({
        projectId: job.projectId,
        type: "runtime",
        line: `Schedule trigger accepted: ${String(job.payload.scheduleId ?? "unknown")}`,
      });
      return;
    }
  }
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
): Promise<void> {
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
  const secrets = await readRuntimeSecrets(store, projectId, options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey);
  // Project secrets are runtime input, but the workflow database is
  // platform-owned and bootstrapped before this worker accepts jobs. Keep its
  // URL reserved so a project cannot silently redirect the injected world to
  // an uninitialized or tenant-controlled database.
  const injectedCredentials = {
    ...secrets,
    ...(workflowPostgresUrl ? { WORKFLOW_POSTGRES_URL: workflowPostgresUrl } : {}),
  };
  // NODE_ENV is platform-owned and injected only in production; kept out of the mask list so build logs aren't scrubbed of the word "production".
  const env = {
    ...injectedCredentials,
    ...(isProduction ? { NODE_ENV: "production" } : {}),
  };
  const secretValues = [...Object.values(secrets), ...(workflowPostgresUrl ? [workflowPostgresUrl] : [])];
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

async function resolveRuntimeCommandContext(sourcePath: string): Promise<RuntimeCommandContext> {
  const packageJson = await readPackageJson(sourcePath);
  return {
    isEveProject: isEveProject(packageJson),
    hasLockfile: await fileExists(path.join(sourcePath, "package-lock.json")),
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

function isEveProject(packageJson: PackageJson | null): boolean {
  return typeof packageJson?.dependencies?.eve === "string" || typeof packageJson?.devDependencies?.eve === "string";
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
