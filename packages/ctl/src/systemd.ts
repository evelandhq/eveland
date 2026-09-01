import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadPlatformEnvFile } from "./env-file.ts";
import { readInstallMetadata } from "./home.ts";
import type { LifecycleIo } from "./io.ts";
import { resolveLifecycle, runStop } from "./lifecycle.ts";
import { PLATFORM_PROCESSES, systemdUnitName, type ProcessSpec } from "./processes.ts";
import { writeInstallMetadata } from "./bootstrap.ts";

/**
 * `eveland-ctl install --systemd`: promote a Linux install from the ctl's
 * own supervisor to systemd system services — the production default. One
 * unit per platform process, all reading the single etc/eveland.env, unit
 * names converging with the long-documented eveland-worker /
 * eveland-workflow-dispatcher services. After this, start/stop/status
 * delegate to systemctl.
 */

export const SYSTEMD_UNIT_DIR = "/etc/systemd/system";

export function renderUnit(
  spec: ProcessSpec,
  options: { sourceDir: string; envFilePath: string; nodeBinDir: string },
): string {
  const execArgs = spec.argv.slice(1).join(" ");
  return [
    "[Unit]",
    `Description=Eveland ${spec.label}`,
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=exec",
    // Root matches the documented production posture: the worker drives
    // systemd-run/systemctl/chown, and every deployed Agent still runs under
    // its own unprivileged DynamicUser.
    "User=root",
    `WorkingDirectory=${path.join(options.sourceDir, spec.dir)}`,
    `EnvironmentFile=${options.envFilePath}`,
    `Environment=PATH=${options.nodeBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `ExecStart=/usr/bin/env pnpm ${execArgs}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export async function runInstallCommand(args: string[], io: LifecycleIo): Promise<number> {
  const parsed = parseArgs({
    args,
    options: { systemd: { type: "boolean" } },
    allowPositionals: false,
  });
  if (!parsed.values.systemd) {
    io.stderr("Usage: eveland-ctl install --systemd");
    io.stderr(
      "(Installing the platform itself is `curl -fsSL https://eveland.ai/install.sh | bash`.)",
    );
    return 1;
  }
  const resolved = resolveLifecycle(io);
  if (resolved.platform !== "linux") {
    io.stderr("systemd installation is Linux-only; macOS stays on the ctl supervisor.");
    return 1;
  }
  const getuid = (io as { getuid?: () => number }).getuid ?? process.getuid;
  if (getuid && getuid() !== 0) {
    io.stderr("Installing systemd units needs root. Re-run with sudo.");
    return 1;
  }
  const metadata = await readInstallMetadata(resolved.layout);
  if (!metadata?.bootstrapCompleted) {
    io.stderr("No completed installation found. Run `eveland-ctl start` first.");
    return 1;
  }
  const envFile = await loadPlatformEnvFile({
    env: io.env,
    repoRoot: resolved.repoRootDir,
    platform: resolved.platform,
  });
  if (!envFile) {
    io.stderr(`No configuration at ${resolved.layout.envFilePath}.`);
    return 1;
  }

  // The ctl supervisor and the units must never both own the processes.
  await runStop([], io);

  const nodeBinDir = envFile.values.EVELAND_NODE
    ? path.dirname(envFile.values.EVELAND_NODE)
    : path.dirname(process.execPath);
  const unitDir = (io as { systemdUnitDir?: string }).systemdUnitDir ?? SYSTEMD_UNIT_DIR;
  for (const spec of PLATFORM_PROCESSES) {
    const unitPath = path.join(unitDir, systemdUnitName(spec.key));
    await writeFile(
      unitPath,
      renderUnit(spec, {
        sourceDir: resolved.repoRootDir,
        envFilePath: envFile.path,
        nodeBinDir,
      }),
      "utf8",
    );
    io.stdout(`Wrote ${unitPath}`);
  }

  const reload = await resolved.execCommand(["systemctl", "daemon-reload"], {
    cwd: resolved.repoRootDir,
  });
  if (reload.code !== 0) {
    io.stderr(`systemctl daemon-reload failed:\n${reload.output.trim()}`);
    return 1;
  }
  for (const spec of PLATFORM_PROCESSES) {
    const enable = await resolved.execCommand(
      ["systemctl", "enable", "--now", systemdUnitName(spec.key)],
      { cwd: resolved.repoRootDir },
    );
    if (enable.code !== 0) {
      io.stderr(`Enabling ${systemdUnitName(spec.key)} failed:\n${enable.output.trim()}`);
      return 1;
    }
    io.stdout(`Enabled ${systemdUnitName(spec.key)}`);
  }

  await writeInstallMetadata(resolved.layout, { ...metadata, supervision: "systemd" });
  io.stdout("");
  io.stdout("The platform now runs as systemd services and restarts with the machine.");
  io.stdout("`eveland-ctl start/stop/restart/status` delegate to systemctl from here on.");
  return 0;
}
