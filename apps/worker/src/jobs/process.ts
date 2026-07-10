import type { Store } from "@eveland/api/store";
import type { Job } from "@eveland/api/types";
import { createId } from "@eveland/shared/ids";
import { decryptSecretValue, maskKnownSecrets, type EncryptedSecret } from "@eveland/shared/secrets";
import { DURABLE_WORKFLOW_WORLD, isDurableWorkflowWorld } from "@eveland/shared/source";
import net from "node:net";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { waitForHttpHealth } from "../runtime/health.js";
import { createRuntimeAdapterForKind, createRuntimeAdapterFromEnv } from "../runtime/select.js";
import { resolveProjectSandboxCacheDir, resolveSandboxCacheRoot } from "../runtime/systemd.js";
import { processSafeName, type RuntimeAdapter, type RuntimeCommandContext } from "../runtime/types.js";
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
    await store.updateProjectState(
      job.projectId,
      job.type === "import_source" ? { status: "failed" } : { status: "failed", deploymentStatus: "failed" },
    );
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

      const workflowWorld = typeof revision.summary.workflowWorld === "string" ? revision.summary.workflowWorld : null;
      const packageJson = await readPackageJson(revision.sourcePath);
      // Block the deploy in production; only warn in development.
      const failInProductionOrWarn = async (detail: string): Promise<void> => {
        if (isProduction) {
          await store.appendLog({ projectId: job.projectId, type: "deploy", line: `Deploy blocked: ${detail}` });
          throw new Error(detail);
        }
        await store.appendLog({ projectId: job.projectId, type: "deploy", line: `Warning: ${detail}` });
      };

      if (!isDurableWorkflowWorld(workflowWorld)) {
        await failInProductionOrWarn(
          `No durable workflow world configured. Set experimental.workflow.world to "${DURABLE_WORKFLOW_WORLD}" in agent.ts.`,
        );
      } else if (!declaresDependency(packageJson, DURABLE_WORKFLOW_WORLD)) {
        await failInProductionOrWarn(
          `Workflow world package "${DURABLE_WORKFLOW_WORLD}" is not in package.json. Add "${DURABLE_WORKFLOW_WORLD}" to dependencies.`,
        );
      } else if (!workflowPostgresUrl) {
        await failInProductionOrWarn(
          "No WORKFLOW_POSTGRES_URL to inject. Set WORKFLOW_POSTGRES_URL on the worker.",
        );
      }

      const runtime = options.runtime ?? createRuntimeAdapterFromEnv();
      const currentDeployment = await store.getCurrentDeployment(job.projectId);
      const releaseId = createId("rel");
      const deploymentId = createId("dep");
      const processName = `eveland-${processSafeName(project.id)}-${processSafeName(deploymentId)}`;
      const buildDir = path.join(process.env.EVELAND_DATA_DIR ?? ".eveland-data", "builds", project.id, releaseId);
      const hostPort = currentDeployment?.hostPort ?? (await (options.allocateHostPort ?? allocateAvailableHostPort)());
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
      });
      if (build.log.trim()) {
        await store.appendLog({
          projectId: job.projectId,
          type: "build",
          line: maskKnownSecrets(build.log.trim(), secretValues),
        });
      }

      if (currentDeployment) {
        // Each adapter can only stop its own kind of process (a docker adapter
        // has no idea how to stop a systemd unit and vice versa), and the old
        // deployment's recorded runtimeKind is authoritative here -- NOT the
        // worker's current runtime, which may have moved on to a different
        // kind since that deployment was made.
        const stopAdapter =
          currentDeployment.runtimeKind === runtime.name
            ? runtime
            : (options.runtimeForKind ?? createRuntimeAdapterForKind)(currentDeployment.runtimeKind);
        await stopAdapter.stopProcess(currentDeployment.containerName);
      }
      // Same root the systemd adapter derives in ../runtime/select.ts -- both call
      // resolveSandboxCacheRoot so the two can never drift. resolveProjectSandboxCacheDir
      // then appends the per-project suffix, since ProcessStartInput carries no
      // projectId for the adapter to recompute it from.
      const sandboxCacheRoot = resolveSandboxCacheRoot(process.env);
      // Tracks the process this job itself started, distinct from
      // `currentDeployment`'s old process stopped above -- only the NEW
      // process is this block's responsibility to clean up.
      let startedProcess: string | null = null;
      try {
        const started = await runtime.startProcess({
          processName,
          releaseRef: build.releaseRef,
          port: hostPort,
          env,
          commandContext,
          sandboxCacheDir: resolveProjectSandboxCacheDir(sandboxCacheRoot, project.id),
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
      const deployment = await store.getCurrentDeployment(job.projectId);
      if (!deployment) {
        throw new Error("No deployment to restart.");
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
      // Same pairing build_deploy uses -- see the comment there.
      const sandboxCacheRoot = resolveSandboxCacheRoot(process.env);
      // Tracks whether the restart's own startProcess (above stop notwithstanding)
      // actually came up, so a startProcess failure -- nothing running under this
      // name -- doesn't trigger a pointless (or misleading) extra stop call.
      let restarted = false;
      try {
        await adapter.startProcess({
          processName: deployment.containerName,
          releaseRef: release.imageTag,
          port: deployment.hostPort,
          env,
          commandContext,
          sandboxCacheDir: resolveProjectSandboxCacheDir(sandboxCacheRoot, project.id),
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

      await store.updateProjectState(job.projectId, { deploymentStatus: "running" });
      await store.appendLog({
        projectId: job.projectId,
        deploymentId: deployment.id,
        type: "deploy",
        line: `Deployment running on 127.0.0.1:${deployment.hostPort}.`,
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

      // Known limitation: a build_deploy in progress on another worker, between
      // its startProcess and recordDeployment calls, has a live process this
      // delete cannot see yet (the deployment row doesn't exist until
      // recordDeployment runs), so that process can be orphaned by a
      // concurrent delete. Reaping orphans is a later-PR concern.
      const deployment = await store.getCurrentDeployment(job.projectId);
      if (deployment) {
        await store.appendLog({
          projectId: job.projectId,
          type: "deploy",
          line: "Stopping deployment before deleting project.",
        });
        // Same reasoning as restart_deployment: only the adapter matching the
        // deployment's own recorded runtimeKind may stop it -- never whatever
        // runtime kind the worker currently defaults to.
        const stopAdapter = options.runtime ?? (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
        await stopAdapter.stopProcess(deployment.containerName);
      }

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
  // Platform-injected credentials; a project secret of the same name overrides the platform WORKFLOW_POSTGRES_URL.
  const injectedCredentials = {
    ...(workflowPostgresUrl ? { WORKFLOW_POSTGRES_URL: workflowPostgresUrl } : {}),
    ...secrets,
  };
  // NODE_ENV is platform-owned and injected only in production; kept out of the mask list so build logs aren't scrubbed of the word "production".
  const env = {
    ...injectedCredentials,
    ...(isProduction ? { NODE_ENV: "production" } : {}),
  };
  const secretValues = Object.values(injectedCredentials);
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

// Any field `npm install` resolves counts: a world package declared in any of
// these ends up installed, so the deploy gate must not reject it.
function declaresDependency(packageJson: PackageJson | null, name: string): boolean {
  return (
    typeof packageJson?.dependencies?.[name] === "string" ||
    typeof packageJson?.devDependencies?.[name] === "string" ||
    typeof packageJson?.optionalDependencies?.[name] === "string" ||
    typeof packageJson?.peerDependencies?.[name] === "string"
  );
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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
