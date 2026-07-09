import { describe, expect, test } from "vitest";
import { createRuntimeAdapterFromEnv } from "./select.js";

describe("createRuntimeAdapterFromEnv", () => {
  test("defaults to the docker adapter", () => {
    expect(createRuntimeAdapterFromEnv({}).name).toBe("docker");
  });

  test("selects the systemd adapter when EVELAND_RUNTIME=systemd", () => {
    expect(createRuntimeAdapterFromEnv({ EVELAND_RUNTIME: "systemd" }).name).toBe("systemd");
  });

  test("rejects unknown runtime kinds", () => {
    expect(() => createRuntimeAdapterFromEnv({ EVELAND_RUNTIME: "kubernetes" })).toThrow(/Unknown EVELAND_RUNTIME/);
  });

  // These two only pin that construction does not throw when @eveland/sandbox-bwrap
  // is built (true in this workspace); the path assertions live in systemd.test.ts,
  // where buildSystemdRunArgs and resolveProjectSandboxCacheDir are pure and don't
  // need the real package resolved.
  test("systemd runtime derives the sandbox cache dir from the data dir by default", () => {
    const adapter = createRuntimeAdapterFromEnv({ EVELAND_RUNTIME: "systemd", EVELAND_DATA_DIR: "/var/lib/eveland-data" } as NodeJS.ProcessEnv);
    expect(adapter.name).toBe("systemd");
  });

  test("EVELAND_SANDBOX_CACHE_DIR overrides the derived path", () => {
    const adapter = createRuntimeAdapterFromEnv({
      EVELAND_RUNTIME: "systemd",
      EVELAND_DATA_DIR: "/var/lib/eveland-data",
      EVELAND_SANDBOX_CACHE_DIR: "/srv/sandbox",
    } as NodeJS.ProcessEnv);
    expect(adapter.name).toBe("systemd");
  });
});
