import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferEveRuntimeCommand } from "@eveland/core/server/runtime-command";
import { prepareReleaseTree } from "./prepare-release.js";
import { processSafeName, type ProcessStartInput, type ProcessStartResult, type ReleaseBuildInput, type ReleaseBuildResult, type RuntimeAdapter, type RuntimeCommandContext } from "./types.js";

export type DockerBuildInput = {
  contextDir: string;
  dockerfilePath: string;
  imageTag: string;
};

export type DockerRunInput = {
  containerName: string;
  imageTag: string;
  internalPort: number;
  hostPort: number;
  observerOutboxDir: string;
  env: Record<string, string>;
  command: string;
};

export function buildDockerRunArgs(input: DockerRunInput): string[] {
  const args = [
    "run",
    "--detach",
    "--name",
    input.containerName,
    "--restart",
    "unless-stopped",
    // Let the container reach host services (e.g. a locally running Ollama) via host.docker.internal.
    "--add-host",
    "host.docker.internal:host-gateway",
    "--publish",
    `127.0.0.1:${input.hostPort}:${input.internalPort}`,
    "--volume",
    `${input.observerOutboxDir}:/var/lib/eveland-observer`,
    "--env",
    "EVELAND_OBSERVER_OUTBOX_DIR=/var/lib/eveland-observer",
  ];

  for (const [key, value] of Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b))) {
    args.push("--env", `${key}=${value}`);
  }

  args.push(input.imageTag, "sh", "-lc", input.command);
  return args;
}

export function buildDockerBuildArgs(input: DockerBuildInput): string[] {
  return ["build", "--file", input.dockerfilePath, "--tag", input.imageTag, input.contextDir];
}

export async function writeGeneratedDockerfile(buildDir: string): Promise<string> {
  await mkdir(buildDir, { recursive: true });
  const dockerfilePath = path.join(buildDir, "Dockerfile");
  await writeFile(
    dockerfilePath,
    `FROM node:24-alpine
WORKDIR /app
# socat bridges the container's local model port (e.g. Ollama 11434) to the host.
RUN apk add --no-cache socat
COPY package*.json ./
# Install all dependencies: eve projects need their build toolchain to compile.
RUN if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi
COPY . .
# Compile the eve application ahead of time so \`eve start\` can serve it.
RUN if node -e "const p=require('./package.json');process.exit(p.dependencies&&p.dependencies.eve?0:1)"; then npx eve build; fi
EXPOSE 3000
`,
  );
  return dockerfilePath;
}

export async function dockerBuild(contextDir: string, imageTag: string, dockerfilePath: string): Promise<string> {
  const result = await execa("docker", buildDockerBuildArgs({ contextDir, imageTag, dockerfilePath }), {
    all: true,
  });
  return result.all ?? "";
}

export async function dockerRun(input: DockerRunInput): Promise<string> {
  const result = await execa("docker", buildDockerRunArgs(input), {
    all: true,
  });
  return result.all ?? "";
}

export type DockerCommandOutcome = {
  failed: boolean;
  exitCode?: number;
  stderr?: string;
};

/**
 * `docker rm --force` exits non-zero both when the named container simply
 * doesn't exist -- an idempotent no-op eveland relies on (a half-finished
 * delete re-run, or a redeploy after the container already crashed and was
 * reaped) -- and when docker itself is unusable (CLI missing, daemon down,
 * permission denied). Only the former is safe to swallow silently; the
 * caller must throw on everything else so a missing/unreachable runtime
 * fails the job loudly instead of orphaning the process.
 */
export function isBenignDockerStopFailure(outcome: DockerCommandOutcome): boolean {
  if (!outcome.failed) {
    return true;
  }
  return /No such container/i.test(outcome.stderr ?? "");
}

export async function dockerStopAndRemove(containerName: string): Promise<void> {
  const result = await execa("docker", ["rm", "--force", containerName], {
    reject: false,
  });
  const outcome: DockerCommandOutcome = { failed: result.failed, exitCode: result.exitCode, stderr: result.stderr };
  if (isBenignDockerStopFailure(outcome)) {
    return;
  }
  throw new Error(
    `docker rm --force ${containerName} failed (exit ${outcome.exitCode ?? "none -- docker CLI may be missing or unreachable"}): ${
      outcome.stderr || "no stderr captured"
    }`,
  );
}

// Bridges the container's loopback model port to the host so eve apps that call a
// locally running Ollama (default http://127.0.0.1:11434) reach the host daemon.
const ollamaBridgeCommand = "socat TCP-LISTEN:11434,fork,reuseaddr TCP:host.docker.internal:11434 >/dev/null 2>&1 &";

export function buildDockerStartCommand(context: RuntimeCommandContext, internalPort: number): string {
  if (context.isEveProject) {
    // The image already ran `eve build`; serve the compiled output bound to all
    // interfaces so the published host port can reach it.
    return `${ollamaBridgeCommand} exec npx eve start --host 0.0.0.0 --port ${internalPort}`;
  }
  return inferEveRuntimeCommand({ scripts: context.scripts });
}

export type DockerAdapterConfig = {
  internalPort: number;
};

export function createDockerAdapter(config: DockerAdapterConfig): RuntimeAdapter {
  return {
    name: "docker",
    async buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult> {
      const imageTag = `eveland/${processSafeName(input.projectId)}:${processSafeName(input.releaseId)}`;
      const injection = await prepareReleaseTree({ sourcePath: input.sourcePath, buildDir: input.buildDir });
      const dockerfilePath = await writeGeneratedDockerfile(input.buildDir);
      const log = await dockerBuild(input.buildDir, imageTag, dockerfilePath);
      return {
        releaseRef: imageTag,
        log: `${log}${log && !log.endsWith("\n") ? "\n" : ""}Injected Eveland observer hooks: ${injection.injectedFiles.join(", ") || "none"}`,
      };
    },
    async startProcess(input: ProcessStartInput): Promise<ProcessStartResult> {
      const log = await dockerRun({
        containerName: input.processName,
        imageTag: input.releaseRef,
        internalPort: config.internalPort,
        hostPort: input.port,
        observerOutboxDir: input.observerOutboxDir,
        env: input.env,
        command: buildDockerStartCommand(input.commandContext, config.internalPort),
      });
      return { internalPort: config.internalPort, log };
    },
    async stopProcess(processName: string): Promise<void> {
      await dockerStopAndRemove(processName);
    },
  };
}
