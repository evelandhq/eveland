import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlatformEnvFile } from "./env-file.ts";
import { readInstallMetadata, type ApplianceLayout } from "./home.ts";
import { writeInstallMetadata } from "./bootstrap.ts";
import type { ExecCommand, FetchLike, LifecycleIo } from "./io.ts";
import { PLATFORM_PROCESSES, systemdUnitName } from "./processes.ts";

/**
 * The Linux production form — the same topology docs/en/production documents,
 * orchestrated by the ctl instead of by hand:
 *
 * - Core services (API, Agent Gateway, Dashboard) and infra run in Docker
 *   Compose with the production overlay: the containers ARE the privilege
 *   boundary, exactly as the deployment docs prescribe. No public-facing
 *   process runs as a host root process, and none can read the host source
 *   tree or data dir beyond its explicit binds.
 * - Exactly two systemd units exist, converging with the long-documented
 *   ones: eveland-worker (root on purpose — it drives systemd-run/systemctl/
 *   chown; every deployed Agent still gets its own unprivileged DynamicUser)
 *   and eveland-workflow-dispatcher (DynamicUser, reading a NARROWED env
 *   file carrying only what its documented env.example carries — never the
 *   admin password or APP_SECRET_KEY).
 *
 * On Linux this is the first-boot default; `install --systemd` promotes an
 * older or --foreground install onto it. This module is a leaf so both the
 * lifecycle and the install command can share it.
 */

export const SYSTEMD_UNIT_DIR = "/etc/systemd/system";

/** The two host units. Core services deliberately have none. */
export const SYSTEMD_HOST_UNITS = ["worker", "workflow-dispatcher"] as const;

/** Core services managed through Compose in the systemd form. */
export const COMPOSE_CORE_SERVICES = ["api", "gateway", "web"] as const;

export const SYSTEMD_READINESS_DEADLINE_MS = 300_000;
export const SYSTEMD_READINESS_POLL_MS = 500;

export type SystemdModeContext = {
  io: LifecycleIo;
  layout: ApplianceLayout;
  repoRootDir: string;
  execCommand: ExecCommand;
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
};

/**
 * The dispatcher's env allowlist, mirroring
 * infra/systemd/eveland-workflow-dispatcher.env.example: release identity,
 * the workflow world, activation, the runtime secret, and OTLP. Nothing
 * else from etc/eveland.env — least privilege for the DynamicUser service.
 */
export const DISPATCHER_ENV_KEYS = [
  "NODE_ENV",
  "EVELAND_RELEASE_CHANNEL",
  "EVELAND_REVISION",
  "EVELAND_WORKFLOW_WORLD_URL",
  "EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL",
  "EVELAND_WORKFLOW_STREAM_COMPACTION",
  "WORKFLOW_DISPATCHER_ACTIVATION_API_URL",
  "WORKFLOW_DISPATCHER_ACTIVATION_TOKEN",
  "EVELAND_SCHEDULER_RUNTIME_SECRET",
  "EVELAND_OTLP_ENDPOINT",
  "EVELAND_OTLP_SERVICE_TOKEN",
];

export function dispatcherEnvFilePath(etcDir: string): string {
  return path.join(etcDir, "eveland-workflow-dispatcher.env");
}

export function applianceOverlayPath(etcDir: string): string {
  return path.join(etcDir, "compose.appliance.yml");
}

/** Compose invocation for the appliance production stack (base + prod + appliance overlay). */
export function applianceComposeArgs(layout: ApplianceLayout, ...rest: string[]): string[] {
  return [
    "docker",
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.prod.yml",
    "-f",
    applianceOverlayPath(layout.etcDir),
    "--env-file",
    layout.envFilePath,
    ...rest,
  ];
}

export function renderDispatcherEnv(values: Record<string, string>): string {
  const lines = [
    "# Rendered by eveland-ctl. The workflow dispatcher's OWN environment:",
    "# the allowlisted subset of etc/eveland.env its documented env.example",
    "# carries. The DynamicUser service never sees the rest.",
    "",
  ];
  for (const key of DISPATCHER_ENV_KEYS) {
    const value = values[key];
    if (value !== undefined && value !== "") lines.push(`${key}=${value}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderWorkerUnit(options: {
  sourceDir: string;
  envFilePath: string;
  nodeBinDir: string;
}): string {
  return [
    "[Unit]",
    "Description=eveland worker (systemd runtime)",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=exec",
    "# Root on purpose: the worker drives systemd-run, systemctl and chown.",
    "# Each deployed Agent runs under its own unprivileged systemd DynamicUser.",
    "User=root",
    `WorkingDirectory=${path.join(options.sourceDir, "apps/worker")}`,
    `EnvironmentFile=${options.envFilePath}`,
    `Environment=PATH=${options.nodeBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    "ExecStart=/usr/bin/env pnpm exec tsx src/worker.ts",
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function renderDispatcherUnit(options: {
  sourceDir: string;
  etcDir: string;
  nodeBinDir: string;
}): string {
  return [
    "[Unit]",
    "Description=eveland workflow dispatcher",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=exec",
    "# Unprivileged on purpose: unlike the worker this never drives systemd or",
    "# touches deployment files. It talks to Postgres and to loopback HTTP only,",
    "# and it must never load tenant code.",
    "DynamicUser=yes",
    `WorkingDirectory=${path.join(options.sourceDir, "apps/workflow-dispatcher")}`,
    `EnvironmentFile=${dispatcherEnvFilePath(options.etcDir)}`,
    `Environment=PATH=${options.nodeBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    "ExecStart=/usr/bin/env pnpm exec tsx src/main.ts",
    "Restart=on-failure",
    "RestartSec=5",
    "# A crash loop burns one restart every RestartSec; cap it so a broken",
    "# config surfaces as a failed unit instead of an infinite loop.",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * The appliance Compose overlay, applied on top of docker-compose.prod.yml:
 * repoints the hardcoded /var/lib/eveland binds at the appliance data dir,
 * derives the public scheme/port from the configured origin instead of the
 * overlay's https assumption, masks node_modules and the Dashboard build
 * with named volumes (the host checkout carries a NATIVE install for the
 * ctl/worker; the alpine containers must never write their musl artifacts
 * into it), and keeps worker/dispatcher out of Compose entirely — they are
 * the two host units.
 */
export function renderApplianceOverlay(options: { dataDir: string; publicOrigin: string }): string {
  const origin = new URL(options.publicOrigin);
  const scheme = origin.protocol.replace(":", "");
  const publicPort = origin.port === "" ? "0" : origin.port;
  return [
    "# Rendered by eveland-ctl. Appliance adjustments on top of",
    "# docker-compose.prod.yml — see packages/ctl/src/systemd-mode.ts.",
    "services:",
    "  api:",
    "    volumes: !override",
    "      - .:/workspace",
    "      - eveland-appliance-api-node-modules:/workspace/node_modules",
    `      - ${options.dataDir}:${options.dataDir}`,
    "    environment:",
    `      EVELAND_DATA_DIR: ${options.dataDir}`,
    `      EVELAND_GATEWAY_PUBLIC_SCHEME: ${scheme}`,
    `      EVELAND_GATEWAY_PUBLIC_PORT: "${publicPort}"`,
    "  gateway:",
    "    volumes: !override",
    "      - .:/workspace",
    "      - eveland-appliance-gateway-node-modules:/workspace/node_modules",
    "      - eveland-gateway-data-mask:/workspace/.eveland-data",
    "    environment:",
    `      EVELAND_GATEWAY_PUBLIC_SCHEME: ${scheme}`,
    "  web:",
    "    volumes: !override",
    "      - .:/workspace",
    "      - eveland-appliance-web-node-modules:/workspace/node_modules",
    "      - eveland-appliance-web-next:/workspace/apps/web/.next",
    "  otel-config-init:",
    "    volumes: !override",
    "      - ./infra/otel/collector.yaml:/seed/collector.yaml:ro",
    `      - ${options.dataDir}/otel:/var/lib/eveland/otel`,
    "  otel-collector:",
    "    volumes: !override",
    `      - ${options.dataDir}/otel:/var/lib/eveland/otel:ro`,
    "      - eveland-otel-collector:/var/lib/otelcol",
    "volumes:",
    "  # One node_modules volume PER service: their in-container installs run",
    "  # concurrently and must never share a store.",
    "  eveland-appliance-api-node-modules:",
    "  eveland-appliance-gateway-node-modules:",
    "  eveland-appliance-web-node-modules:",
    "  eveland-appliance-web-next:",
    "",
  ].join("\n");
}

/**
 * Writes the two units, the dispatcher's narrowed env file, and the
 * appliance Compose overlay; reloads systemd and enables (without starting)
 * the units; records systemd supervision in install.json. Starting is
 * `startViaSystemd`'s job so first boot and promotion share one path.
 */
export async function installSystemdArtifacts(
  context: SystemdModeContext,
  envFile: PlatformEnvFile,
): Promise<number> {
  const { io, layout } = context;
  const nodeBinDir = envFile.values.EVELAND_NODE
    ? path.dirname(envFile.values.EVELAND_NODE)
    : path.dirname(process.execPath);
  const unitDir = (io as { systemdUnitDir?: string }).systemdUnitDir ?? SYSTEMD_UNIT_DIR;
  const writeTextFile =
    io.writeTextFile ??
    (async (filePath: string, content: string) => writeFile(filePath, content, "utf8"));

  const dispatcherEnv = dispatcherEnvFilePath(layout.etcDir);
  await writeTextFile(dispatcherEnv, renderDispatcherEnv(envFile.values));
  await chmod(dispatcherEnv, 0o600).catch(() => {});
  io.stdout(`Wrote ${dispatcherEnv} (dispatcher-only environment)`);

  const overlay = applianceOverlayPath(layout.etcDir);
  await writeTextFile(
    overlay,
    renderApplianceOverlay({
      dataDir: envFile.values.EVELAND_DATA_DIR ?? path.join(layout.root, "data"),
      publicOrigin: envFile.values.EVELAND_PUBLIC_ORIGIN ?? "http://localhost",
    }),
  );
  io.stdout(`Wrote ${overlay}`);

  await writeTextFile(
    path.join(unitDir, systemdUnitName("worker")),
    renderWorkerUnit({
      sourceDir: context.repoRootDir,
      envFilePath: layout.envFilePath,
      nodeBinDir,
    }),
  );
  await writeTextFile(
    path.join(unitDir, systemdUnitName("workflow-dispatcher")),
    renderDispatcherUnit({ sourceDir: context.repoRootDir, etcDir: layout.etcDir, nodeBinDir }),
  );
  io.stdout(`Wrote ${path.join(unitDir, systemdUnitName("worker"))}`);
  io.stdout(`Wrote ${path.join(unitDir, systemdUnitName("workflow-dispatcher"))}`);

  const reload = await context.execCommand(["systemctl", "daemon-reload"], {
    cwd: context.repoRootDir,
  });
  if (reload.code !== 0) {
    io.stderr(`systemctl daemon-reload failed:\n${reload.output.trim()}`);
    return 1;
  }
  for (const key of SYSTEMD_HOST_UNITS) {
    const enable = await context.execCommand(["systemctl", "enable", systemdUnitName(key)], {
      cwd: context.repoRootDir,
    });
    if (enable.code !== 0) {
      io.stderr(`Enabling ${systemdUnitName(key)} failed:\n${enable.output.trim()}`);
      return 1;
    }
  }

  const metadata = await readInstallMetadata(layout);
  if (metadata) {
    await writeInstallMetadata(layout, { ...metadata, supervision: "systemd" });
  }
  return 0;
}

async function probeReady(fetchImpl: FetchLike, url: string): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Compose up (infra + core) + systemctl start + readiness. */
export async function startViaSystemd(
  context: SystemdModeContext,
  options: { skipInfra?: boolean } = {},
): Promise<number> {
  const { io, layout } = context;
  const services = options.skipInfra
    ? [...COMPOSE_CORE_SERVICES]
    : ["postgres", "otel-collector", ...COMPOSE_CORE_SERVICES];
  io.stdout("Starting the Compose services (this runs their in-container install)...");
  const up = await context.execCommand(applianceComposeArgs(layout, "up", "-d", ...services), {
    cwd: context.repoRootDir,
  });
  if (up.code !== 0) {
    io.stderr(`docker compose up failed:\n${up.output.trim()}`);
    return 1;
  }
  for (const key of SYSTEMD_HOST_UNITS) {
    const result = await context.execCommand(["systemctl", "start", systemdUnitName(key)], {
      cwd: context.repoRootDir,
    });
    if (result.code !== 0) {
      io.stderr(`systemctl start ${systemdUnitName(key)} failed:\n${result.output.trim()}`);
      return 1;
    }
  }
  const hostUnitKeys = new Set<string>(SYSTEMD_HOST_UNITS);
  const ready = new Set<string>();
  for (
    let waited = 0;
    waited <= SYSTEMD_READINESS_DEADLINE_MS;
    waited += SYSTEMD_READINESS_POLL_MS
  ) {
    for (const spec of PLATFORM_PROCESSES) {
      if (ready.has(spec.key)) continue;
      if (spec.readinessUrl) {
        if (await probeReady(context.fetchImpl, spec.readinessUrl)) {
          ready.add(spec.key);
          io.stdout(`  ${spec.label} is ready`);
        }
      } else if (hostUnitKeys.has(spec.key)) {
        const active = await context.execCommand(
          ["systemctl", "is-active", systemdUnitName(spec.key)],
          { cwd: context.repoRootDir },
        );
        if (active.output.trim() === "active") {
          ready.add(spec.key);
          io.stdout(`  ${spec.label} is running`);
        }
      }
    }
    if (ready.size === PLATFORM_PROCESSES.length) return 0;
    await context.sleep(SYSTEMD_READINESS_POLL_MS);
  }
  const missing = PLATFORM_PROCESSES.filter((spec) => !ready.has(spec.key)).map((s) => s.label);
  io.stderr(
    `Timed out waiting for: ${missing.join(", ")}. ` +
      "Check `docker compose ps`, `systemctl status eveland-worker eveland-workflow-dispatcher`, " +
      "and `journalctl -u eveland-worker`.",
  );
  return 1;
}

/** systemctl stop for the two units + compose stop for the core services. */
export async function stopViaSystemd(context: SystemdModeContext): Promise<number> {
  const { io, layout } = context;
  let failed = false;
  for (const key of SYSTEMD_HOST_UNITS) {
    const result = await context.execCommand(["systemctl", "stop", systemdUnitName(key)], {
      cwd: context.repoRootDir,
    });
    if (result.code !== 0) {
      io.stderr(`systemctl stop ${systemdUnitName(key)} failed:\n${result.output.trim()}`);
      failed = true;
    }
  }
  const stop = await context.execCommand(
    applianceComposeArgs(layout, "stop", ...COMPOSE_CORE_SERVICES),
    { cwd: context.repoRootDir },
  );
  if (stop.code !== 0) {
    io.stderr(`docker compose stop failed:\n${stop.output.trim()}`);
    failed = true;
  }
  if (!failed) {
    io.stdout("Stopped the platform. Infrastructure containers keep running.");
  }
  return failed ? 1 : 0;
}
