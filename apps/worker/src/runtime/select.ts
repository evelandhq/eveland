import path from "node:path";
import { createDockerAdapter } from "./docker.js";
import { createSystemdAdapter } from "./systemd.js";
import type { RuntimeAdapter } from "./types.js";

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
    });
  }

  throw new Error(`Unknown EVELAND_RUNTIME "${kind}". Expected "docker" or "systemd".`);
}
