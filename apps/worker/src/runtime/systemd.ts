import { execa } from "execa";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferEveRuntimeCommand } from "@eveland/shared/runtime";
import type { ProcessStartInput, ProcessStartResult, ReleaseBuildInput, ReleaseBuildResult, RuntimeAdapter, RuntimeCommandContext } from "./types.js";

export type SystemdStartInput = {
  unitName: string;
  releaseDir: string;
  envFilePath: string;
  port: number;
  user: string;
  memoryMax: string;
  cpuQuota: string;
  command: string;
};

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
    `--property=MemoryMax=${input.memoryMax}`,
    `--property=CPUQuota=${input.cpuQuota}`,
    "--property=ProtectSystem=strict",
    `--property=ReadWritePaths=${input.releaseDir}`,
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
};

export function createSystemdAdapter(config: SystemdAdapterConfig): RuntimeAdapter {
  const dataDir = path.resolve(config.dataDir);
  const npmCacheDir = path.resolve(dataDir, "npm-cache");
  const envDir = path.resolve(dataDir, "deployment-env");

  return {
    name: "systemd",
    async buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult> {
      const releaseDir = path.resolve(input.buildDir);
      await mkdir(releaseDir, { recursive: true });
      await mkdir(npmCacheDir, { recursive: true });
      await execa("cp", ["-a", `${path.resolve(input.sourcePath)}/.`, releaseDir]);

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
      return { releaseRef: releaseDir, log: execution.all ?? "" };
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
