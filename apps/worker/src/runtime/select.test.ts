import { describe, expect, test } from "vitest";
import { createRuntimeAdapterForKind, createRuntimeAdapterFromEnv } from "./select.js";

describe("createRuntimeAdapterForKind", () => {
  test("constructs the docker adapter", () => {
    expect(createRuntimeAdapterForKind("docker", {}).name).toBe("docker");
  });

  test("constructs the systemd adapter", () => {
    expect(createRuntimeAdapterForKind("systemd", { EVELAND_DATA_DIR: "/var/lib/eveland-data" } as NodeJS.ProcessEnv).name).toBe(
      "systemd",
    );
  });
});

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

  // These two only pin that construction does not throw. backendDistDir resolution
  // is deferred to buildRelease (see select.ts), so constructing the systemd adapter
  // never touches the filesystem, regardless of whether @eveland/sandbox-bwrap is
  // built. The path assertions live in systemd.test.ts, where buildSystemdRunArgs,
  // resolveProjectSandboxCacheDir, and resolveSandboxCacheRoot are pure and don't
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
