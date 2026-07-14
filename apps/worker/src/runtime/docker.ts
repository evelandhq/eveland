import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferEveRuntimeCommand } from "@eveland/core/server/runtime-command";
import { prepareReleaseTree } from "./prepare-release.js";
import { injectSandboxModules } from "./sandbox-inject.js";
import { SANDBOX_VERIFY_SCRIPT_PATH, writeSandboxVerifyScript } from "./sandbox-verify.js";
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
  sandboxEnabled: boolean;
  sandboxCacheDir: string;
  observerOutboxDir: string;
  env: Record<string, string>;
  command: string;
};

const DOCKER_BWRAP_SECURITY_ARGS = [
  "--cap-drop",
  "ALL",
  "--cap-add",
  "SYS_ADMIN",
  "--cap-add",
  "NET_ADMIN",
  "--security-opt",
  "no-new-privileges",
  "--security-opt",
  "seccomp=unconfined",
] as const;

export function buildDockerRunArgs(input: DockerRunInput): string[] {
  const args = [
    "run",
    "--detach",
    "--name",
    input.containerName,
    "--restart",
    "unless-stopped",
  ];

  if (input.sandboxEnabled) {
    args.push(
      // bubblewrap needs to create mount/network namespaces inside the
      // deployment container. Drop Docker's default capability set first and
      // grant only the two capabilities bwrap needs; the Agent never receives
      // the Docker socket.
      ...DOCKER_BWRAP_SECURITY_ARGS,
    );
  }

  args.push(
    // Let the container reach host services (e.g. a locally running Ollama) via host.docker.internal.
    "--add-host",
    "host.docker.internal:host-gateway",
    "--publish",
    `127.0.0.1:${input.hostPort}:${input.internalPort}`,
    "--volume",
    `${input.observerOutboxDir}:/var/lib/eveland-observer`,
  );

  if (input.sandboxEnabled) {
    args.push(
      "--volume",
      `${input.sandboxCacheDir}:/var/lib/eveland-sandbox`,
    );
  }

  args.push("--env", "EVELAND_OBSERVER_OUTBOX_DIR=/var/lib/eveland-observer");

  if (input.sandboxEnabled) {
    args.push(
      "--env",
      "EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland-sandbox",
    );
  }

  for (const [key, value] of Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b))) {
    args.push("--env", `${key}=${value}`);
  }

  args.push(input.imageTag, "sh", "-lc", input.command);
  return args;
}

export function buildDockerBuildArgs(input: DockerBuildInput): string[] {
  return ["build", "--file", input.dockerfilePath, "--tag", input.imageTag, input.contextDir];
}

export function buildDockerSandboxVerifyArgs(imageTag: string): string[] {
  return [
    "run",
    "--rm",
    ...DOCKER_BWRAP_SECURITY_ARGS,
    "--network",
    "none",
    "--tmpfs",
    "/tmp",
    "--env",
    "EVELAND_SANDBOX_CACHE_DIR=/tmp",
    imageTag,
    "node",
    path.posix.join("/app", SANDBOX_VERIFY_SCRIPT_PATH),
  ];
}

export async function verifyDockerSandbox(imageTag: string): Promise<void> {
  const result = await execa("docker", buildDockerSandboxVerifyArgs(imageTag), {
    all: true,
    reject: false,
  });
  const output = result.all ?? "";
  if (result.exitCode !== 0 || !output.includes("SANDBOX VERIFY OK")) {
    throw new Error(
      "Docker sandbox self-check failed: the built Agent image could not execute the injected bwrap " +
        "TypeScript probe under the local deployment permissions. Ensure the Docker engine supports " +
        "SYS_ADMIN/NET_ADMIN capabilities and seccomp=unconfined. Captured output (exit=" +
        (result.exitCode ?? "unknown") +
        "):\n" +
        output,
    );
  }
}

export async function writeGeneratedDockerfile(buildDir: string): Promise<string> {
  await mkdir(buildDir, { recursive: true });
  const dockerfilePath = path.join(buildDir, "Dockerfile");
  await writeFile(
    dockerfilePath,
    `FROM node:24-alpine
WORKDIR /app
# bash + bubblewrap provide the injected Eve exec sandbox. socat bridges the
# container's local model port (e.g. Ollama 11434) to the host.
RUN apk add --no-cache bash bubblewrap socat
# bwrap bind-mounts each durable session workspace here. The mountpoint must
# exist before the container root is remounted read-only inside the sandbox.
RUN mkdir -p /workspace
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
  /** Resolves the built bwrap backend only when an Eve release is built. */
  backendDistDir: () => string;
};

export function createDockerAdapter(config: DockerAdapterConfig): RuntimeAdapter {
  return {
    name: "docker",
    async buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult> {
      const imageTag = `eveland/${processSafeName(input.projectId)}:${processSafeName(input.releaseId)}`;
      const observerInjection = await prepareReleaseTree({ sourcePath: input.sourcePath, buildDir: input.buildDir });
      const sandboxInjection = input.commandContext.isEveProject
        ? await injectSandboxModules({ releaseDir: path.resolve(input.buildDir), backendDistDir: config.backendDistDir() })
        : undefined;
      if (sandboxInjection) {
        await writeSandboxVerifyScript(path.resolve(input.buildDir));
      }
      const dockerfilePath = await writeGeneratedDockerfile(input.buildDir);
      const log = await dockerBuild(input.buildDir, imageTag, dockerfilePath);
      if (sandboxInjection) {
        await verifyDockerSandbox(imageTag);
      }
      return {
        releaseRef: imageTag,
        log: [
          log,
          `Injected Eveland observer hooks: ${observerInjection.injectedFiles.join(", ") || "none"}`,
          sandboxInjection
            ? `Injected eve sandbox modules: ${sandboxInjection.generated.join(", ") || "none"}`
            : undefined,
          sandboxInjection?.generated.length === 0
            ? "WARNING: no agent/ directory was found at the project root, so no sandbox module could " +
              "be injected. The deployed agent will fall back to eve's default sandbox backend chain."
            : undefined,
          sandboxInjection?.replaced.length
            ? `WARNING: replaced the project's authored sandbox (${sandboxInjection.replaced.join(", ")}). ` +
              "eveland selects the sandbox backend for Docker deployments."
            : undefined,
          sandboxInjection
            ? "Docker sandbox self-check passed: bwrap executed TypeScript with deployment-equivalent permissions."
            : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
    async startProcess(input: ProcessStartInput): Promise<ProcessStartResult> {
      const log = await dockerRun({
        containerName: input.processName,
        imageTag: input.releaseRef,
        internalPort: config.internalPort,
        hostPort: input.port,
        sandboxEnabled: input.commandContext.isEveProject,
        sandboxCacheDir: input.sandboxCacheDir,
        observerOutboxDir: input.observerOutboxDir,
        env: input.env,
        command: buildDockerStartCommand(input.commandContext, config.internalPort),
      });
      return { internalPort: config.internalPort, log };
    },
    async stopProcess(processName: string): Promise<void> {
      await dockerStopAndRemove(processName);
    },
    async removeRelease(releaseRef: string): Promise<void> {
      const result = await execa("docker", ["image", "rm", releaseRef], { all: true, reject: false });
      if (!result.failed || /No such image/i.test(result.stderr ?? "")) return;
      throw new Error(
        `docker image rm ${releaseRef} failed (exit ${result.exitCode ?? "none -- docker CLI may be missing or unreachable"}): ${
          result.stderr || "no stderr captured"
        }`,
      );
    },
  };
}
