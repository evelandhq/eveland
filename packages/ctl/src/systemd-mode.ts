import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlatformEnvFile } from "./env-file.ts";
import { readInstallMetadata, type ApplianceLayout, type DatabaseMode } from "./home.ts";
import { writeInstallMetadata } from "./bootstrap.ts";
import type { ExecCommand, FetchLike, LifecycleIo } from "./io.ts";
import { GATEWAY_INTERNAL_URL_FALLBACK, GATEWAY_PORT } from "@evelandhq/core/ports";
import {
  ensureHostServiceAccounts,
  PLATFORM_SERVICE_HOME,
  PLATFORM_SERVICE_USER,
  refreshSystemToolchain,
  WEB_SERVICE_HOME,
  WEB_SERVICE_USER,
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
 * Platform processes supervised as host systemd units, in start order — all
 * of them. `systemd.test.ts` asserts this covers `PLATFORM_PROCESSES`
 * exactly: a process in neither list is a process nothing starts.
 */
export const SYSTEMD_HOST_UNITS = [
  "api",
  "gateway",
  "web",
  "worker",
  "workflow-dispatcher",
] as const;

/**
 * What Docker still runs in the production form. The Collector stays a
 * container on purpose: it is stateless, and the Docker runtime attaches it
 * to every Agent's telemetry network. `postgres` is only there for an
 * installation that did not bring its own — see `composeInfraServices`.
 */
export const INFRA_COMPOSE_SERVICES = ["postgres", "otel-collector"] as const;

/**
 * The infrastructure this installation actually starts, from what it recorded
 * at first boot — never from the DSN's shape. An external database that got
 * a bundled container started alongside it is the failure this branch exists
 * to prevent: two clusters, one of them holding half the data.
 */
export function composeInfraServices(database: DatabaseMode): string[] {
  return INFRA_COMPOSE_SERVICES.filter(
    (service) => service !== "postgres" || database === "bundled",
  );
}

/**
 * Compose services this form used to run and no longer does, with the profile
 * that now hides each from the merged production configuration. A promotion
 * (or an update) must actively remove their containers: a leftover Dashboard
 * container still holds the Dashboard's port, and the host unit taking over
 * would fail to bind.
 */
export const RETIRED_COMPOSE_SERVICES: ReadonlyArray<{ service: string; profile: string }> = [
  { service: "api", profile: "dev-api" },
  { service: "gateway", profile: "dev-gateway" },
  { service: "web", profile: "dev-web" },
];

// No process installs its dependencies at start any more, so this is a
// startup budget rather than the fifteen minutes an in-container
// `pnpm install` plus `next build` used to need.
export const SYSTEMD_READINESS_DEADLINE_MS = 180_000;
export const SYSTEMD_READINESS_POLL_MS = 500;

/**
 * The file every host unit's `ConditionPathExists=` points at.
 *
 * `systemctl enable` and "this checkout is safe to run" are two different
 * facts, and only the ctl knows the second one. The units are enabled while
 * the Dashboard is still unbuilt and the schema still unmigrated — during a
 * first boot, and again during every update, which rewrites the checkout the
 * units already point at. A machine that reboots inside either window would
 * otherwise come back running new code against an old schema, with none of
 * the ctl's `bootstrapCompleted` / `update-pending.json` checks in the way,
 * because systemd starts units, not `eveland-ctl start`.
 *
 * So the marker, not the enablement, is what says "provisioned": the ctl
 * writes it immediately before it starts the units, and clears it before an
 * update touches the checkout. Missing, a unit is *skipped* rather than
 * failed — `systemctl status` says "Condition check resulted in ... being
 * skipped" and names this path.
 *
 * It lives under the appliance root, not /run: it must survive the reboot it
 * exists to survive.
 */
export function hostUnitsArmedPath(layout: Pick<ApplianceLayout, "runDir">): string {
  return path.join(layout.runDir, "host-units-armed");
}

const ARMED_MARKER_CONTENT = [
  "# Written by eveland-ctl. Every eveland-*.service has",
  "# ConditionPathExists= on this file, so at boot systemd starts the platform",
  "# only if the ctl last left the checkout built and the schema migrated.",
  "#",
  "# An update removes it before it moves the checkout and writes it back once",
  "# the new revision is built and migrated. If the units are being skipped,",
  "# the last install or update did not finish: re-run `eveland-ctl update`",
  "# (or `eveland-ctl start`), which redoes the remaining steps and re-arms.",
  "",
].join("\n");

/**
 * Declares the checkout ready to run unattended. Called immediately before
 * the ctl starts the units, which is the only moment anything knows it.
 */
export async function armHostUnits(context: SystemdModeContext): Promise<void> {
  const filePath = hostUnitsArmedPath(context.layout);
  await mkdir(path.dirname(filePath), { recursive: true });
  const writeTextFile =
    context.io.writeTextFile ?? ((target: string, body: string) => writeFile(target, body, "utf8"));
  await writeTextFile(filePath, ARMED_MARKER_CONTENT);
}

/**
 * Withdraws that declaration. An update calls it before it moves the
 * checkout: from here until the new revision is built, migrated and started,
 * a reboot leaves the platform down rather than half-updated.
 */
export async function disarmHostUnits(layout: Pick<ApplianceLayout, "runDir">): Promise<void> {
  await rm(hostUnitsArmedPath(layout), { force: true });
}

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

/**
 * Values no operator writes and every host-native unit needs. The
 * containerized form injected these through Compose `environment:` blocks; a
 * unit gets them here, and only here — etc/eveland.env stays the operator's
 * file, never rewritten with machine facts.
 *
 * Most of what those blocks carried was compensation for containerization
 * (service-name upstreams, `host.docker.internal`, an in-container 0.0.0.0
 * bind) and simply disappears: every remaining address is already the code
 * default, because the code defaults ARE the host-native addresses.
 */
export function derivedServiceValues(
  values: Record<string, string>,
  options: { dockerBridgeHost?: string | null } = {},
): Record<string, string> {
  const origin = new URL(
    values.EVELAND_PUBLIC_ORIGIN?.trim() || `http://localhost:${GATEWAY_PORT}`,
  );
  const derived: Record<string, string> = {
    EVELAND_GATEWAY_PUBLIC_SCHEME: origin.protocol.replace(":", ""),
    // "0" means "the scheme's default port": an https origin with no explicit
    // port must not advertise the front door's bind port.
    EVELAND_GATEWAY_PUBLIC_PORT: origin.port === "" ? "0" : origin.port,
    // The API's and the worker's route-cache invalidation hop. It has no code
    // default — an unset value silently skips the invalidation — so the form
    // that knows where the front door lives has to state it.
    EVELAND_GATEWAY_INTERNAL_URL: GATEWAY_INTERNAL_URL_FALLBACK,
    // Explicit rather than defaulted: this is the invariant the bridge
    // listener is checked against.
    EVELAND_API_BIND_HOST: "127.0.0.1",
  };
  // Detected per start, because Docker renumbers its bridge on its own
  // schedule and a stale address is a listener that fails to bind.
  if (options.dockerBridgeHost) {
    derived.EVELAND_API_DOCKER_BRIDGE_HOST = options.dockerBridgeHost;
  }
  return derived;
}

/**
 * A unit's environment file. `keys` is the service's allowlist, or null for
 * "the whole configuration" — which the API and the worker take, because both
 * are trust roots by design (the API seeds the admin and holds the app
 * secret; the worker drives systemd as root), and because narrowing them
 * would silently drop any variable an operator adds to etc/eveland.env by
 * hand.
 */
export function renderServiceEnv(
  service: string,
  keys: readonly string[] | null,
  values: Record<string, string>,
): string {
  const lines = [
    `# Rendered by eveland-ctl on every start. The ${service} service's OWN`,
    keys
      ? "# environment: the allowlisted subset of etc/eveland.env its systemd unit"
      : "# environment: the whole platform configuration, which this service is",
    keys
      ? "# reads. Nothing else from the platform configuration reaches this process."
      : "# trusted with, plus the addresses this installation form derives.",
    "# Edit etc/eveland.env, not this file.",
    "",
  ];
  for (const key of keys ?? Object.keys(values)) {
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
  nodeBinDir: string;
  /** `hostUnitsArmedPath`: the unit's ConditionPathExists. */
  armedMarkerPath: string;
};

/**
 * A unit's identity. `root` is the worker's deliberate exception; every other
 * unit is unprivileged, and no two of them share a uid.
 *
 * The sharing matters more than the privilege level: same-uid processes read
 * each other's `/proc/<pid>/environ`, so a single "platform" uid would make
 * every service's env allowlist decorative — the public front door could
 * simply read APP_SECRET_KEY out of the API's environment. A service that
 * owns no file that outlives a restart takes `DynamicUser=yes` and a fresh
 * uid every boot; one that does gets a fixed system user of its own.
 */
type UnitIdentity = "root" | "dynamic-user" | { user: string; home: string };

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
    identity: { user: PLATFORM_SERVICE_USER, home: PLATFORM_SERVICE_HOME },
    rationale: [
      "# Unprivileged: the API extracts operator-supplied zip archives and is",
      "# the one process reachable (behind the front door) from a browser. It",
      "# writes nothing outside its data dir.",
    ],
    envFile: (options) => serviceEnvFilePath(options.etcDir, "api"),
    readWritePaths: (options) => [options.dataDir],
  },
  gateway: {
    // DynamicUser precisely because it writes nothing that outlives a
    // restart: the installation's only public listener gets a uid of its own,
    // recycled every boot, that owns no file and can read no other service's
    // process environment.
    identity: "dynamic-user",
    rationale: [
      "# Unprivileged, and on a uid nothing else uses: this is the",
      "# installation's only public listener. It proxies and writes nothing to",
      "# disk at all, so it never needs a stable identity — and a compromised",
      "# front door must not be able to read the API's environment.",
    ],
    envFile: (options) => serviceEnvFilePath(options.etcDir, "gateway"),
  },
  web: {
    // Its own user, not the API's: it owns the .next cache across restarts,
    // so DynamicUser would orphan that, and sharing the API's uid would put
    // the whole platform configuration one /proc read away.
    identity: { user: WEB_SERVICE_USER, home: WEB_SERVICE_HOME },
    rationale: [
      "# Unprivileged, on its own uid: the Dashboard serves a build and proxies",
      "# to the API. It never reads the platform's secrets.",
    ],
    envFile: (options) => serviceEnvFilePath(options.etcDir, "web"),
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
    envFile: (options) => serviceEnvFilePath(options.etcDir, "worker"),
  },
  "workflow-dispatcher": {
    identity: "dynamic-user",
    rationale: [
      "# Unprivileged on purpose: unlike the worker this never drives systemd or",
      "# touches deployment files. It talks to Postgres and to loopback HTTP only,",
      "# and it must never load tenant code.",
    ],
    envFile: (options) => serviceEnvFilePath(options.etcDir, "workflow-dispatcher"),
  },
};

/**
 * Hardening every unprivileged unit gets, whatever its identity.
 *
 * `ProtectProc=invisible` is the belt to the separate-uid braces: uids alone
 * already stop one service reading another's `/proc/<pid>/environ`, and this
 * hides the rest of the host's process table from a service that has no
 * business reading it. It needs systemd v247; an older systemd logs an
 * unknown-key warning and falls back to the uid separation, which is what
 * actually carries the property.
 */
const UNPRIVILEGED_HARDENING = [
  "NoNewPrivileges=yes",
  "PrivateTmp=yes",
  "ProtectProc=invisible",
  "ProtectHome=read-only",
  "ProtectKernelTunables=yes",
  "ProtectControlGroups=yes",
  "RestrictSUIDSGID=yes",
];

function identityLines(profile: UnitProfile, options: UnitRenderOptions): string[] {
  if (profile.identity === "root") return [...profile.rationale, "User=root"];
  if (profile.identity === "dynamic-user") {
    // DynamicUser implies ProtectSystem=strict, PrivateTmp and friends, and
    // hands out a uid that exists only for this boot.
    return [
      ...profile.rationale,
      "DynamicUser=yes",
      // A transient uid has no /etc/passwd entry, and systemd does not export
      // $HOME for one. Node's os.homedir() then falls through to getpwuid_r(),
      // finds nothing, and THROWS rather than returning a default (libuv
      // surfaces it as ENOENT) — so any dependency that reads a home path at
      // import time kills the process before it starts. That is exactly how
      // the dispatcher died: graphile-worker's cosmiconfig takes
      // os.homedir() as its stopDir.
      //
      // PrivateTmp's /tmp is the home this identity should have: writable, and
      // gone at the next restart, so "owns no file that outlives a restart"
      // still holds. A StateDirectory would buy persistence this identity
      // deliberately does not want.
      "Environment=HOME=/tmp",
      ...UNPRIVILEGED_HARDENING,
    ];
  }
  const { user, home } = profile.identity;
  const readWrite = [home, ...(profile.readWritePaths?.(options) ?? [])];
  return [
    ...profile.rationale,
    `User=${user}`,
    `Group=${user}`,
    // A real home: corepack, npm and Next all fall back to $HOME, and a
    // transient uid's home — unset, as the dispatcher found out — is exactly
    // what breaks them.
    `Environment=HOME=${home}`,
    ...UNPRIVILEGED_HARDENING,
    // The checkout, /etc and everything else become read-only; only the
    // paths below are writable. This is the boundary the containerized
    // form claimed and did not have.
    "ProtectSystem=strict",
    `ReadWritePaths=${readWrite.join(" ")}`,
  ];
}

/**
 * One renderer for every platform unit. The command comes from
 * `PLATFORM_PROCESSES` — never retyped here — so a unit and a ctl-supervised
 * child can never drift apart.
 */
export function renderPlatformUnit(spec: ProcessSpec, options: UnitRenderOptions): string {
  const profile = UNIT_PROFILES[spec.key];
  const after = [
    "network-online.target",
    // The Collector, and a bundled database, are still containers. `After=` on
    // a unit this host does not have is a no-op, so an installation on an
    // external database is not held up by it.
    "docker.service",
    // Everything else talks to the API; ordering only shortens the window in
    // which they retry, since each unit restarts on failure anyway.
    ...(spec.key === "api" ? [] : [systemdUnitName("api")]),
  ];
  return [
    "[Unit]",
    `Description=eveland ${spec.label}`,
    "Wants=network-online.target",
    `After=${after.join(" ")}`,
    "# Not started unattended unless the ctl last left this checkout built and",
    "# migrated. Absent, systemd SKIPS the unit instead of running new code",
    "# against an old schema — see hostUnitsArmedPath.",
    `ConditionPathExists=${options.armedMarkerPath}`,
    // [Unit], not [Service]: systemd moved these out of [Service] in v229 and
    // silently ignores them there ("Unknown key name ... in section
    // 'Service'"). A crash loop burns one restart every RestartSec; cap it so
    // a broken config surfaces as a failed unit instead of an infinite loop.
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
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
    nodeBinDir,
    armedMarkerPath: hostUnitsArmedPath(context.layout),
  };
}

/**
 * The appliance Compose overlay, applied on top of docker-compose.prod.yml.
 * With every platform process on the host, all that is left is repointing the
 * Collector's hardcoded /var/lib/eveland binds at the appliance data dir.
 */
export function renderApplianceOverlay(options: { dataDir: string }): string {
  return [
    "# Rendered by eveland-ctl. Appliance adjustments on top of",
    "# docker-compose.prod.yml — see packages/ctl/src/systemd-mode.ts.",
    "# Only the Collector is left to adjust: every platform process is a host",
    "# systemd unit, and the bundled database keeps its own volume.",
    "services:",
    "  otel-config-init:",
    "    volumes: !override",
    "      - ./infra/otel/collector.yaml:/seed/collector.yaml:ro",
    `      - ${options.dataDir}/otel:/var/lib/eveland/otel`,
    "  otel-collector:",
    "    volumes: !override",
    `      - ${options.dataDir}/otel:/var/lib/eveland/otel:ro`,
    "      - eveland-otel-collector:/var/lib/otelcol",
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
  options: { dockerBridgeHost?: string | null } = {},
): Promise<void> {
  const { io, layout } = context;
  const values = { ...envFile.values, ...derivedServiceValues(envFile.values, options) };
  // null keys means "the whole configuration": see renderServiceEnv.
  const files: Array<{ service: string; keys: readonly string[] | null; label: string }> = [
    { service: "api", keys: null, label: "full configuration" },
    { service: "worker", keys: null, label: "full configuration" },
    { service: "workflow-dispatcher", keys: DISPATCHER_ENV_KEYS, label: "dispatcher-only" },
    { service: "gateway", keys: GATEWAY_ENV_KEYS, label: "gateway-only" },
    { service: "web", keys: WEB_ENV_KEYS, label: "dashboard-only" },
  ];
  for (const { service, keys, label } of files) {
    const filePath = serviceEnvFilePath(layout.etcDir, service);
    await writeSecretFile(io, filePath, renderServiceEnv(service, keys, values));
    io.stdout(`Wrote ${filePath} (${label})`);
  }
}

/**
 * A file only its unit may read. `eveland-api.env` is the whole platform
 * configuration — APP_SECRET_KEY, BETTER_AUTH_SECRET, the admin password — so
 * the mode is part of writing it, not an afterthought: created 0600 rather
 * than created at the ambient umask and narrowed a moment later, and a chmod
 * that fails is fatal rather than swallowed. The chmod still runs because a
 * file that already exists keeps the mode it already had.
 */
async function writeSecretFile(io: LifecycleIo, filePath: string, content: string): Promise<void> {
  const writeTextFile =
    io.writeTextFile ??
    ((target: string, body: string) => writeFile(target, body, { encoding: "utf8", mode: 0o600 }));
  await writeTextFile(filePath, content);
  await chmod(filePath, 0o600);
}

/**
 * Ownership the host units need before they can run, reconciled on every
 * start rather than once at install: an update rebuilds the Dashboard and
 * re-runs migrations as root, and the unprivileged services have to be able
 * to write their own directories again afterwards.
 *
 * Three trees, and only three — this is the whole file-level contract between
 * the root worker and the unprivileged platform services. Each belongs to ONE
 * uid; the Gateway appears nowhere because it owns no file at all:
 *
 *   apps/web/.next   the Dashboard's runtime cache, written by `next start`
 *   <dataDir>/uploads   where the API extracts uploaded sources for the
 *                       worker (root) to read
 *   <dataDir>/diagnostics   where the worker (root) publishes its
 *                           configuration snapshot for the API to read; the
 *                           setgid group bit is what makes that readable
 *                           without making it world-readable
 */
export async function reconcileHostOwnership(
  context: SystemdModeContext,
  options: { dataDir: string },
): Promise<number> {
  const { io } = context;
  const owned: Array<{ path: string; owner: string; mode: string }> = [
    {
      // The Dashboard's own uid, not the API's: the two units no longer share
      // an identity, and only `next start` writes here.
      path: path.join(context.repoRootDir, "apps/web/.next"),
      owner: `${WEB_SERVICE_USER}:${WEB_SERVICE_USER}`,
      mode: "0755",
    },
    {
      path: path.join(options.dataDir, "uploads"),
      owner: `${PLATFORM_SERVICE_USER}:${PLATFORM_SERVICE_USER}`,
      mode: "0700",
    },
    {
      path: path.join(options.dataDir, "diagnostics"),
      // root writes, the platform group reads, nobody else sees it. 2xxx so
      // the worker's snapshot inherits the group on create.
      owner: `root:${PLATFORM_SERVICE_USER}`,
      mode: "2750",
    },
  ];
  for (const entry of owned) {
    const created = await context.execCommand(["install", "-d", "-m", entry.mode, entry.path], {
      cwd: context.repoRootDir,
    });
    if (created.code !== 0) {
      io.stderr(`Could not create ${entry.path}:\n${created.output.trim()}`);
      return 1;
    }
    // -R because a build (or a previous root-owned run) leaves files behind
    // that the unprivileged service must still be able to replace.
    const chown = await context.execCommand(["chown", "-R", entry.owner, entry.path], {
      cwd: context.repoRootDir,
    });
    if (chown.code !== 0) {
      io.stderr(`Could not set ${entry.path} to ${entry.owner}:\n${chown.output.trim()}`);
      return 1;
    }
    // `install -d` only sets the mode when it creates the directory.
    const chmodResult = await context.execCommand(["chmod", entry.mode, entry.path], {
      cwd: context.repoRootDir,
    });
    if (chmodResult.code !== 0) {
      io.stderr(`Could not set ${entry.path} to ${entry.mode}:\n${chmodResult.output.trim()}`);
      return 1;
    }
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
  installOptions: { dockerBridgeHost?: string | null } = {},
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
  // Before the units that name them: an installation from before a service
  // had its own identity meets those units for the first time on an update,
  // and a unit whose User= does not exist fails to start.
  await ensureHostServiceAccounts({
    execCommand: context.execCommand,
    repoRootDir: context.repoRootDir,
    stdout: io.stdout,
  });

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

  await writeServiceEnvFiles(context, envFile, installOptions);

  const overlay = applianceOverlayPath(layout.etcDir);
  await writeTextFile(
    overlay,
    renderApplianceOverlay({
      dataDir: envFile.values.EVELAND_DATA_DIR ?? path.join(layout.root, "data"),
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

/** Compose up (infra) + systemctl start + readiness. */
export async function startViaSystemd(
  context: SystemdModeContext,
  options: { skipInfra?: boolean; dataDir: string; database: DatabaseMode },
): Promise<number> {
  const { io, layout } = context;
  // `--skip-infra` means the same thing it always did: this installation is
  // not the one that starts the containers. There is simply less behind that
  // flag now — the Collector, and the bundled database when there is one.
  const infra = composeInfraServices(options.database);
  if (!options.skipInfra) {
    io.stdout(`Starting the infrastructure containers (${infra.join(", ")})...`);
    const up = await context.execCommand(applianceComposeArgs(layout, "up", "-d", ...infra), {
      cwd: context.repoRootDir,
    });
    if (up.code !== 0) {
      io.stderr(`docker compose up failed:\n${up.output.trim()}`);
      return 1;
    }
  }
  const owned = await reconcileHostOwnership(context, { dataDir: options.dataDir });
  if (owned !== 0) return owned;
  // Reaching here means the ctl has done everything a unit assumes: the
  // Dashboard is built, migrations have run, ownership is reconciled. That is
  // exactly what the marker asserts, so it is written here and nowhere else.
  await armHostUnits(context);
  for (const key of SYSTEMD_HOST_UNITS) {
    const result = await context.execCommand(["systemctl", "start", systemdUnitName(key)], {
      cwd: context.repoRootDir,
    });
    if (result.code !== 0) {
      io.stderr(`systemctl start ${systemdUnitName(key)} failed:\n${result.output.trim()}`);
      return 1;
    }
  }
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
      } else {
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
      `Check \`systemctl status ${SYSTEMD_HOST_UNITS.map(systemdUnitName).join(" ")}\`, ` +
      "`journalctl -u eveland-api`, and `docker compose ps`.",
  );
  return 1;
}

/** systemctl stop for every host unit. The infrastructure containers stay up. */
export async function stopViaSystemd(context: SystemdModeContext): Promise<number> {
  const { io } = context;
  let failed = false;
  // Reverse start order: the front door goes first so nothing new arrives
  // while what is behind it is going away.
  for (const key of [...SYSTEMD_HOST_UNITS].reverse()) {
    const result = await context.execCommand(["systemctl", "stop", systemdUnitName(key)], {
      cwd: context.repoRootDir,
    });
    if (result.code !== 0) {
      io.stderr(`systemctl stop ${systemdUnitName(key)} failed:\n${result.output.trim()}`);
      failed = true;
    }
  }
  if (!failed) {
    io.stdout("Stopped the platform. Infrastructure containers keep running.");
  }
  return failed ? 1 : 0;
}
