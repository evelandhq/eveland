import { createRequire } from "node:module";
import path from "node:path";
import { createDockerAdapter } from "./docker.js";
import { createSystemdAdapter, resolveSandboxCacheRoot } from "./systemd.js";
import type { RuntimeAdapter } from "./types.js";

/**
 * Locates the built @eveland/sandbox-bwrap that gets vendored into each release.
 * Passed to createSystemdAdapter as a provider and invoked inside buildRelease
 * (see systemd.ts) and by the startup preflight's built-backend check
 * (runtime/preflight.ts) -- never at module load -- so constructing any
 * adapter, including the docker default, never touches the filesystem or
 * requires this package to be built. A successful `resolve()` already proves
 * dist/index.js exists (the package's "exports" map points at it, and Node's
 * resolver checks the target file is actually there), so no separate
 * existsSync check is needed; injectSandboxModules (sandbox-inject.ts) remains
 * the validator of the backend's contents.
 */
export function resolveBackendDistDir(): string {
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve("@eveland/sandbox-bwrap");
  } catch (error) {
    throw new Error(
      "@eveland/sandbox-bwrap is not resolvable. Run `pnpm --filter @eveland/sandbox-bwrap build` before starting the worker.",
      { cause: error },
    );
  }
  return path.dirname(entry);
}

export function createRuntimeAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeAdapter {
  const kind = env.EVELAND_RUNTIME ?? "docker";

  if (kind === "docker") {
    return createDockerAdapter({ internalPort: Number(env.EVELAND_INTERNAL_PORT ?? 3000) });
  }

  if (kind === "systemd") {
    return createSystemdAdapter({
      dataDir: path.resolve(env.EVELAND_DATA_DIR ?? ".eveland-data"),
      user: env.EVELAND_APP_USER ?? "eveland-app",
      memoryMax: env.EVELAND_MEMORY_MAX ?? "2G",
      cpuQuota: env.EVELAND_CPU_QUOTA ?? "200%",
      buildSandbox: env.EVELAND_BUILD_SANDBOX === "none" ? "none" : "bwrap",
      // Each release gets a fresh directory, but eve keys session sandboxes per
      // durable session and promises a redeploy preserves a session's /workspace
      // -- so the cache must live outside the release dir, stable per project.
      sandboxCacheDir: resolveSandboxCacheRoot(env),
      backendDistDir: resolveBackendDistDir,
    });
  }

  throw new Error(`Unknown EVELAND_RUNTIME "${kind}". Expected "docker" or "systemd".`);
}
