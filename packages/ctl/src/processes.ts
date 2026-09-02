import path from "node:path";
import {
  API_INTERNAL_URL_FALLBACK,
  GATEWAY_INTERNAL_URL_FALLBACK,
  WEB_INTERNAL_URL_FALLBACK,
  WEB_PORT,
} from "@evelandhq/core/ports";

/**
 * The supervised platform topology, mirrored from docker-compose.prod.yml:
 * the Agent Gateway is the only public listener, API/Dashboard sit behind it
 * on loopback, and the worker and workflow dispatcher have no listener at
 * all. The docs site is dev-only and never supervised. Four of the five run
 * TypeScript sources directly (tsx); only the Dashboard has a real build
 * artifact (.next) and a separate production server.
 */

export type ProcessKey = "gateway" | "api" | "web" | "worker" | "workflow-dispatcher";

export type ProcessSpec = {
  key: ProcessKey;
  label: string;
  /** Working directory relative to the repository root. */
  dir: string;
  argv: string[];
  /** Loopback URL whose 2xx response marks the process ready; null when the process has no listener. */
  readinessUrl: string | null;
};

export const PLATFORM_PROCESSES: ProcessSpec[] = [
  {
    key: "gateway",
    label: "Agent Gateway",
    dir: "apps/gateway",
    argv: [
      "pnpm",
      "exec",
      "tsx",
      "--import=@evelandhq/platform-observability/register",
      "src/server.ts",
    ],
    readinessUrl: `${GATEWAY_INTERNAL_URL_FALLBACK}/health`,
  },
  {
    key: "api",
    label: "Platform API",
    dir: "apps/api",
    argv: [
      "pnpm",
      "exec",
      "tsx",
      "--import=@evelandhq/platform-observability/register",
      "src/server.ts",
    ],
    readinessUrl: `${API_INTERNAL_URL_FALLBACK}/health`,
  },
  {
    key: "web",
    label: "Dashboard",
    dir: "apps/web",
    argv: ["pnpm", "exec", "next", "start", "--port", String(WEB_PORT), "--hostname", "127.0.0.1"],
    readinessUrl: WEB_INTERNAL_URL_FALLBACK,
  },
  {
    key: "worker",
    label: "Worker",
    dir: "apps/worker",
    argv: ["pnpm", "exec", "tsx", "src/worker.ts"],
    readinessUrl: null,
  },
  {
    key: "workflow-dispatcher",
    label: "Workflow dispatcher",
    dir: "apps/workflow-dispatcher",
    argv: ["pnpm", "exec", "tsx", "src/main.ts"],
    readinessUrl: null,
  },
];

export function processByKey(key: string): ProcessSpec | undefined {
  return PLATFORM_PROCESSES.find((spec) => spec.key === key);
}

/**
 * The systemd unit name for a platform process. Worker and dispatcher
 * deliberately converge with the long-documented eveland-worker /
 * eveland-workflow-dispatcher service names from infra/systemd.
 */
export function systemdUnitName(key: string): string {
  return `eveland-${key}.service`;
}

/**
 * The environment a supervised child receives: the parent environment for
 * PATH/HOME-style plumbing, with every value from the platform env file laid
 * over it. The env file wins so the appliance configuration is authoritative
 * regardless of what the invoking shell happens to export.
 */
export function childEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  envFileValues: Record<string, string>,
): NodeJS.ProcessEnv {
  const merged = { ...parentEnv, ...envFileValues };
  // The pinned interpreter's bin dir (where the installer put pnpm/corepack
  // for a private Node) leads PATH: `pnpm exec ...` must resolve the same
  // toolchain from a fresh shell, launchd, or a reboot as from the installer.
  const nodeBinDir = envFileValues.EVELAND_NODE ? path.dirname(envFileValues.EVELAND_NODE) : null;
  if (nodeBinDir) {
    const rest = (merged.PATH ?? "")
      .split(path.delimiter)
      .filter((dir) => dir && dir !== nodeBinDir);
    merged.PATH = [nodeBinDir, ...rest].join(path.delimiter);
  }
  return merged;
}

export function absoluteProcessDir(repoRootDir: string, spec: ProcessSpec): string {
  return path.join(repoRootDir, spec.dir);
}
