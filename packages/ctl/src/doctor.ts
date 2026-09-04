import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  API_INTERNAL_URL_FALLBACK,
  API_PORT,
  GATEWAY_INTERNAL_URL_FALLBACK,
  GATEWAY_PORT,
  OTEL_PLATFORM_HOST_GRPC_PORT,
  OTEL_PLATFORM_HOST_HTTP_PORT,
  POSTGRES_HOST_PORT,
  WEB_PORT,
} from "@evelandhq/core/ports";
import { loadPlatformEnvFile, type PlatformEnvFile } from "./env-file.ts";
import { databaseMode, readInstallMetadata, type DatabaseMode } from "./home.ts";
import { defaultPgJournalProbe, describeDatabaseAddress, type PgJournalProbe } from "./pg-probe.ts";
import {
  resolveLifecycle,
  type ExecCommand,
  type FetchLike,
  type LifecycleIo,
} from "./lifecycle.ts";
import { verifiedSupervisorPid } from "./state-files.ts";
import { defaultTcpProbe, type TcpProbe } from "./net-probe.ts";
import { detectDockerBridgeHost } from "./docker-bridge.ts";

/**
 * `eveland-ctl doctor`: every check this installation has historically been
 * bitten by, collected in one pass (all problems at once, not first-failure)
 * so one run gives the whole repair list. Checks are dependency-injected and
 * each maps to a concrete incident class: port hijacks, proxy injection,
 * global libvips breaking sharp, placeholder secrets shipped to production.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  detail: string;
};

export type DoctorDeps = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeVersion: string;
  repoRootDir: string;
  envFile: PlatformEnvFile | null;
  supervisorRunning: boolean;
  /** Bundled or external Postgres; some checks only apply to one. */
  database: DatabaseMode;
  execCommand: ExecCommand;
  pgJournalProbe: PgJournalProbe;
  tcpProbe: TcpProbe;
  fetchImpl: FetchLike;
  fileExists: (filePath: string) => Promise<boolean>;
  freeDiskBytes: (dir: string) => Promise<number | null>;
  nonLoopbackAddresses: () => string[];
  /**
   * Docker's default-bridge gateway, or null. The API binds it deliberately
   * (the Collector's only route to a host-native API), so it is the one
   * non-loopback address the exposure check must not fault the API for.
   */
  dockerBridgeHost: () => Promise<string | null>;
  readTextFile: (filePath: string) => Promise<string | null>;
};

const PLACEHOLDER_SECRET_PREFIX = "eveland-dev-";
// Secrets only: admin@example.com is the documented default admin IDENTITY
// (the bootstrap itself defaults to it), not a credential.
const PLACEHOLDER_VALUES = new Set(["eveland_password"]);
const REQUIRED_ENV_KEYS = [
  "DATABASE_URL",
  "APP_SECRET_KEY",
  "BETTER_AUTH_SECRET",
  "EVELAND_ADMIN_PASSWORD",
];
const LOOPBACK_ONLY_PORTS: Array<{ port: number; label: string }> = [
  { port: API_PORT, label: "Platform API" },
  { port: WEB_PORT, label: "Dashboard" },
  { port: POSTGRES_HOST_PORT, label: "Postgres" },
];
const FIXED_PORTS: Array<{ port: number; label: string }> = [
  { port: GATEWAY_PORT, label: "Agent Gateway" },
  { port: API_PORT, label: "Platform API" },
  { port: WEB_PORT, label: "Dashboard" },
  { port: POSTGRES_HOST_PORT, label: "Postgres" },
  { port: OTEL_PLATFORM_HOST_GRPC_PORT, label: "OTLP Collector (gRPC)" },
  { port: OTEL_PLATFORM_HOST_HTTP_PORT, label: "OTLP Collector (HTTP)" },
];
const MIN_FREE_DISK_FAIL = 2 * 1024 ** 3;
const MIN_FREE_DISK_WARN = 10 * 1024 ** 3;
const PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];
const GLOBAL_VIPS_PATHS = ["/opt/homebrew/include/vips", "/usr/local/include/vips"];

export async function collectDoctorChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const add = (name: string, status: CheckStatus, detail: string) =>
    checks.push({ name, status, detail });

  // Operating system.
  if (deps.platform === "darwin") {
    add("os", "ok", "macOS (Docker runtime; supervised by eveland-ctl)");
  } else if (deps.platform === "linux") {
    const procVersion = (await deps.readTextFile("/proc/version")) ?? "";
    add(
      "os",
      "ok",
      procVersion.toLowerCase().includes("microsoft")
        ? "Linux under WSL2 (treated as Linux; Docker reachability checked below)"
        : "Linux (systemd+bwrap production form)",
    );
  } else {
    add(
      "os",
      "fail",
      `Unsupported platform '${deps.platform}'; eveland-ctl supports macOS and Linux.`,
    );
  }

  // Node.
  const nodeMajor = Number.parseInt(deps.nodeVersion.replace(/^v/, ""), 10);
  if (Number.isInteger(nodeMajor) && nodeMajor >= 24) {
    add("node", "ok", `${deps.nodeVersion}`);
  } else {
    add("node", "fail", `Node ${deps.nodeVersion} is too old; the platform needs Node >= 24.`);
  }

  // The pinned interpreter of an appliance install (etc/eveland.env
  // EVELAND_NODE). `nvm uninstall` silently breaks it, so verify it runs.
  const pinnedNode = deps.envFile?.values.EVELAND_NODE;
  if (pinnedNode) {
    const result = await deps.execCommand([pinnedNode, "--version"], { cwd: deps.repoRootDir });
    if (result.code === 0) {
      add("pinned-node", "ok", `EVELAND_NODE=${pinnedNode} (${result.output.trim()})`);
    } else {
      add(
        "pinned-node",
        "fail",
        `EVELAND_NODE=${pinnedNode} does not run (was it removed by nvm uninstall?). Re-run the installer or fix the path.`,
      );
    }
  }

  // pnpm.
  const pnpm = await deps.execCommand(["pnpm", "--version"], { cwd: deps.repoRootDir });
  if (pnpm.code === 0) {
    add("pnpm", "ok", `pnpm ${pnpm.output.trim()}`);
  } else {
    add("pnpm", "fail", "pnpm is not runnable. Run `corepack enable` (Node ships corepack).");
  }

  // Docker.
  const docker = await deps.execCommand(["docker", "info", "--format", "{{.ServerVersion}}"], {
    cwd: deps.repoRootDir,
  });
  const dockerOk = docker.code === 0;
  if (dockerOk) {
    add("docker", "ok", `daemon ${docker.output.trim()}`);
  } else {
    add(
      "docker",
      "fail",
      "Docker daemon is not reachable; the OTLP Collector (and the bundled database, if this " +
        "installation has one) run in Compose.",
    );
  }

  // Info-ZIP unzip (zip source import shells out to `unzip -Z1`; BusyBox lacks -Z).
  const unzip = await deps.execCommand(["unzip", "-v"], { cwd: deps.repoRootDir });
  if (unzip.output.includes("Info-ZIP")) {
    add("unzip", "ok", "Info-ZIP unzip present");
  } else if (unzip.code === null) {
    add("unzip", "fail", "unzip is not installed; zip source import needs Info-ZIP unzip.");
  } else {
    add(
      "unzip",
      "warn",
      "unzip exists but does not look like Info-ZIP; zip source import may fail.",
    );
  }

  // Configuration file.
  if (!deps.envFile) {
    add(
      "config",
      "fail",
      "No platform configuration (etc/eveland.env or .env). Copy .env.example to .env and edit it.",
    );
  } else {
    add("config", "ok", deps.envFile.path);
    const values = deps.envFile.values;
    const nodeEnv = values.NODE_ENV;
    if (!nodeEnv) {
      add(
        "node-env",
        "warn",
        "NODE_ENV is unset: the platform fails closed like production (dev fallback secrets do not apply). Set development or production explicitly.",
      );
    } else {
      add("node-env", "ok", `NODE_ENV=${nodeEnv}`);
    }
    const missing = REQUIRED_ENV_KEYS.filter((key) => !values[key]?.trim());
    if (missing.length > 0) {
      add("config-required", "fail", `Missing required values: ${missing.join(", ")}.`);
    } else {
      add("config-required", "ok", "all required values present");
    }
    const placeholders = Object.entries(values)
      .filter(
        ([, value]) => value.startsWith(PLACEHOLDER_SECRET_PREFIX) || PLACEHOLDER_VALUES.has(value),
      )
      .map(([key]) => key);
    if (placeholders.length > 0 && nodeEnv !== "development" && nodeEnv !== "test") {
      add(
        "placeholder-secrets",
        "fail",
        `Placeholder values outside development: ${placeholders.join(", ")}. Generate real secrets (openssl rand).`,
      );
    } else if (placeholders.length > 0) {
      add("placeholder-secrets", "ok", `development placeholders in use (${placeholders.length})`);
    } else {
      add("placeholder-secrets", "ok", "no placeholder secrets");
    }
  }

  // Fixed platform ports: when the platform is down, anything listening on
  // them is a foreign process that will collide with the next start.
  if (!deps.supervisorRunning) {
    // Infra containers legitimately keep running while the platform is down.
    const infraPorts = new Set([
      POSTGRES_HOST_PORT,
      OTEL_PLATFORM_HOST_GRPC_PORT,
      OTEL_PLATFORM_HOST_HTTP_PORT,
    ]);
    const foreign: string[] = [];
    for (const { port, label } of FIXED_PORTS) {
      if (infraPorts.has(port)) continue;
      if (await deps.tcpProbe("127.0.0.1", port)) foreign.push(`${port} (${label})`);
    }
    if (foreign.length > 0) {
      add(
        "ports",
        "warn",
        `Platform is not running but these ports are in use: ${foreign.join(", ")}. The next start will collide.`,
      );
    } else {
      add("ports", "ok", "no foreign listeners on the platform port block");
    }
  } else {
    add("ports", "ok", "platform running; see `eveland-ctl status` for per-port health");
  }

  // Loopback exposure: only the Agent Gateway may be reachable off-host.
  //
  // With one deliberate exception: the host-native API binds Docker's bridge
  // gateway on purpose, so the managed Collector — a container, with no route
  // to the host's loopback — can deliver Agent events. That listener serves
  // an explicit path allowlist (apps/api/src/docker-bridge-ingress.ts), not
  // the control plane.
  //
  // The clash is intermittent rather than constant, which is worse. libuv
  // lists an interface only when it is both UP and RUNNING, and a bridge with
  // no attached container is UP without carrier — so `docker0` is normally
  // absent from this list even though its address is perfectly local and the
  // API is bound to it. (The platform's own containers all sit on Compose
  // networks, not the default bridge.) Let anything ordinary attach to it —
  // one `docker run` with no `--network` — and docker0 gains carrier, its
  // address joins this list, and a correct production install starts failing
  // doctor over a listener it is supposed to have.
  //
  // The exemption is narrow on both axes: this address only, the API's port
  // only. The Dashboard or Postgres on the very same bridge is still a
  // finding, and every other interface is still checked.
  const bridgeHost = await deps.dockerBridgeHost();
  const exposures: string[] = [];
  for (const address of deps.nonLoopbackAddresses()) {
    for (const { port, label } of LOOPBACK_ONLY_PORTS) {
      if (address === bridgeHost && port === API_PORT) continue;
      if (await deps.tcpProbe(address, port)) exposures.push(`${label} on ${address}:${port}`);
    }
  }
  if (exposures.length > 0) {
    add(
      "loopback-exposure",
      "fail",
      `Loopback-only services are reachable from the network: ${exposures.join("; ")}. Postgres ships well-known default credentials — fix the bind/forwarding.`,
    );
  } else {
    add(
      "loopback-exposure",
      "ok",
      bridgeHost
        ? `loopback-only services are not reachable off-host (the API's ${bridgeHost} Collector listener is by design)`
        : "loopback-only services are not reachable off-host",
    );
  }

  // Proxy environment (a fresh VM inheriting an unreachable host proxy breaks
  // installs and builds in ways that masquerade as network flakiness).
  const proxies = PROXY_VARIABLES.filter((name) => deps.env[name]?.trim());
  if (proxies.length > 0) {
    add(
      "proxy-env",
      "warn",
      `Proxy variables set: ${proxies.join(", ")}. If the proxy is unreachable, installs and builds fail obscurely.`,
    );
  } else {
    add("proxy-env", "ok", "no proxy variables set");
  }

  // Global libvips: a fresh install's sharp build fails against a Homebrew
  // libvips unless SHARP_IGNORE_GLOBAL_LIBVIPS=1.
  if (deps.platform === "darwin" && !deps.env.SHARP_IGNORE_GLOBAL_LIBVIPS) {
    let globalVips = false;
    for (const vipsPath of GLOBAL_VIPS_PATHS) {
      if (await deps.fileExists(vipsPath)) globalVips = true;
    }
    if (globalVips) {
      add(
        "sharp-libvips",
        "warn",
        "A global libvips is installed and SHARP_IGNORE_GLOBAL_LIBVIPS is unset; `pnpm install` may fail building sharp. Export SHARP_IGNORE_GLOBAL_LIBVIPS=1.",
      );
    } else {
      add("sharp-libvips", "ok", "no global libvips conflict");
    }
  }

  // Disk.
  const freeBytes = await deps.freeDiskBytes(deps.repoRootDir);
  if (freeBytes === null) {
    add("disk", "warn", "could not determine free disk space");
  } else if (freeBytes < MIN_FREE_DISK_FAIL) {
    add(
      "disk",
      "fail",
      `${formatGiB(freeBytes)} free — builds and Postgres will fail; free space now.`,
    );
  } else if (freeBytes < MIN_FREE_DISK_WARN) {
    add(
      "disk",
      "warn",
      `${formatGiB(freeBytes)} free — consider freeing space before large builds.`,
    );
  } else {
    add("disk", "ok", `${formatGiB(freeBytes)} free`);
  }

  // Dashboard production build: a host artifact in BOTH forms now — the
  // systemd form runs `next start` as a host unit, not inside a container.
  if (await deps.fileExists(path.join(deps.repoRootDir, "apps/web/.next/BUILD_ID"))) {
    add("web-build", "ok", "Dashboard production build present");
  } else {
    add(
      "web-build",
      "warn",
      "No Dashboard production build; `eveland-ctl start` will refuse until `pnpm --filter @evelandhq/web build` runs.",
    );
  }

  // Postgres content: reachable is not enough -- a foreign Postgres on the
  // platform port (a Lima VM's forward, another project) answers TCP just
  // fine. Ask the database this installation is configured with for the
  // migration journal, through the DSN every platform process uses.
  const databaseUrl = deps.envFile?.values.DATABASE_URL?.trim();
  const databaseLabel = databaseUrl ? describeDatabaseAddress(databaseUrl) : null;
  if (!databaseUrl) {
    // config-required already reported the missing value.
  } else if (!databaseLabel) {
    add("postgres", "fail", "DATABASE_URL is not a PostgreSQL connection URL.");
  } else {
    const journal = await deps.pgJournalProbe(databaseUrl);
    if (journal.status === "migrated") {
      add("postgres", "ok", `${databaseLabel}: ${journal.count} migrations applied`);
    } else if (journal.status === "unmigrated") {
      add(
        "postgres",
        "warn",
        `${databaseLabel} answers but carries no migration journal. Either it is a fresh database ` +
          "(run `pnpm --filter @evelandhq/api db:migrate`) or it is not this installation's -- a " +
          "Lima VM port-forward hijack looks exactly like this.",
      );
    } else {
      add("postgres", "fail", `${databaseLabel} is unreachable: ${journal.detail}`);
    }
  }

  // pg_dump, but only where an upgrade actually needs it on the host: the
  // bundled database is dumped inside its own container, at a version that
  // matches by construction. Better here than halfway through an upgrade.
  if (deps.database === "external") {
    const pgDump = await deps.execCommand(["pg_dump", "--version"], { cwd: deps.repoRootDir });
    if (pgDump.code === 0) {
      add("pg_dump", "ok", pgDump.output.trim().split("\n")[0] ?? "present");
    } else {
      add(
        "pg_dump",
        "fail",
        "pg_dump is not installed, and this installation uses its own PostgreSQL, so " +
          "`eveland-ctl update` cannot take its pre-upgrade backup. Install the PostgreSQL " +
          "client package (Debian/Ubuntu: apt-get install postgresql-client).",
      );
    }
  }

  // Live platform health, when it is up.
  if (deps.supervisorRunning) {
    const gatewayOk = await probeHealth(deps.fetchImpl, "gateway");
    const apiOk = await probeHealth(deps.fetchImpl, "api");
    if (gatewayOk && apiOk) {
      add("platform", "ok", "Agent Gateway and Platform API respond healthy");
    } else {
      add(
        "platform",
        "fail",
        `Supervisor is running but health probes fail (gateway ${gatewayOk ? "ok" : "FAILED"}, api ${apiOk ? "ok" : "FAILED"}). See \`eveland-ctl logs\`.`,
      );
    }
  }

  return checks;
}

async function probeHealth(fetchImpl: FetchLike, component: "gateway" | "api"): Promise<boolean> {
  const base = component === "gateway" ? GATEWAY_INTERNAL_URL_FALLBACK : API_INTERNAL_URL_FALLBACK;
  try {
    const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export async function defaultFreeDiskBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export function defaultNonLoopbackAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === "IPv4") addresses.push(entry.address);
    }
  }
  return addresses;
}

export async function runDoctor(
  _args: string[],
  io: LifecycleIo & { tcpProbe?: TcpProbe; doctorDeps?: Partial<DoctorDeps> },
): Promise<number> {
  const resolved = resolveLifecycle(io);
  const envFile = await loadPlatformEnvFile({
    env: io.env,
    repoRoot: resolved.repoRootDir,
    platform: resolved.platform,
  });
  const supervisorPid = await verifiedSupervisorPid(resolved.layout, resolved.processIdentity);
  // "Running" means either supervision form: the ctl supervisor, or the
  // systemd production form (Compose core + host units).
  const metadata = await readInstallMetadata(resolved.layout);
  const deps: DoctorDeps = {
    env: io.env,
    platform: resolved.platform,
    nodeVersion: process.version,
    repoRootDir: resolved.repoRootDir,
    envFile,
    supervisorRunning: supervisorPid !== null || metadata?.supervision === "systemd",
    database: databaseMode(metadata),
    execCommand: resolved.execCommand,
    pgJournalProbe: defaultPgJournalProbe(),
    tcpProbe: io.tcpProbe ?? defaultTcpProbe(),
    fetchImpl: resolved.fetchImpl,
    fileExists: resolved.fileExists,
    freeDiskBytes: defaultFreeDiskBytes,
    nonLoopbackAddresses: defaultNonLoopbackAddresses,
    dockerBridgeHost: () =>
      detectDockerBridgeHost({ execCommand: resolved.execCommand, cwd: resolved.repoRootDir }),
    readTextFile: (filePath) => readFile(filePath, "utf8").catch(() => null),
    ...io.doctorDeps,
  };
  const checks = await collectDoctorChecks(deps);
  for (const check of checks) {
    const marker = check.status === "ok" ? "  ok  " : check.status === "warn" ? " warn " : " FAIL ";
    io.stdout(`[${marker}] ${check.name.padEnd(20)} ${check.detail}`);
  }
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  io.stdout("");
  io.stdout(
    failures > 0
      ? `${failures} failure(s), ${warnings} warning(s).`
      : warnings > 0
        ? `No failures, ${warnings} warning(s).`
        : "All checks passed.",
  );
  return failures > 0 ? 1 : 0;
}
