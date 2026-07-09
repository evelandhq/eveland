import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferEveRuntimeCommand } from "@eveland/shared/runtime";
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

export async function dockerStopAndRemove(containerName: string): Promise<void> {
  await execa("docker", ["rm", "--force", containerName], {
    reject: false,
  });
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
      const dockerfilePath = await writeGeneratedDockerfile(input.buildDir);
      const log = await dockerBuild(input.sourcePath, imageTag, dockerfilePath);
      return { releaseRef: imageTag, log };
    },
    async startProcess(input: ProcessStartInput): Promise<ProcessStartResult> {
      const log = await dockerRun({
        containerName: input.processName,
        imageTag: input.releaseRef,
        internalPort: config.internalPort,
        hostPort: input.port,
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
