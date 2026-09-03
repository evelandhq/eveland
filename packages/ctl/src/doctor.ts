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
import { readInstallMetadata } from "./home.ts";
import {
  resolveLifecycle,
  type ExecCommand,
  type FetchLike,
  type LifecycleIo,
} from "./lifecycle.ts";
import { verifiedSupervisorPid } from "./state-files.ts";
import { defaultTcpProbe, type TcpProbe } from "./net-probe.ts";

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
  execCommand: ExecCommand;
  tcpProbe: TcpProbe;
  fetchImpl: FetchLike;
  fileExists: (filePath: string) => Promise<boolean>;
  freeDiskBytes: (dir: string) => Promise<number | null>;
  nonLoopbackAddresses: () => string[];
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
      "Docker daemon is not reachable; Postgres and the OTLP Collector run in Compose.",
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
  const exposures: string[] = [];
  for (const address of deps.nonLoopbackAddresses()) {
    for (const { port, label } of LOOPBACK_ONLY_PORTS) {
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
    add("loopback-exposure", "ok", "loopback-only services are not reachable off-host");
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

  // Postgres content: reachable is not enough — a foreign Postgres on the
  // platform port (a Lima VM's forward, another project) answers TCP just
  // fine. Ask the Compose container itself for the migration journal.
  const postgresReachable = await deps.tcpProbe("127.0.0.1", POSTGRES_HOST_PORT);
  if (postgresReachable && dockerOk) {
    // --env-file: compose interpolates the whole file even for one service,
    // and an appliance's configuration is not a ./.env in the compose cwd.
    const envFileArgs = deps.envFile ? ["--env-file", deps.envFile.path] : [];
    const result = await deps.execCommand(
      [
        "docker",
        "compose",
        ...envFileArgs,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "eveland",
        "-d",
        "eveland",
        "-tAc",
        "select count(*) from drizzle.__drizzle_migrations",
      ],
      { cwd: deps.repoRootDir },
    );
    if (result.code === 0) {
      add("postgres", "ok", `${result.output.trim()} migrations applied`);
    } else if (/no such service|not running|no container/i.test(result.output)) {
      add(
        "postgres",
        "warn",
        `Something answers on 127.0.0.1:${POSTGRES_HOST_PORT} but the Compose postgres container is not running — check for a foreign Postgres (a Lima VM port-forward hijack looks exactly like this).`,
      );
    } else if (/does not exist/i.test(result.output)) {
      add(
        "postgres",
        "warn",
        "Postgres is running but not migrated. Run `pnpm --filter @evelandhq/api db:migrate`.",
      );
    } else {
      add("postgres", "warn", `Could not verify migrations: ${result.output.trim().slice(0, 200)}`);
    }
  } else if (postgresReachable) {
    add(
      "postgres",
      "warn",
      "Postgres port answers but Docker is unreachable; cannot verify it is ours.",
    );
  } else {
    add("postgres", "ok", "not running (started by `eveland-ctl start`)");
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
    execCommand: resolved.execCommand,
    tcpProbe: io.tcpProbe ?? defaultTcpProbe(),
    fetchImpl: resolved.fetchImpl,
    fileExists: resolved.fileExists,
    freeDiskBytes: defaultFreeDiskBytes,
    nonLoopbackAddresses: defaultNonLoopbackAddresses,
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
