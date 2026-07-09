import { execa } from "execa";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferEveRuntimeCommand } from "@eveland/shared/runtime";
import { injectSandboxModules } from "./sandbox-inject.js";
import { processSafeName, type ProcessStartInput, type ProcessStartResult, type ReleaseBuildInput, type ReleaseBuildResult, type RuntimeAdapter, type RuntimeCommandContext } from "./types.js";

export type SystemdStartInput = {
  unitName: string;
  releaseDir: string;
  envFilePath: string;
  port: number;
  user: string;
  memoryMax: string;
  cpuQuota: string;
  sandboxCacheDir: string;
  command: string;
};

/**
 * Every project's sandbox cache lives at `<root>/<processSafeName(projectId)>`.
 * Exported so `createSystemdAdapter` (which knows the projectId at build time)
 * and `jobs/process.ts` (which must pass the identical path into
 * `startProcess`, since `ProcessStartInput` carries no projectId) can never
 * compute two different paths for the same project.
 */
export function resolveProjectSandboxCacheDir(root: string, projectId: string): string {
  return path.resolve(root, processSafeName(projectId));
}

export function buildSystemdRunArgs(input: SystemdStartInput): string[] {
  return [
    "--unit",
    input.unitName,
    "--collect",
    "--service-type=exec",
    "--property=Restart=on-failure",
    "--property=RestartSec=2",
    `--property=User=${input.user}`,
    `--property=WorkingDirectory=${input.releaseDir}`,
    `--property=EnvironmentFile=${input.envFilePath}`,
    `--property=Environment=PORT=${input.port}`,
    `--property=Environment=EVELAND_SANDBOX_CACHE_DIR=${input.sandboxCacheDir}`,
    `--property=MemoryMax=${input.memoryMax}`,
    `--property=CPUQuota=${input.cpuQuota}`,
    "--property=ProtectSystem=strict",
    `--property=ReadWritePaths=${input.releaseDir}`,
    // systemd list-type settings (ReadWritePaths= included) append across repeated
    // assignments rather than overwriting -- confirmed live via `systemd-run
    // --property=ReadWritePaths=/tmp --property=ReadWritePaths=/var/tmp` followed by
    // `systemctl show -p ReadWritePaths`, which reported "ReadWritePaths=/tmp /var/tmp".
    `--property=ReadWritePaths=${input.sandboxCacheDir}`,
    "--property=PrivateTmp=yes",
    "--property=NoNewPrivileges=yes",
    "sh",
    "-lc",
    input.command,
  ];
}

export function buildSystemdStartCommand(context: RuntimeCommandContext, port: number): string {
  if (context.isEveProject) {
    // Host process: loopback binding is enough, and Ollama on localhost needs no bridge.
    return `npx eve start --host 127.0.0.1 --port ${port}`;
  }
  return inferEveRuntimeCommand({ scripts: context.scripts });
}

export function buildReleaseBuildCommand(context: RuntimeCommandContext): string {
  const install = context.hasLockfile ? "npm ci" : "npm install";
  return context.isEveProject ? `${install} && npx eve build` : install;
}

export type BwrapBuildInput = {
  releaseDir: string;
  npmCacheDir: string;
  dataDir: string;
  command: string;
};

export function buildBwrapArgs(input: BwrapBuildInput): string[] {
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    // Shadow the whole data dir (deployment-env secrets, sources, every other
    // project's build) before re-exposing only this build's own release dir
    // and the shared npm cache. Without this, build-time npm/eve lifecycle
    // scripts -- which run as root, untrusted, from the imported project's
    // dependency tree -- could read every decrypted secret on the host via
    // the `--ro-bind / /` above. bwrap applies mounts in argument order and
    // creates bind destinations inside its own tmpfs, so the two --bind
    // entries below only re-open the subtrees they name.
    "--tmpfs", input.dataDir,
    "--bind", input.releaseDir, input.releaseDir,
    "--bind", input.npmCacheDir, input.npmCacheDir,
    "--unshare-pid",
    "--die-with-parent",
    "--chdir", input.releaseDir,
    "sh", "-lc", input.command,
  ];
}

export function buildEnvFileContent(env: Record<string, string>): string {
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (value.includes("\n")) {
        throw new Error(`Secret ${key} contains a newline; systemd EnvironmentFile cannot represent it.`);
      }
      return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export type SystemdAdapterConfig = {
  dataDir: string;
  user: string;
  memoryMax: string;
  cpuQuota: string;
  buildSandbox: "bwrap" | "none";
  /** Root directory holding every project's durable eve sandbox session cache. */
  sandboxCacheDir: string;
  /** Directory holding the built @eveland/sandbox-bwrap (its dist/), vendored into each release. */
  backendDistDir: string;
};

export function createSystemdAdapter(config: SystemdAdapterConfig): RuntimeAdapter {
  const dataDir = path.resolve(config.dataDir);
  const npmCacheDir = path.resolve(dataDir, "npm-cache");
  const envDir = path.resolve(dataDir, "deployment-env");
  const projectCacheDir = (projectId: string) => resolveProjectSandboxCacheDir(config.sandboxCacheDir, projectId);

  return {
    name: "systemd",
    async buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult> {
      const releaseDir = path.resolve(input.buildDir);
      await mkdir(releaseDir, { recursive: true });
      await mkdir(npmCacheDir, { recursive: true });
      await execa("cp", ["-a", `${path.resolve(input.sourcePath)}/.`, releaseDir]);

      // Runs after cp -a (so it has a release to write into) and before the build
      // command (so `npx eve build` compiles the generated module). `npm ci` only
      // clears node_modules, so .eveland/ survives into the compiled output.
      const injection = await injectSandboxModules({ releaseDir, backendDistDir: config.backendDistDir });
      const cacheDir = projectCacheDir(input.projectId);
      // The service user runs unprivileged under ProtectSystem=strict and cannot
      // create this directory itself, so build time (running as this process's
      // own, more privileged user) must create and hand it over.
      await mkdir(cacheDir, { recursive: true });

      const command = buildReleaseBuildCommand(input.commandContext);
      const execution =
        config.buildSandbox === "bwrap"
          ? await execa("bwrap", buildBwrapArgs({ releaseDir, npmCacheDir, dataDir, command }), {
              all: true,
              env: { npm_config_cache: npmCacheDir },
            })
          : await execa("sh", ["-lc", command], {
              all: true,
              cwd: releaseDir,
              env: { npm_config_cache: npmCacheDir },
            });

      // The unit's fixed service user needs to own the release dir: eve's default
      // local workflow world writes .workflow-data/ into the working directory.
      await execa("chown", ["-R", `${config.user}:`, releaseDir]);
      await execa("chown", ["-R", `${config.user}:`, cacheDir]);

      const injectionLog = [
        `Injected eve sandbox modules: ${injection.generated.join(", ") || "none"}`,
        ...(injection.replaced.length
          ? [
              `WARNING: replaced the project's authored sandbox (${injection.replaced.join(", ")}). ` +
                "eveland selects the sandbox backend; the module's bootstrap(), onSession() and workspace seeds are NOT used.",
            ]
          : []),
      ].join("\n");
      return { releaseRef: releaseDir, log: `${injectionLog}\n${execution.all ?? ""}` };
    },
    async startProcess(input: ProcessStartInput): Promise<ProcessStartResult> {
      await mkdir(envDir, { recursive: true });
      const envFilePath = path.join(envDir, `${input.processName}.env`);
      await writeFile(envFilePath, buildEnvFileContent(input.env), { mode: 0o600 });

      const result = await execa(
        "systemd-run",
        buildSystemdRunArgs({
          unitName: input.processName,
          releaseDir: input.releaseRef,
          envFilePath,
          port: input.port,
          user: config.user,
          memoryMax: config.memoryMax,
          cpuQuota: config.cpuQuota,
          sandboxCacheDir: input.sandboxCacheDir,
          command: buildSystemdStartCommand(input.commandContext, input.port),
        }),
        { all: true },
      );
      return { internalPort: input.port, log: result.all ?? "" };
    },
    async stopProcess(processName: string): Promise<void> {
      await execa("systemctl", ["stop", `${processName}.service`], { reject: false });
      await execa("systemctl", ["reset-failed", `${processName}.service`], { reject: false });
      // Secrets are decrypted onto disk for systemd's EnvironmentFile; delete them once the
      // unit is stopped instead of leaving plaintext behind indefinitely. Release-dir reaping
      // is out of scope (accepted disk hygiene debt) -- this only covers the env file.
      await rm(path.join(envDir, `${processName}.env`), { force: true });
    },
  };
}
