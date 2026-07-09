import { inferEveRuntimeCommand } from "@eveland/shared/runtime";
import type { RuntimeCommandContext } from "./types.js";

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
  command: string;
};

export function buildBwrapArgs(input: BwrapBuildInput): string[] {
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
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
