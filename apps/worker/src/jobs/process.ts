import type { Store } from "@eveland/api/store";
import type { Job } from "@eveland/api/types";
import { createId } from "@eveland/shared/ids";
import { decryptSecretValue, maskKnownSecrets, type EncryptedSecret } from "@eveland/shared/secrets";
import { inferEveRuntimeCommand } from "@eveland/shared/runtime";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dockerBuild, dockerRun, dockerStopAndRemove, writeGeneratedDockerfile, type DockerRunInput } from "../runtime/docker.js";
import { importGitSource, getGitCommitSha } from "../source/importer.js";
import { scanEveSource } from "../source/scan.js";

const devSecretKey = "eveland-dev-secret-key-000000000";

type RuntimeAdapter = {
  buildImage(contextDir: string, imageTag: string, dockerfilePath: string): Promise<string>;
  stopContainer(containerName: string): Promise<void>;
  runContainer(input: DockerRunInput): Promise<string>;
};

export type ProcessJobOptions = {
  runtime?: RuntimeAdapter;
  appSecretKey?: string;
  allocateHostPort?: () => number | Promise<number>;
  waitForDeployment?: (input: { host: string; port: number; timeoutMs: number }) => Promise<void>;
};

const defaultRuntime: RuntimeAdapter = {
  buildImage: dockerBuild,
  stopContainer: dockerStopAndRemove,
  runContainer: dockerRun,
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

      const runtime = options.runtime ?? defaultRuntime;
      const currentDeployment = await store.getCurrentDeployment(job.projectId);
      const releaseId = createId("rel");
      const deploymentId = createId("dep");
      const imageTag = `eveland/${dockerSafe(project.id)}:${dockerSafe(releaseId)}`;
      const containerName = `eveland-${dockerSafe(project.id)}-${dockerSafe(deploymentId)}`;
      const buildDir = path.join(process.env.EVELAND_DATA_DIR ?? ".eveland-data", "builds", project.id, releaseId);
      const dockerfilePath = await writeGeneratedDockerfile(buildDir);
      const hostPort = currentDeployment?.hostPort ?? (await (options.allocateHostPort ?? allocateAvailableHostPort)());
      const internalPort = Number(process.env.EVELAND_INTERNAL_PORT ?? 3000);
      const secrets = await readRuntimeSecrets(store, job.projectId, options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey);
      const secretValues = Object.values(secrets);

      await store.updateProjectState(job.projectId, { status: "build_pending", deploymentStatus: "building" });
      await store.appendLog({
        projectId: job.projectId,
        type: "build",
        line: `Building ${imageTag} from ${revision.sourcePath}.`,
      });

      const buildOutput = await runtime.buildImage(revision.sourcePath, imageTag, dockerfilePath);
      if (buildOutput.trim()) {
        await store.appendLog({
          projectId: job.projectId,
          type: "build",
          line: maskKnownSecrets(buildOutput.trim(), secretValues),
        });
      }

      if (currentDeployment) {
        await runtime.stopContainer(currentDeployment.containerName);
      }
      const command = await buildContainerCommand(revision.sourcePath, internalPort);
      await runtime.runContainer({
        containerName,
        imageTag,
        internalPort,
        hostPort,
        env: secrets,
        command,
      });
      await (options.waitForDeployment ?? waitForTcpPort)({
        host: "127.0.0.1",
        port: hostPort,
        timeoutMs: Number(process.env.EVELAND_HEALTH_TIMEOUT_MS ?? 15_000),
      });

      const deployment = await store.recordDeployment({
        releaseId,
        deploymentId,
        projectId: job.projectId,
        sourceRevisionId: revision.id,
        imageTag,
        containerName,
        internalPort,
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

// Bridges the container's loopback model port to the host so eve apps that call a
// locally running Ollama (default http://127.0.0.1:11434) reach the host daemon.
const ollamaBridgeCommand = "socat TCP-LISTEN:11434,fork,reuseaddr TCP:host.docker.internal:11434 >/dev/null 2>&1 &";

async function buildContainerCommand(sourcePath: string, internalPort: number): Promise<string> {
  const packageJson = await readPackageJson(sourcePath);

  if (isEveProject(packageJson)) {
    // The image already ran `eve build`; serve the compiled output bound to all
    // interfaces so the published host port can reach it.
    return `${ollamaBridgeCommand} exec npx eve start --host 0.0.0.0 --port ${internalPort}`;
  }

  return inferEveRuntimeCommand({
    scripts: packageJson?.scripts ?? {},
  });
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

function dockerSafe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
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

async function waitForTcpPort(input: { host: string; port: number; timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await connectOnce(input.host, input.port, 500);
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  const cause = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Deployment port ${input.host}:${input.port} did not become reachable within ${input.timeoutMs}ms.${cause}`);
}

function connectOnce(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      cleanup();
      resolve();
    });
    socket.once("timeout", () => {
      cleanup();
      reject(new Error("connection timed out"));
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
