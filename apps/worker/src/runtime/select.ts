import { createRequire } from "node:module";
import { SANDBOX_INTERNAL_PORT } from "@evelandhq/core/ports";
import path from "node:path";
import { createDockerAdapter } from "./docker.js";
import { createSystemdAdapter, resolveSandboxCacheRoot } from "./systemd.js";
import type { CompleteRuntimeAdapter } from "./types.js";

export type DeploymentResourceLimits = {
  memoryMax: string;
  cpuQuota: string;
  tasksMax: number;
};

export function resolveDeploymentResourceLimits(env: NodeJS.ProcessEnv): DeploymentResourceLimits {
  const tasksMax = Number(env.EVELAND_TASKS_MAX ?? 512);
  if (!Number.isSafeInteger(tasksMax) || tasksMax <= 0) {
    throw new Error("EVELAND_TASKS_MAX must be a positive safe integer.");
  }
  return {
    memoryMax: env.EVELAND_MEMORY_MAX ?? "2G",
    cpuQuota: env.EVELAND_CPU_QUOTA ?? "200%",
    tasksMax,
  };
}

/**
 * Locates @evelandhq/sandbox-bwrap's dist, which gets vendored into each release.
 * Passed to createSystemdAdapter as a provider and invoked inside buildRelease
 * (see systemd.ts) and by the startup preflight's built-backend check
 * (runtime/preflight.ts) -- never at module load -- so constructing any
 * adapter, including the docker default, never touches the filesystem. A
 * successful `resolve()` already proves dist/index.js exists (the package's
 * "exports" map points at it, and Node's resolver checks the target file is
 * actually there), so no separate existsSync check is needed;
 * injectSandboxModules (sandbox-inject.ts) remains the validator of the
 * backend's contents.
 *
 * The package ships prebuilt from npm (it lives in its own repository), so
 * unlike the workspace package it replaced there is no build step to forget --
 * failure here means the dependency is missing, not unbuilt.
 */
export function resolveBackendDistDir(): string {
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve("@evelandhq/sandbox-bwrap");
  } catch (error) {
    throw new Error(
      "@evelandhq/sandbox-bwrap is not resolvable. Run `pnpm install` before starting the worker.",
      { cause: error },
    );
  }
  return path.dirname(entry);
}

export function createRuntimeAdapterForKind(
  kind: "docker" | "systemd",
  env: NodeJS.ProcessEnv = process.env,
): CompleteRuntimeAdapter {
  const limits = resolveDeploymentResourceLimits(env);
  if (kind === "docker") {
    return createDockerAdapter({
      internalPort: Number(env.EVELAND_INTERNAL_PORT ?? SANDBOX_INTERNAL_PORT),
      dataDir: path.resolve(env.EVELAND_DATA_DIR ?? ".eveland-data"),
      collectorContainerName: env.EVELAND_OTEL_COLLECTOR_CONTAINER ?? "eveland-otel-collector",
      backendDistDir: resolveBackendDistDir,
      ...limits,
    });
  }

  return createSystemdAdapter({
    dataDir: path.resolve(env.EVELAND_DATA_DIR ?? ".eveland-data"),
    user: env.EVELAND_APP_USER ?? "eveland-app",
    buildUser: env.EVELAND_BUILD_USER ?? "eveland-build",
    ...limits,
    buildSandbox: env.EVELAND_BUILD_SANDBOX === "none" ? "none" : "bwrap",
    // Each release gets a fresh directory, but eve keys session sandboxes per
    // durable session and promises a redeploy preserves a session's /workspace
    // -- so the cache must live outside the release dir, stable per project.
    sandboxCacheDir: resolveSandboxCacheRoot(env),
    backendDistDir: resolveBackendDistDir,
  });
}

/**
 * Explicit `EVELAND_RUNTIME` always wins, so a legacy Docker production host opts
 * out with one env var. Absent that, `NODE_ENV=production` resolves to `systemd`
 * -- it's the supported production shape (see docs/en/production/index.md) -- while dev
 * and CI (no `NODE_ENV=production`) keep the `docker` default they already rely on.
 */
export function resolveRuntimeKind(env: NodeJS.ProcessEnv): string {
  if (env.EVELAND_RUNTIME) {
    return env.EVELAND_RUNTIME;
  }
  if (env.NODE_ENV === "production") {
    return "systemd";
  }
  return "docker";
}

export function createRuntimeAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CompleteRuntimeAdapter {
  const kind = resolveRuntimeKind(env);

  if (kind !== "docker" && kind !== "systemd") {
    throw new Error(`Unknown EVELAND_RUNTIME "${kind}". Expected "docker" or "systemd".`);
  }

  return createRuntimeAdapterForKind(kind, env);
}
