import type { Store } from "@eveland/api/store";
import type { Job } from "@eveland/api/types";
import { createId } from "@eveland/shared/ids";
import { decryptSecretValue, maskKnownSecrets, type EncryptedSecret } from "@eveland/shared/secrets";
import net from "node:net";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createDockerAdapter } from "../runtime/docker.js";
import { waitForHttpHealth } from "../runtime/health.js";
import { processSafeName, type RuntimeAdapter, type RuntimeCommandContext } from "../runtime/types.js";
import { importGitSource, getGitCommitSha } from "../source/importer.js";
import { scanEveSource } from "../source/scan.js";

const devSecretKey = "eveland-dev-secret-key-000000000";

export type ProcessJobOptions = {
  runtime?: RuntimeAdapter;
  appSecretKey?: string;
  allocateHostPort?: () => number | Promise<number>;
  waitForDeployment?: (input: { host: string; port: number; timeoutMs: number }) => Promise<void>;
};

function defaultRuntime(): RuntimeAdapter {
  return createDockerAdapter({ internalPort: Number(process.env.EVELAND_INTERNAL_PORT ?? 3000) });
}

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
    const message = error instanceof Error ? error.message : String(error);
    await store.failJob(job.id, message);
    await store.updateProjectState(job.projectId, { status: "failed", deploymentStatus: "failed" });
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

      const runtime = options.runtime ?? defaultRuntime();
      const currentDeployment = await store.getCurrentDeployment(job.projectId);
      const releaseId = createId("rel");
      const deploymentId = createId("dep");
      const processName = `eveland-${processSafeName(project.id)}-${processSafeName(deploymentId)}`;
      const buildDir = path.join(process.env.EVELAND_DATA_DIR ?? ".eveland-data", "builds", project.id, releaseId);
      const hostPort = currentDeployment?.hostPort ?? (await (options.allocateHostPort ?? allocateAvailableHostPort)());
      const secrets = await readRuntimeSecrets(store, job.projectId, options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey);
      const secretValues = Object.values(secrets);
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
        await runtime.stopProcess(currentDeployment.containerName);
      }
      const started = await runtime.startProcess({
        processName,
        releaseRef: build.releaseRef,
        port: hostPort,
        env: secrets,
        commandContext,
      });
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
      });
      await store.updateProjectState(job.projectId, { status: "deployed", deploymentStatus: "running" });
      await store.appendLog({
        projectId: job.projectId,
        deploymentId: deployment.id,
        type: "deploy",
        line: `Deployment running on 127.0.0.1:${hostPort}.`,
      });
      return;
    }
    case "restart_deployment": {
      await store.updateProjectState(job.projectId, { deploymentStatus: "starting" });
      await store.appendLog({
        projectId: job.projectId,
        type: "deploy",
        line: "Restart requested.",
      });
      await store.updateProjectState(job.projectId, { deploymentStatus: "running" });
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
