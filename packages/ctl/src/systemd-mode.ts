import { access, chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlatformEnvFile } from "./env-file.ts";
import { readInstallMetadata, type ApplianceLayout } from "./home.ts";
import { writeInstallMetadata } from "./bootstrap.ts";
import type { ExecCommand, FetchLike, LifecycleIo } from "./io.ts";
import { GATEWAY_PORT } from "@evelandhq/core/ports";
import {
  PLATFORM_SERVICE_HOME,
  PLATFORM_SERVICE_USER,
  refreshSystemToolchain,
} from "./linux-host.ts";
import {
  directExecArgv,
  PLATFORM_PROCESSES,
  processByKey,
  systemdUnitName,
  type ProcessKey,
  type ProcessSpec,
} from "./processes.ts";

/**
 * The Linux production form — the same topology docs/en/production documents,
 * orchestrated by the ctl instead of by hand.
 *
 * Every platform process that has a listener or a job to do runs on the host
 * under systemd; Docker holds only what genuinely wants to be a container.
 * The privilege boundary is the unit, not the image: `DynamicUser` or a fixed
 * unprivileged system user, `ProtectSystem=strict` over a read-only source
 * tree, and an explicit `ReadWritePaths` per service. That is strictly
 * stronger than the containerized form it replaces, where each service ran as
 * container root with the whole host source tree bind-mounted in.
 *
 * The worker is the one deliberate exception: it must be root, because it
 * drives systemd-run, systemctl and chown to give every deployed Agent its
 * OWN unprivileged DynamicUser.
 */

export const SYSTEMD_UNIT_DIR = "/etc/systemd/system";

/**
 * Platform processes supervised as host systemd units, in start order.
 * `COMPOSE_CORE_SERVICES` holds the remainder; the two lists together must
 * cover `PLATFORM_PROCESSES` exactly, which `systemd.test.ts` asserts.
 */
export const SYSTEMD_HOST_UNITS = ["gateway", "web", "worker", "workflow-dispatcher"] as const;

/** Core services still managed through Compose in the systemd form. */
export const COMPOSE_CORE_SERVICES = ["api"] as const;

/**
 * Compose services this form used to run and no longer does, with the profile
 * that now hides each from the merged production configuration. A promotion
 * (or an update) must actively remove their containers: a leftover Dashboard
 * container still holds the Dashboard's port, and the host unit taking over
 * would fail to bind.
 */
export const RETIRED_COMPOSE_SERVICES: ReadonlyArray<{ service: string; profile: string }> = [
  { service: "gateway", profile: "dev-gateway" },
  { service: "web", profile: "dev-web" },
];

// Generous on purpose while the API still runs a container install of its own
// on first `compose up`. The host units themselves are ready in seconds.
export const SYSTEMD_READINESS_DEADLINE_MS = 900_000;
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

/**
 * The public Agent Gateway's env allowlist — exactly the variables the
 * compose service definitions handed it. Never the admin password,
 * APP_SECRET_KEY, BETTER_AUTH_SECRET, or model API keys: a public proxy's
 * trust boundary must not contain them.
 */
export const GATEWAY_ENV_KEYS = [
  "NODE_ENV",
  "EVELAND_RELEASE_CHANNEL",
  "EVELAND_REVISION",
  "DATABASE_URL",
  "EVELAND_AGENT_BASE_DOMAINS",
  "EVELAND_GATEWAY_SERVICE_TOKEN",
  "EVELAND_GATEWAY_AFFINITY_SECRET",
  "EVELAND_GATEWAY_MAX_REQUEST_BODY_BYTES",
  "EVELAND_GATEWAY_PUBLIC_SCHEME",
  "EVELAND_API_INTERNAL_URL",
  "EVELAND_WEB_INTERNAL_URL",
  "EVELAND_OTLP_ENDPOINT",
  "EVELAND_OTLP_SERVICE_TOKEN",
  "EVELAND_ACTIVATION_RENEW_INTERVAL_MS",
  "EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS",
  "EVELAND_API_SESSION_IDLE_TTL_MS",
];

/** The Dashboard's env allowlist (it only talks to the API). */
export const WEB_ENV_KEYS = ["NODE_ENV", "EVELAND_RELEASE_CHANNEL", "EVELAND_REVISION", "API_URL"];

/** `etc/eveland-<service>.env` — a unit's own environment. */
export function serviceEnvFilePath(etcDir: string, service: string): string {
  return path.join(etcDir, `eveland-${service}.env`);
}

export function dispatcherEnvFilePath(etcDir: string): string {
  return serviceEnvFilePath(etcDir, "workflow-dispatcher");
}

export function gatewayEnvFilePath(etcDir: string): string {
  return serviceEnvFilePath(etcDir, "gateway");
}

export function webEnvFilePath(etcDir: string): string {
  return serviceEnvFilePath(etcDir, "web");
}

/**
 * Values no operator writes and every host-native unit needs: the front
 * door's advertised scheme and port, derived from the one origin the
 * installation was configured with. The containerized form injected these
 * through Compose; a unit gets them here.
 */
export function derivedServiceValues(values: Record<string, string>): Record<string, string> {
  const origin = new URL(
    values.EVELAND_PUBLIC_ORIGIN?.trim() || `http://localhost:${GATEWAY_PORT}`,
  );
  const scheme = origin.protocol.replace(":", "");
  return {
    EVELAND_GATEWAY_PUBLIC_SCHEME: scheme,
    // "0" means "the scheme's default port": an https origin with no explicit
    // port must not advertise the front door's bind port.
    EVELAND_GATEWAY_PUBLIC_PORT: origin.port === "" ? "0" : origin.port,
  };
}

export function renderServiceEnv(
  service: string,
  keys: readonly string[],
  values: Record<string, string>,
): string {
  const lines = [
    `# Rendered by eveland-ctl on every start. The ${service} service's OWN`,
    "# environment: the allowlisted subset of etc/eveland.env its systemd unit",
    "# reads. Nothing else from the platform configuration reaches this process.",
    "# Edit etc/eveland.env, not this file.",
    "",
  ];
  for (const key of keys) {
    const value = values[key];
    if (value !== undefined && value !== "") lines.push(`${key}=${value}`);
  }
  lines.push("");
  return lines.join("\n");
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
  return renderServiceEnv("workflow-dispatcher", DISPATCHER_ENV_KEYS, values);
}

export type UnitRenderOptions = {
  /** The checkout the units run from. */
  sourceDir: string;
  etcDir: string;
  /** Absolute EVELAND_DATA_DIR; the only tree the API writes outside its own home. */
  dataDir: string;
  /** etc/eveland.env — the full configuration, read only by the worker. */
  envFilePath: string;
  nodeBinDir: string;
};

type UnitIdentity = "root" | "dynamic-user" | "platform-user";

type UnitProfile = {
  identity: UnitIdentity;
  /** Why this identity and not a weaker one; rendered into the unit. */
  rationale: string[];
  envFile: (options: UnitRenderOptions) => string;
  /**
   * Absolute paths this unit must write under `ProtectSystem=strict`. Only
   * meaningful for the platform-user identity; root is unconfined and
   * DynamicUser gets its own sandbox.
   */
  readWritePaths?: (options: UnitRenderOptions) => string[];
  environment?: (options: UnitRenderOptions) => string[];
};

const UNIT_PROFILES: Record<ProcessKey, UnitProfile> = {
  api: {
    identity: "platform-user",
    rationale: [
      "# Unprivileged: the API extracts operator-supplied zip archives and is",
      "# the one process reachable (behind the front door) from a browser. It",
      "# writes nothing outside its data dir.",
    ],
    envFile: (options) => serviceEnvFilePath(options.etcDir, "api"),
    readWritePaths: (options) => [options.dataDir],
  },
  gateway: {
    identity: "platform-user",
    rationale: [
      "# Unprivileged: this is the installation's only public listener. It",
      "# proxies and writes nothing to disk at all.",
    ],
    envFile: (options) => gatewayEnvFilePath(options.etcDir),
  },
  web: {
    identity: "platform-user",
    rationale: ["# Unprivileged: the Dashboard serves a build and proxies to the API."],
    envFile: (options) => webEnvFilePath(options.etcDir),
    // `next start` writes .next/cache (and .next/trace) at runtime; under
    // ProtectSystem=strict the whole checkout is read-only without this, and
    // the server dies on its first cache write.
    readWritePaths: (options) => [path.join(options.sourceDir, "apps/web/.next")],
    environment: () => [
      // No writable config dir to phone home from, and nothing to send.
      "Environment=NEXT_TELEMETRY_DISABLED=1",
    ],
  },
  worker: {
    identity: "root",
    rationale: [
      "# Root on purpose: the worker drives systemd-run, systemctl and chown.",
      "# Each deployed Agent runs under its own unprivileged systemd DynamicUser.",
    ],
    envFile: (options) => options.envFilePath,
  },
  "workflow-dispatcher": {
    identity: "dynamic-user",
    rationale: [
      "# Unprivileged on purpose: unlike the worker this never drives systemd or",
      "# touches deployment files. It talks to Postgres and to loopback HTTP only,",
      "# and it must never load tenant code.",
    ],
    envFile: (options) => dispatcherEnvFilePath(options.etcDir),
  },
};

function identityLines(profile: UnitProfile, options: UnitRenderOptions): string[] {
  switch (profile.identity) {
    case "root":
      return [...profile.rationale, "User=root"];
    case "dynamic-user":
      // DynamicUser implies ProtectSystem=strict, PrivateTmp and friends.
      return [...profile.rationale, "DynamicUser=yes"];
    case "platform-user": {
      const readWrite = [PLATFORM_SERVICE_HOME, ...(profile.readWritePaths?.(options) ?? [])];
      return [
        ...profile.rationale,
        `User=${PLATFORM_SERVICE_USER}`,
        `Group=${PLATFORM_SERVICE_USER}`,
        // A real home: corepack, npm and Next all fall back to $HOME, and
        // DynamicUser's HOME=/ is exactly what breaks them.
        `Environment=HOME=${PLATFORM_SERVICE_HOME}`,
        "NoNewPrivileges=yes",
        "PrivateTmp=yes",
        // The checkout, /etc and everything else become read-only; only the
        // paths below are writable. This is the boundary the containerized
        // form claimed and did not have.
        "ProtectSystem=strict",
        "ProtectHome=read-only",
        "ProtectKernelTunables=yes",
        "ProtectControlGroups=yes",
        "RestrictSUIDSGID=yes",
        `ReadWritePaths=${readWrite.join(" ")}`,
      ];
    }
  }
}

/**
 * One renderer for every platform unit. The command comes from
 * `PLATFORM_PROCESSES` — never retyped here — so a unit and a ctl-supervised
 * child can never drift apart.
 */
export function renderPlatformUnit(spec: ProcessSpec, options: UnitRenderOptions): string {
  const profile = UNIT_PROFILES[spec.key];
  const after = ["network-online.target"];
  return [
    "[Unit]",
    `Description=eveland ${spec.label}`,
    "Wants=network-online.target",
    `After=${after.join(" ")}`,
    "",
    "[Service]",
    "Type=exec",
    ...identityLines(profile, options),
    `WorkingDirectory=${path.join(options.sourceDir, spec.dir)}`,
    `EnvironmentFile=${profile.envFile(options)}`,
    // The pinned interpreter leads PATH: workspace binaries are `#!/usr/bin/env
    // node` shebangs, and a unit environment carries no shell profile.
    `Environment=PATH=${options.nodeBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ...(profile.environment?.(options) ?? []),
    // The workspace binary directly, never `pnpm exec`: corepack's pnpm shim
    // wants a writable HOME cache that a unit environment does not guarantee.
    `ExecStart=${directExecArgv(options.sourceDir, spec).join(" ")}`,
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

function unitRenderOptions(
  context: SystemdModeContext,
  envFile: PlatformEnvFile,
  nodeBinDir: string,
): UnitRenderOptions {
  return {
    sourceDir: context.repoRootDir,
    etcDir: context.layout.etcDir,
    dataDir: envFile.values.EVELAND_DATA_DIR ?? context.layout.dataDir,
    envFilePath: context.layout.envFilePath,
    nodeBinDir,
  };
}

/**
 * The appliance Compose overlay, applied on top of docker-compose.prod.yml:
 * repoints the hardcoded /var/lib/eveland binds at the appliance data dir,
 * derives the public scheme/port from the configured origin instead of the
 * overlay's https assumption, and masks the API container's node_modules with
 * a named volume (the host checkout carries a NATIVE install for the ctl and
 * the host units; the alpine container must never write its musl artifacts
 * into it).
 */
export function renderApplianceOverlay(options: {
  dataDir: string;
  publicOrigin: string;
  /** Full configuration — the API's; it seeds the admin and holds the app secret. */
  envFilePath: string;
}): string {
  const derived = derivedServiceValues({ EVELAND_PUBLIC_ORIGIN: options.publicOrigin });
  return [
    "# Rendered by eveland-ctl. Appliance adjustments on top of",
    "# docker-compose.prod.yml — see packages/ctl/src/systemd-mode.ts.",
    "services:",
    "  api:",
    "    volumes: !override",
    "      - .:/workspace",
    // The prod commands load /workspace/.env at runtime (tsx --env-file);
    // an appliance keeps its config in etc/, so bind it to that path.
    `      - ${options.envFilePath}:/workspace/.env:ro`,
    "      - eveland-appliance-api-node-modules:/workspace/node_modules",
    `      - ${options.dataDir}:${options.dataDir}`,
    "    environment:",
    `      EVELAND_DATA_DIR: ${options.dataDir}`,
    `      EVELAND_GATEWAY_PUBLIC_SCHEME: ${derived.EVELAND_GATEWAY_PUBLIC_SCHEME}`,
    `      EVELAND_GATEWAY_PUBLIC_PORT: "${derived.EVELAND_GATEWAY_PUBLIC_PORT}"`,
    "  otel-config-init:",
    "    volumes: !override",
    "      - ./infra/otel/collector.yaml:/seed/collector.yaml:ro",
    `      - ${options.dataDir}/otel:/var/lib/eveland/otel`,
    "  otel-collector:",
    "    volumes: !override",
    `      - ${options.dataDir}/otel:/var/lib/eveland/otel:ro`,
    "      - eveland-otel-collector:/var/lib/otelcol",
    "volumes:",
    "  eveland-appliance-api-node-modules:",
    "",
  ].join("\n");
}

/**
 * Every unit's environment file, rendered fresh. This runs on every `start`,
 * not only at install: these files are DERIVED from etc/eveland.env, and an
 * operator who edits that file and restarts must see the change.
 */
export async function writeServiceEnvFiles(
  context: SystemdModeContext,
  envFile: PlatformEnvFile,
): Promise<void> {
  const { io, layout } = context;
  const values = { ...envFile.values, ...derivedServiceValues(envFile.values) };
  const writeTextFile =
    io.writeTextFile ??
    (async (filePath: string, content: string) => writeFile(filePath, content, "utf8"));
  const files: Array<{ service: string; keys: readonly string[]; label: string }> = [
    { service: "workflow-dispatcher", keys: DISPATCHER_ENV_KEYS, label: "dispatcher-only" },
    { service: "gateway", keys: GATEWAY_ENV_KEYS, label: "gateway-only" },
    { service: "web", keys: WEB_ENV_KEYS, label: "dashboard-only" },
  ];
  for (const { service, keys, label } of files) {
    const filePath = serviceEnvFilePath(layout.etcDir, service);
    await writeTextFile(filePath, renderServiceEnv(service, keys, values));
    await chmod(filePath, 0o600).catch(() => {});
    io.stdout(`Wrote ${filePath} (${label} environment)`);
  }
}

/**
 * Ownership the host units need before they can run, reconciled on every
 * start rather than once at install: an update rebuilds the Dashboard as
 * root, and the unprivileged Dashboard has to be able to write its cache
 * again afterwards.
 */
export async function reconcileHostOwnership(context: SystemdModeContext): Promise<number> {
  const { io } = context;
  const nextDir = path.join(context.repoRootDir, "apps/web/.next");
  const chown = await context.execCommand(
    ["chown", "-R", `${PLATFORM_SERVICE_USER}:${PLATFORM_SERVICE_USER}`, nextDir],
    { cwd: context.repoRootDir },
  );
  if (chown.code !== 0) {
    io.stderr(
      `Could not give ${PLATFORM_SERVICE_USER} ownership of ${nextDir}:\n${chown.output.trim()}`,
    );
    return 1;
  }
  return 0;
}

/**
 * Containers this form no longer runs. Removed actively, not left to the
 * operator: a leftover container still holds the port its host unit is about
 * to bind. Failures are reported and tolerated — on a fresh install there is
 * nothing to remove.
 */
async function removeRetiredComposeServices(context: SystemdModeContext): Promise<void> {
  if (RETIRED_COMPOSE_SERVICES.length === 0) return;
  const profiles = RETIRED_COMPOSE_SERVICES.flatMap(({ profile }) => ["--profile", profile]);
  const services = RETIRED_COMPOSE_SERVICES.map(({ service }) => service);
  const removed = await context.execCommand(
    applianceComposeArgs(context.layout, ...profiles, "rm", "--stop", "--force", ...services),
    { cwd: context.repoRootDir },
  );
  if (removed.code === 0) {
    context.io.stdout(`Removed the retired Compose services: ${services.join(", ")}.`);
  }
}

/**
 * Writes the units and their env files, reloads systemd and enables (without
 * starting) the units; records systemd supervision in install.json. Starting
 * is `startViaSystemd`'s job so first boot and promotion share one path.
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

  // The interpreter may have moved since provisioning (a Node repair, an
  // update): the system-PATH node links AND corepack's pnpm shim that
  // deployment units rely on follow the pin, exactly like the units below
  // bake the new bin dir in.
  await refreshSystemToolchain({
    execCommand: context.execCommand,
    fileExists: (filePath) =>
      access(filePath).then(
        () => true,
        () => false,
      ),
    nodeBinDir,
    repoRootDir: context.repoRootDir,
    stdout: io.stdout,
  });

  await writeServiceEnvFiles(context, envFile);

  const overlay = applianceOverlayPath(layout.etcDir);
  await writeTextFile(
    overlay,
    renderApplianceOverlay({
      dataDir: envFile.values.EVELAND_DATA_DIR ?? path.join(layout.root, "data"),
      publicOrigin: envFile.values.EVELAND_PUBLIC_ORIGIN ?? "http://localhost",
      envFilePath: layout.envFilePath,
    }),
  );
  io.stdout(`Wrote ${overlay}`);

  const options = unitRenderOptions(context, envFile, nodeBinDir);
  for (const key of SYSTEMD_HOST_UNITS) {
    const spec = processByKey(key);
    if (!spec) throw new Error(`No platform process named '${key}'.`);
    const unitPath = path.join(unitDir, systemdUnitName(key));
    await writeTextFile(unitPath, renderPlatformUnit(spec, options));
    io.stdout(`Wrote ${unitPath}`);
  }

  await removeRetiredComposeServices(context);

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
  io.stdout("Starting the Compose services...");
  const up = await context.execCommand(applianceComposeArgs(layout, "up", "-d", ...services), {
    cwd: context.repoRootDir,
  });
  if (up.code !== 0) {
    io.stderr(`docker compose up failed:\n${up.output.trim()}`);
    return 1;
  }
  const owned = await reconcileHostOwnership(context);
  if (owned !== 0) return owned;
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
      `Check \`docker compose ps\`, \`systemctl status ${SYSTEMD_HOST_UNITS.map(systemdUnitName).join(" ")}\`, ` +
      "and `journalctl -u eveland-worker`.",
  );
  return 1;
}

/** systemctl stop for the host units + compose stop for the core services. */
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
  if (COMPOSE_CORE_SERVICES.length > 0) {
    const stop = await context.execCommand(
      applianceComposeArgs(layout, "stop", ...COMPOSE_CORE_SERVICES),
      { cwd: context.repoRootDir },
    );
    if (stop.code !== 0) {
      io.stderr(`docker compose stop failed:\n${stop.output.trim()}`);
      failed = true;
    }
  }
  if (!failed) {
    io.stdout("Stopped the platform. Infrastructure containers keep running.");
  }
  return failed ? 1 : 0;
}
