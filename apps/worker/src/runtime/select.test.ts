import { describe, expect, test } from "vitest";
import {
  createRuntimeAdapterForKind,
  createRuntimeAdapterFromEnv,
  resolveRuntimeKind,
} from "./select.js";

describe("createRuntimeAdapterForKind", () => {
  test("constructs the docker adapter", () => {
    expect(createRuntimeAdapterForKind("docker", {}).name).toBe("docker");
  });

  test("constructs the systemd adapter", () => {
    expect(
      createRuntimeAdapterForKind("systemd", {
        EVELAND_DATA_DIR: "/var/lib/eveland-data",
      } as NodeJS.ProcessEnv).name,
    ).toBe("systemd");
  });
});

describe("resolveRuntimeKind", () => {
  test("defaults to docker when nothing is set", () => {
    expect(resolveRuntimeKind({})).toBe("docker");
  });

  test("defaults to docker in test/development, even with NODE_ENV set", () => {
    expect(resolveRuntimeKind({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("docker");
    expect(resolveRuntimeKind({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe("docker");
  });

  test("resolves to systemd when NODE_ENV=production and EVELAND_RUNTIME is unset", () => {
    expect(resolveRuntimeKind({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("systemd");
  });

  test("explicit EVELAND_RUNTIME=docker wins over NODE_ENV=production", () => {
    expect(
      resolveRuntimeKind({
        NODE_ENV: "production",
        EVELAND_RUNTIME: "docker",
      } as NodeJS.ProcessEnv),
    ).toBe("docker");
  });

  test("explicit EVELAND_RUNTIME=systemd wins outside production", () => {
    expect(resolveRuntimeKind({ EVELAND_RUNTIME: "systemd" } as NodeJS.ProcessEnv)).toBe("systemd");
  });

  test("passes through an unknown explicit value unvalidated", () => {
    expect(resolveRuntimeKind({ EVELAND_RUNTIME: "kubernetes" } as NodeJS.ProcessEnv)).toBe(
      "kubernetes",
    );
  });

  // Before the default flip an empty string threw at adapter construction ("" is not
  // nullish); the truthiness check now deliberately treats it as unset.
  test("treats an empty-string EVELAND_RUNTIME as unset", () => {
    expect(resolveRuntimeKind({ EVELAND_RUNTIME: "" } as NodeJS.ProcessEnv)).toBe("docker");
    expect(
      resolveRuntimeKind({ EVELAND_RUNTIME: "", NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBe("systemd");
  });
});

describe("createRuntimeAdapterFromEnv", () => {
  test("defaults to the docker adapter", () => {
    expect(createRuntimeAdapterFromEnv({}).name).toBe("docker");
  });

  test("defaults to the docker adapter in test/development, even with NODE_ENV set", () => {
    expect(createRuntimeAdapterFromEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv).name).toBe(
      "docker",
    );
    expect(createRuntimeAdapterFromEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv).name).toBe(
      "docker",
    );
  });

  test("selects the systemd adapter when EVELAND_RUNTIME=systemd", () => {
    expect(createRuntimeAdapterFromEnv({ EVELAND_RUNTIME: "systemd" }).name).toBe("systemd");
  });

  test("defaults to the systemd adapter when NODE_ENV=production and EVELAND_RUNTIME is unset", () => {
    expect(createRuntimeAdapterFromEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv).name).toBe(
      "systemd",
    );
  });

  test("explicit EVELAND_RUNTIME=docker wins over NODE_ENV=production", () => {
    expect(
      createRuntimeAdapterFromEnv({
        NODE_ENV: "production",
        EVELAND_RUNTIME: "docker",
      } as NodeJS.ProcessEnv).name,
    ).toBe("docker");
  });

  test("rejects unknown runtime kinds", () => {
    expect(() => createRuntimeAdapterFromEnv({ EVELAND_RUNTIME: "kubernetes" })).toThrow(
      /Unknown EVELAND_RUNTIME/,
    );
  });

  test("rejects unknown runtime kinds even when NODE_ENV=production", () => {
    expect(() =>
      createRuntimeAdapterFromEnv({
        NODE_ENV: "production",
        EVELAND_RUNTIME: "kubernetes",
      } as NodeJS.ProcessEnv),
    ).toThrow(/Unknown EVELAND_RUNTIME/);
  });

  // These two only pin that construction does not throw. backendDistDir resolution
  // is deferred to buildRelease (see select.ts), so constructing the systemd adapter
  // never touches the filesystem, regardless of whether @evelandhq/sandbox-bwrap is
  // installed. The path assertions live in systemd.test.ts, where buildSystemdRunArgs,
  // resolveProjectSandboxCacheDir, and resolveSandboxCacheRoot are pure and don't
  // need the real package resolved.
  test("systemd runtime derives the sandbox cache dir from the data dir by default", () => {
    const adapter = createRuntimeAdapterFromEnv({
      EVELAND_RUNTIME: "systemd",
      EVELAND_DATA_DIR: "/var/lib/eveland-data",
    } as NodeJS.ProcessEnv);
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
