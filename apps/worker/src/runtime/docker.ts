import { execa } from "execa";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { rejectedBuildVariablesLog, selectBuildVariables } from "./build-environment.js";
import { prepareReleaseTree } from "./prepare-release.js";
import { injectSandboxModules } from "./sandbox-inject.js";
import { PNPM_FROZEN_INSTALL_COMMAND } from "./package-manager.js";
import { SANDBOX_PNPM_VERSION, SANDBOX_TOOLCHAIN_APK_PACKAGES } from "./sandbox-toolchain.js";
import { SANDBOX_VERIFY_SCRIPT_PATH, writeSandboxVerifyScript } from "./sandbox-verify.js";
import {
  processSafeName,
  type PortOwnership,
  type PortOwnershipCapability,
  type ProcessStartInput,
  type ProcessStartResult,
  type ReleaseBuildInput,
  type ReleaseBuildResult,
  type ReleaseDiscovery,
  type CompleteRuntimeAdapter,
  type RuntimeCommandContext,
} from "./types.js";
import {
  buildWorkflowWorldInstallCommand,
  WORKFLOW_WORLD_TARBALL_FILENAME,
  type WorkflowWorldBuildConfig,
} from "./workflow-world.js";
import { AGENT_OBSERVABILITY_MOUNT_DIR } from "./observability/policy.js";
import {
  ensureAgentTelemetryNetwork,
  removeAgentTelemetryNetwork,
  resolveAgentTelemetryNetworkName,
} from "./docker/agent-network.js";

export type DockerBuildInput = {
  contextDir: string;
  dockerfilePath: string;
  imageTag: string;
  /**
   * Build-arg values are recorded in the image's build metadata, which is why
   * only `kind: "variable"` entries may travel this way.
   */
  variables?: Readonly<Record<string, string>>;
};

export type DockerRunInput = {
  containerName: string;
  imageTag: string;
  internalPort: number;
  hostPort: number;
  sandboxCacheDir: string;
  observabilityPolicyDir: string;
  /**
   * Root-owned 0600 file holding the deployment's decrypted environment.
   * Passed as --env-file rather than --env KEY=VALUE: argv is world-readable
   * through /proc/<pid>/cmdline while the CLI runs and is retained forever in
   * `docker inspect`, so project secrets must never ride on it. Mirrors the
   * systemd adapter's EnvironmentFile discipline.
   */
  envFilePath: string;
  command: string;
};

const defaultCollectorContainerName = "eveland-otel-collector";

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
    "--network",
    resolveAgentTelemetryNetworkName(input.containerName),
  ];

  args.push(
    // bubblewrap needs to create mount/network namespaces inside the
    // deployment container. Drop Docker's default capability set first and
    // grant only the two capabilities bwrap needs; the Agent never receives
    // the Docker socket.
    ...DOCKER_BWRAP_SECURITY_ARGS,
    // Let the container reach host services (e.g. a locally running Ollama) via host.docker.internal.
    "--add-host",
    "host.docker.internal:host-gateway",
    "--publish",
    `127.0.0.1:${input.hostPort}:${input.internalPort}`,
    "--volume",
    `${input.observabilityPolicyDir}:${AGENT_OBSERVABILITY_MOUNT_DIR}:ro`,
    "--volume",
    `${input.sandboxCacheDir}:/var/lib/eveland-sandbox`,
    "--env",
    "EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland-sandbox",
    "--env",
    `EVELAND_SANDBOX_TEMPLATE_REVISION=${input.imageTag}`,
  );

  args.push("--env-file", input.envFilePath);

  args.push(input.imageTag, "sh", "-lc", input.command);
  return args;
}

/**
 * Docker's --env-file format is plain KEY=VALUE: the value runs literally to
 * end of line, with no quoting or escaping, so a newline cannot be
 * represented (and would silently truncate the secret or inject another key).
 * Deliberately NOT buildEnvFileContent from the systemd adapter -- that one
 * emits shell-quoted values for systemd's EnvironmentFile, and Docker would
 * hand the surrounding quotes to the process as part of the value.
 */
export function buildDockerEnvFileContent(env: Record<string, string>): string {
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (/[\n\r]/.test(value)) {
        throw new Error(
          `Secret ${key} contains a newline; a Docker --env-file cannot represent it.`,
        );
      }
      return `${key}=${value}`;
    });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function buildDockerBuildArgs(input: DockerBuildInput): string[] {
  const buildArgs = Object.entries(input.variables ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]);
  return [
    "build",
    "--file",
    input.dockerfilePath,
    ...buildArgs,
    "--tag",
    input.imageTag,
    input.contextDir,
  ];
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

// eve build and the post-build eve info discovery pass ran inside the image,
// so their discovery artifacts live in the image filesystem, not on the host.
// One throwaway container prints them; failures only cost the build-derived
// summary (the import-time static one remains).
const readImageDiscoveryScript =
  'const fs=require("fs");let m=null,v=null;' +
  'try{m=JSON.parse(fs.readFileSync("/app/.eve/discovery/agent-discovery-manifest.json","utf8"))}catch{}' +
  'try{v=require("/app/node_modules/eve/package.json").version}catch{}' +
  'process.stdout.write(JSON.stringify({manifest:m,resolvedEveVersion:typeof v==="string"?v:null}))';

export async function readImageDiscovery(imageTag: string): Promise<ReleaseDiscovery | undefined> {
  const result = await execa(
    "docker",
    ["run", "--rm", "--network", "none", imageTag, "node", "-e", readImageDiscoveryScript],
    { reject: false },
  ).catch(() => undefined);
  if (!result || result.exitCode !== 0 || typeof result.stdout !== "string") return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as {
      manifest: unknown;
      resolvedEveVersion: string | null;
    };
    return parsed.manifest === null ? undefined : parsed;
  } catch {
    return undefined;
  }
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

export async function writeGeneratedDockerfile(
  buildDir: string,
  workflowWorld?: WorkflowWorldBuildConfig,
  variableKeys: readonly string[] = [],
): Promise<string> {
  await mkdir(buildDir, { recursive: true });
  const dockerfilePath = path.join(buildDir, "Dockerfile");
  const sandboxPackages = SANDBOX_TOOLCHAIN_APK_PACKAGES.join(" ");
  // A tarball install reads a file, so it has to be in the image before the RUN
  // that installs it — the broad `COPY . .` below happens afterwards.
  const workflowWorldCopy = workflowWorld?.packageTarball
    ? `COPY ${WORKFLOW_WORLD_TARBALL_FILENAME} ./\n`
    : "";
  const workflowWorldInstall = workflowWorld
    ? `${workflowWorldCopy}RUN if [ -f pnpm-lock.yaml ]; then ${buildWorkflowWorldInstallCommand(workflowWorld, "pnpm")}; else ${buildWorkflowWorldInstallCommand(workflowWorld, "npm")}; fi\n`
    : "";
  // ARG, not ENV: a build arg is an environment variable for the RUN below
  // without persisting into the deployed image, where the runtime --env-file
  // stays the only authority. Declared last before that RUN so a variable
  // change invalidates only this layer.
  const buildVariableArgs = [...variableKeys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `ARG ${key}\n`)
    .join("");
  await writeFile(
    dockerfilePath,
    `FROM node:24-alpine
WORKDIR /app
# Platform-owned command baseline for Eve's built-in tools and common skills.
# bubblewrap provides isolation; socat bridges a local model port to the host.
RUN apk add --no-cache ${sandboxPackages}
# Match Eve's Python command aliases and pin the workspace package manager.
RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
    && ln -sf /usr/bin/pip3 /usr/local/bin/pip \
    && npm install --global pnpm@${SANDBOX_PNPM_VERSION}
# bwrap bind-mounts each durable session workspace here. The mountpoint must
# exist before the container root is remounted read-only inside the sandbox.
RUN mkdir -p /workspace
COPY package*.json pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc* ./
# Install all dependencies: eve projects need their build toolchain to compile.
RUN if [ -f pnpm-lock.yaml ]; then ${PNPM_FROZEN_INSTALL_COMMAND}; elif [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi
${workflowWorldInstall}COPY . .
# Compile the eve application ahead of time, then materialize the full
# discovery manifest from that exact installed dependency tree.
${buildVariableArgs}RUN npx eve build && npx eve info --json > /dev/null
EXPOSE 3000
`,
  );
  return dockerfilePath;
}

export async function dockerBuild(
  input: DockerBuildInput & { signal?: AbortSignal },
): Promise<string> {
  const { signal, ...buildInput } = input;
  const result = await execa("docker", buildDockerBuildArgs(buildInput), {
    all: true,
    ...(signal ? { cancelSignal: signal } : {}),
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
  const outcome: DockerCommandOutcome = {
    failed: result.failed,
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
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
const ollamaBridgeCommand =
  "socat TCP-LISTEN:11434,fork,reuseaddr TCP:host.docker.internal:11434 >/dev/null 2>&1 &";

export function buildDockerStartCommand(
  _context: RuntimeCommandContext,
  internalPort: number,
): string {
  // The image already ran `eve build`; serve the compiled output bound to all
  // interfaces so the published host port can reach it.
  return `${ollamaBridgeCommand} exec npx eve start --host 0.0.0.0 --port ${internalPort}`;
}

export type DockerAdapterConfig = {
  internalPort: number;
  collectorContainerName?: string;
  /** Root of the worker's data dir; holds the root-owned 0600 env files. */
  dataDir: string;
  /** Resolves the built bwrap backend only when an Eve release is built. */
  backendDistDir: () => string;
};

/**
 * Maps `docker ps --filter publish=<port>` output onto the shared
 * PortOwnership vocabulary. The daemon's publish records are docker's
 * authority on which container holds a host port -- docker-proxy binds the
 * socket itself, so an ss/pid lookup would name docker-proxy for every
 * container and prove nothing.
 */
export function parseDockerPublishOwnership(stdout: string, processName: string): PortOwnership {
  const names = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (names.length === 0) return { status: "unbound" };
  if (names.includes(processName)) return { status: "owned" };
  return { status: "foreign", holder: names.join(", ") };
}

export function createDockerAdapter(
  config: DockerAdapterConfig,
): CompleteRuntimeAdapter & PortOwnershipCapability {
  const collectorContainerName = config.collectorContainerName ?? defaultCollectorContainerName;
  const envDir = path.resolve(config.dataDir, "deployment-env");
  const envFilePathFor = (processName: string) => path.join(envDir, `${processName}.env`);
  const adapter: CompleteRuntimeAdapter & PortOwnershipCapability = {
    name: "docker",
    async buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult> {
      const imageTag = `eveland/${processSafeName(input.projectId)}:${processSafeName(input.releaseId)}`;
      try {
        const observerInjection = await prepareReleaseTree({
          sourcePath: input.sourcePath,
          buildDir: input.buildDir,
          workflowWorld: input.workflowWorld,
        });
        const sandboxInjection = await injectSandboxModules({
          releaseDir: path.resolve(input.buildDir),
          backendDistDir: config.backendDistDir(),
        });
        if (sandboxInjection) {
          await writeSandboxVerifyScript(path.resolve(input.buildDir));
        }
        const buildVariables = selectBuildVariables(input.buildVariables);
        const dockerfilePath = await writeGeneratedDockerfile(
          input.buildDir,
          input.workflowWorld,
          Object.keys(buildVariables.variables),
        );
        const log = await dockerBuild({
          contextDir: input.buildDir,
          dockerfilePath,
          imageTag,
          variables: buildVariables.variables,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (sandboxInjection) {
          await verifyDockerSandbox(imageTag);
        }
        const discovery = await readImageDiscovery(imageTag);
        return {
          releaseRef: imageTag,
          schedulerDefinitions: observerInjection.scheduler?.definitions,
          ...(discovery ? { discovery } : {}),
          log: [
            log,
            rejectedBuildVariablesLog(buildVariables.rejectedKeys),
            `Injected Eveland observer hooks: ${observerInjection.injectedFiles.join(", ") || "none"}`,
            observerInjection.workflowWorld
              ? `Injected platform workflow world: ${input.workflowWorld?.packageName} (${observerInjection.workflowWorld.agentConfigPath})`
              : undefined,
            sandboxInjection
              ? `Injected eve sandbox modules: ${sandboxInjection.generated.join(", ") || "none"}`
              : undefined,
            sandboxInjection?.generated.length === 0
              ? "WARNING: no agent/ directory was found at the project root, so no sandbox module could " +
                "be injected. The deployed agent will fall back to eve's default sandbox backend chain."
              : undefined,
            sandboxInjection?.replaced.length
              ? `WARNING: replaced the project's authored sandbox (${sandboxInjection.replaced.join(", ")}). ` +
                "eveland selects the sandbox backend for Docker deployments; the authored module's " +
                "bootstrap() and onSession() are not used, while workspace seeds are preserved."
              : undefined,
            sandboxInjection
              ? "Docker sandbox self-check passed: bwrap executed TypeScript with deployment-equivalent permissions."
              : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      } catch (error) {
        await Promise.allSettled([
          execa("docker", ["image", "rm", imageTag], {
            all: true,
            reject: false,
          }),
          rm(input.buildDir, { recursive: true, force: true }),
        ]);
        throw error;
      }
    },
    async startProcess(input: ProcessStartInput): Promise<ProcessStartResult> {
      await ensureAgentTelemetryNetwork(input.processName, collectorContainerName);
      await mkdir(envDir, { recursive: true });
      const envFilePath = envFilePathFor(input.processName);
      const deploymentEnv = { ...input.env };
      delete deploymentEnv.EVELAND_SANDBOX_TEMPLATE_REVISION;
      await writeFile(envFilePath, buildDockerEnvFileContent(deploymentEnv), { mode: 0o600 });
      try {
        const log = await dockerRun({
          containerName: input.processName,
          imageTag: input.releaseRef,
          internalPort: config.internalPort,
          hostPort: input.port,
          sandboxCacheDir: input.sandboxCacheDir,
          observabilityPolicyDir: input.observabilityPolicyDir,
          envFilePath,
          command: buildDockerStartCommand(input.commandContext, config.internalPort),
        });
        return { internalPort: config.internalPort, log };
      } catch (error) {
        // Docker copies the env file's contents into the container config at
        // create time, so nothing needs it after this call -- and a failed
        // start must not leave decrypted secrets on disk.
        await rm(envFilePath, { force: true }).catch(() => undefined);
        await removeAgentTelemetryNetwork(input.processName, collectorContainerName).catch(
          () => undefined,
        );
        throw error;
      }
    },
    async inspectProcess(processName) {
      const result = await execa(
        "docker",
        ["inspect", "--format", "{{.State.Status}}", processName],
        {
          all: true,
          reject: false,
        },
      );
      if (result.failed) {
        if (/No such (object|container)/i.test(result.all ?? "")) return "missing";
        throw new Error(
          `docker inspect ${processName} failed: ${result.all || "no output captured"}`,
        );
      }
      const status = (result.stdout ?? "").trim();
      if (status === "running") return "ready";
      if (status === "created" || status === "restarting") return "starting";
      if (status === "exited") return "stopped";
      // "paused" lands here deliberately: a paused container never becomes
      // ready on its own, so treating it as transitional made ensureProcess
      // reuse it and activation poll health until timeout. Failed makes
      // ensureProcess stop and replace it.
      return "failed";
    },
    async getProcessDiagnostics(processName) {
      const [state, logs] = await Promise.all([
        execa(
          "docker",
          [
            "inspect",
            "--format",
            "status={{.State.Status}} restarting={{.State.Restarting}} exitCode={{.State.ExitCode}} oomKilled={{.State.OOMKilled}} restartCount={{.RestartCount}} error={{json .State.Error}}",
            processName,
          ],
          { all: true, reject: false },
        ),
        execa("docker", ["logs", "--tail", "200", processName], { all: true, reject: false }),
      ]);
      return {
        state: diagnosticCommandOutput(state, "docker inspect"),
        logs: diagnosticCommandOutput(logs, "docker logs"),
      };
    },
    async verifyPortOwnership({ processName, port }): Promise<PortOwnership> {
      // A non-container host process holding the port stays invisible to the
      // daemon and reports "unbound"; the readiness gate then times out
      // instead of trusting the wrong responder's HTTP answers.
      const published = await execa(
        "docker",
        ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"],
        { all: true, reject: false },
      );
      if (published.failed) {
        // Silently passing here would reintroduce blind trust in whatever
        // answers on the port, so an unusable lookup fails activation loudly.
        throw new Error(
          `docker publish lookup for port ${port} failed: ${published.all || "no output captured"}`,
        );
      }
      return parseDockerPublishOwnership(published.stdout ?? "", processName);
    },
    async ensureProcess(input) {
      const status = await adapter.inspectProcess(input.processName);
      if (status === "ready" || status === "starting") {
        const ownership = await adapter.verifyPortOwnership({
          processName: input.processName,
          port: input.port,
        });
        if (
          ownership.status === "owned" ||
          (ownership.status === "unbound" && status === "starting")
        ) {
          // A starting container that has not published yet is a legitimate
          // reuse; the readiness gate keeps polling ownership afterwards.
          return {
            internalPort: config.internalPort,
            log: `Reused ${status} Docker process ${input.processName}.`,
          };
        }
        if (ownership.status === "foreign") {
          // The container is alive but its host port is served by another
          // container; left running its traffic would reach the wrong Agent.
          await dockerStopAndRemove(input.processName);
          throw new Error(
            `Docker process ${input.processName} does not publish port ${input.port}: ` +
              `the port is published by ${ownership.holder}. Stopped the container instead of ` +
              "reusing it against another container's socket.",
          );
        }
        // Ready but unbound: the daemon no longer maps this port to the
        // container (a re-created deployment on a new port); replace it.
      }
      if (status !== "missing") await dockerStopAndRemove(input.processName);
      return adapter.startProcess(input);
    },
    async listProcesses(namePrefix) {
      const result = await execa(
        "docker",
        ["ps", "--format", "{{.Names}}", "--filter", `name=^${namePrefix}`],
        {
          all: true,
          reject: false,
        },
      );
      if (result.failed) {
        throw new Error(`docker ps failed: ${result.all || "no output captured"}`);
      }
      return (result.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name.startsWith(namePrefix));
    },
    async stopProcess(processName: string): Promise<void> {
      await dockerStopAndRemove(processName);
      // Same discipline as the systemd adapter: decrypted secrets never
      // outlive the process they were written for.
      await rm(envFilePathFor(processName), { force: true }).catch(() => undefined);
      await removeAgentTelemetryNetwork(processName, collectorContainerName).catch((error) => {
        console.warn(
          `Could not clean up Agent telemetry network for "${processName}"; the orphan sweep will retry: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
    async removeRelease(releaseRef: string): Promise<void> {
      const result = await execa("docker", ["image", "rm", releaseRef], {
        all: true,
        reject: false,
      });
      if (!result.failed || /No such image/i.test(result.stderr ?? "")) return;
      throw new Error(
        `docker image rm ${releaseRef} failed (exit ${result.exitCode ?? "none -- docker CLI may be missing or unreachable"}): ${
          result.stderr || "no stderr captured"
        }`,
      );
    },
  };
  return adapter;
}

function diagnosticCommandOutput(
  result: { failed?: boolean; all?: string; stdout?: string; stderr?: string },
  command: string,
): string {
  const output = (result.all || result.stdout || result.stderr || "").trim();
  if (result.failed) return output ? `${command} unavailable: ${output}` : `${command} unavailable`;
  return output;
}
