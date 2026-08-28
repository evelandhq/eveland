import { describe, expect, test, vi } from "vitest";
import path from "node:path";
import { execa } from "execa";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  buildBwrapArgs,
  buildDynamicUserAccessRepairScript,
  buildEnvFileContent,
  buildReleaseBuildCommand,
  buildReleaseBuildEnvironment,
  buildRunAsUserArgs,
  buildSystemdRunArgs,
  buildSystemdStartCommand,
  createSystemdAdapter,
  isBenignSystemctlStopFailure,
  resolveProjectSandboxCacheDir,
  resolveSandboxCacheRoot,
  resolveSystemdDeploymentUser,
} from "./systemd.js";
import { injectSandboxModules } from "./sandbox-inject.js";
import { verifySandbox } from "./sandbox-verify.js";
import { readReleaseDiscovery, readReleaseSchedulerDefinitions } from "./discovery-artifacts.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ all: "", stdout: "", stderr: "" }),
}));

vi.mock("@evelandhq/agent-scheduler", () => ({
  injectSchedulerAdapter: vi.fn().mockResolvedValue({
    eveVersion: "0.45.2",
    channelPath: "agent/channels/eveland-scheduler.ts",
    definitions: [],
  }),
}));

// injectSandboxModules is exercised end-to-end in sandbox-inject.test.ts against a
// real filesystem fixture; here it's mocked so createSystemdAdapter's buildRelease
// tests can pin call *ordering* and the cache-dir/log-prefixing wiring in isolation.
vi.mock("./sandbox-inject.js", () => ({
  injectSandboxModules: vi
    .fn()
    .mockResolvedValue({ generated: ["agent/sandbox.js"], replaced: [], wrapped: [] }),
}));

// verifySandbox shells out to the real vendored backend under systemd-run; it has its
// own boundary tests in sandbox-verify.test.ts. Mocked here (mirroring injectSandboxModules
// above) so createSystemdAdapter's buildRelease tests can pin call ordering and log wiring
// without depending on the generic execa mock's shape (no exitCode/marker) below.
vi.mock("./sandbox-verify.js", () => ({
  verifySandbox: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./discovery-artifacts.js", () => ({
  readReleaseDiscovery: vi.fn().mockResolvedValue(undefined),
  readReleaseSchedulerDefinitions: vi.fn().mockResolvedValue([]),
}));

describe("buildSystemdRunArgs", () => {
  test("creates a hardened transient unit bound to the release dir", () => {
    const args = buildSystemdRunArgs({
      unitName: "eveland-proj_123-dep_456",
      releaseDir: "/data/builds/proj_123/rel_789",
      envFilePath: "/data/deployment-env/eveland-proj_123-dep_456.env",
      port: 41000,
      user: "eveland-app",
      memoryMax: "2G",
      cpuQuota: "200%",
      sandboxCacheDir: "/var/lib/eveland-data/sandbox/proj_123",
      memoryRootDir: "/var/lib/eveland-data/memory/proj_123",
      dataDir: "/var/lib/eveland-data",
      observabilityPolicyDir: "/var/lib/eveland-data/observability/proj_123/dep_456",
      accessRepairScriptPath: "/data/deployment-env/eveland-proj_123-dep_456.prepare-access.sh",
      dynamicUserUidMarkerPath:
        "/var/lib/eveland-data/observability/proj_123/dep_456/.dynamic-user-uid",
      command: "npx eve start --host 127.0.0.1 --port 41000",
    });

    expect(args).toEqual([
      "--unit",
      "eveland-proj_123-dep_456",
      "--collect",
      "--service-type=exec",
      "--property=Restart=on-failure",
      "--property=RestartSec=2",
      "--property=StartLimitIntervalSec=60",
      "--property=StartLimitBurst=5",
      `--property=User=${resolveSystemdDeploymentUser("eveland-proj_123-dep_456")}`,
      "--property=DynamicUser=yes",
      "--property=Group=eveland-app",
      "--property=UMask=0002",
      "--property=WorkingDirectory=/data/builds/proj_123/rel_789",
      "--property=EnvironmentFile=/data/deployment-env/eveland-proj_123-dep_456.env",
      "--property=Environment=PORT=41000",
      "--property=Environment=HOME=/data/builds/proj_123/rel_789",
      "--property=Environment=EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland-data/sandbox/proj_123",
      "--property=Environment=EVELAND_SANDBOX_TEMPLATE_REVISION=/data/builds/proj_123/rel_789",
      "--property=MemoryMax=2G",
      "--property=CPUQuota=200%",
      "--property=TasksMax=512",
      "--property=ProtectSystem=strict",
      "--property=ReadWritePaths=/data/builds/proj_123/rel_789",
      "--property=ReadWritePaths=/var/lib/eveland-data/sandbox/proj_123",
      "--property=ReadWritePaths=/var/lib/eveland-data/memory/proj_123",
      "--property=ReadWritePaths=/run/eveland/dynamic-user-uid",
      "--property=TemporaryFileSystem=/var/lib/eveland-data:ro",
      "--property=BindPaths=/data/builds/proj_123/rel_789",
      "--property=BindPaths=/var/lib/eveland-data/sandbox/proj_123",
      "--property=BindPaths=/var/lib/eveland-data/memory/proj_123",
      "--property=BindPaths=/var/lib/eveland-data/observability/proj_123/dep_456/.dynamic-user-uid:/run/eveland/dynamic-user-uid",
      "--property=BindReadOnlyPaths=/data/deployment-env/eveland-proj_123-dep_456.env",
      "--property=BindReadOnlyPaths=/data/deployment-env/eveland-proj_123-dep_456.prepare-access.sh:/run/eveland/prepare-dynamic-user-access",
      "--property=BindReadOnlyPaths=/var/lib/eveland-data/observability/proj_123/dep_456:/run/eveland/observability",
      "--property=ProtectProc=invisible",
      "--property=PrivateTmp=yes",
      "--property=NoNewPrivileges=yes",
      "--property=ExecStartPre=+/bin/sh /run/eveland/prepare-dynamic-user-access",
      "sh",
      "-lc",
      "npx eve start --host 127.0.0.1 --port 41000",
    ]);
    expect(args).toContain(
      "--property=Environment=EVELAND_SANDBOX_TEMPLATE_REVISION=/data/builds/proj_123/rel_789",
    );
  });

  test("applies the configured task limit", () => {
    const args = buildSystemdRunArgs({
      unitName: "eveland-proj_123-dep_456",
      releaseDir: "/data/builds/proj_123/rel_789",
      envFilePath: "/data/deployment-env/eveland-proj_123-dep_456.env",
      port: 41000,
      user: "eveland-app",
      memoryMax: "2G",
      cpuQuota: "200%",
      tasksMax: 64,
      sandboxCacheDir: "/var/lib/eveland-data/sandbox/proj_123",
      memoryRootDir: "/var/lib/eveland-data/memory/proj_123",
      dataDir: "/var/lib/eveland-data",
      observabilityPolicyDir: "/var/lib/eveland-data/observability/proj_123/dep_456",
      accessRepairScriptPath: "/data/deployment-env/eveland-proj_123-dep_456.prepare-access.sh",
      dynamicUserUidMarkerPath:
        "/var/lib/eveland-data/observability/proj_123/dep_456/.dynamic-user-uid",
      command: "npx eve start --host 127.0.0.1 --port 41000",
    });

    expect(args).toContain("--property=TasksMax=64");
  });
});

describe("buildSystemdRunArgs (sandbox cache)", () => {
  test("grants the sandbox cache dir and exports it to the app", () => {
    const args = buildSystemdRunArgs({
      unitName: "eveland-p-d",
      releaseDir: "/rel",
      envFilePath: "/env/p.env",
      port: 41000,
      user: "eveland-app",
      memoryMax: "2G",
      cpuQuota: "200%",
      sandboxCacheDir: "/var/lib/eveland-data/sandbox/p",
      memoryRootDir: "/var/lib/eveland-data/memory/p",
      dataDir: "/var/lib/eveland-data",
      observabilityPolicyDir: "/var/lib/eveland-data/observability/p/d",
      accessRepairScriptPath: "/env/p.prepare-access.sh",
      dynamicUserUidMarkerPath: "/var/lib/eveland-data/observability/p/d/.dynamic-user-uid",
      command: "npx eve start",
    });

    expect(args).toContain("--property=ReadWritePaths=/rel");
    expect(args).toContain("--property=ReadWritePaths=/var/lib/eveland-data/sandbox/p");
    // The memory root is granted the same way; its value reaches the process
    // through the EnvironmentFile (composeDeploymentEnv reserves it), so no
    // Environment= line exists to be overridden.
    expect(args).toContain("--property=ReadWritePaths=/var/lib/eveland-data/memory/p");
    expect(args).toContain("--property=BindPaths=/var/lib/eveland-data/memory/p");
    expect(args.some((arg) => arg.startsWith("--property=Environment=EVELAND_MEMORY_ROOT"))).toBe(
      false,
    );
    expect(args).toContain(
      "--property=Environment=EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland-data/sandbox/p",
    );
    expect(args).toContain("--property=Environment=EVELAND_SANDBOX_TEMPLATE_REVISION=/rel");
    // The env file must still be read before PORT is forced.
    expect(args.indexOf("--property=EnvironmentFile=/env/p.env")).toBeLessThan(
      args.indexOf("--property=Environment=PORT=41000"),
    );
  });
});

describe("buildSystemdRunArgs (sibling isolation)", () => {
  test("masks the data root so one Deployment cannot read another's telemetry credential", () => {
    const args = buildSystemdRunArgs({
      unitName: "eveland-p-d",
      releaseDir: "/var/lib/eveland-data/builds/p/rel",
      envFilePath: "/var/lib/eveland-data/deployment-env/p.env",
      port: 41000,
      user: "eveland-app",
      memoryMax: "2G",
      cpuQuota: "200%",
      sandboxCacheDir: "/var/lib/eveland-data/sandbox/p",
      memoryRootDir: "/var/lib/eveland-data/memory/p",
      dataDir: "/var/lib/eveland-data",
      observabilityPolicyDir: "/var/lib/eveland-data/observability/p/d",
      accessRepairScriptPath: "/var/lib/eveland-data/deployment-env/p.prepare-access.sh",
      dynamicUserUidMarkerPath: "/var/lib/eveland-data/observability/p/d/.dynamic-user-uid",
      command: "npx eve start",
    });

    expect(args).toContain("--property=TemporaryFileSystem=/var/lib/eveland-data:ro");
    // Only this Deployment's own subtrees are reopened; a sibling's policy dir
    // under the same data root stays hidden behind the tmpfs.
    expect(args).toContain("--property=BindPaths=/var/lib/eveland-data/builds/p/rel");
    expect(args).toContain("--property=BindPaths=/var/lib/eveland-data/sandbox/p");
    expect(args).toContain("--property=BindPaths=/var/lib/eveland-data/memory/p");
    expect(args.filter((arg) => arg.startsWith("--property=BindPaths="))).toHaveLength(4);
    // The env file carries every project secret and also lives under the mask,
    // so it must be reopened or the Deployment starts with no configuration.
    expect(args.filter((arg) => arg.startsWith("--property=BindReadOnlyPaths="))).toEqual([
      "--property=BindReadOnlyPaths=/var/lib/eveland-data/deployment-env/p.env",
      "--property=BindReadOnlyPaths=/var/lib/eveland-data/deployment-env/p.prepare-access.sh:/run/eveland/prepare-dynamic-user-access",
      "--property=BindReadOnlyPaths=/var/lib/eveland-data/observability/p/d:/run/eveland/observability",
    ]);
    // systemd applies TemporaryFileSystem= before the binds that reopen paths
    // through it, so a bind listed first would be masked back out.
    expect(args.indexOf("--property=TemporaryFileSystem=/var/lib/eveland-data:ro")).toBeLessThan(
      args.indexOf("--property=BindPaths=/var/lib/eveland-data/builds/p/rel"),
    );
    expect(args).toContain("--property=DynamicUser=yes");
    expect(args).toContain("--property=Group=eveland-app");
    expect(args).toContain("--property=UMask=0002");
    expect(args).toContain("--property=ProtectProc=invisible");
    expect(args).toContain(`--property=User=${resolveSystemdDeploymentUser("eveland-p-d")}`);
  });
});

describe("resolveSystemdDeploymentUser", () => {
  test("assigns different bounded dynamic identities to different Deployments", () => {
    const first = resolveSystemdDeploymentUser("eveland-proj_123-dep_456");
    const second = resolveSystemdDeploymentUser("eveland-proj_123-dep_789");

    expect(first).not.toBe(second);
    expect(first).toMatch(/^eveland-d-[a-f0-9]{20}$/);
    expect(first.length).toBeLessThanOrEqual(31);
    expect(resolveSystemdDeploymentUser("eveland-proj_123-dep_456")).toBe(first);
  });
});

describe("resolveProjectSandboxCacheDir", () => {
  test("joins the root with a process-safe form of the project id", () => {
    expect(resolveProjectSandboxCacheDir("/var/lib/eveland-data/sandbox", "Proj 123!")).toBe(
      path.resolve("/var/lib/eveland-data/sandbox", "proj-123-"),
    );
  });

  test("never resolves outside the root even for a project id that sanitizes to only dots", () => {
    const resolved = resolveProjectSandboxCacheDir("/root", "..");
    expect(resolved).not.toBe(path.resolve("/root", ".."));
    expect(resolved.startsWith(path.resolve("/root") + path.sep)).toBe(true);
  });
});

describe("resolveSandboxCacheRoot", () => {
  test("uses EVELAND_SANDBOX_CACHE_DIR when set, overriding any data dir", () => {
    expect(
      resolveSandboxCacheRoot({
        EVELAND_SANDBOX_CACHE_DIR: "/srv/sandbox",
        EVELAND_DATA_DIR: "/var/lib/eveland-data",
      } as NodeJS.ProcessEnv),
    ).toBe(path.resolve("/srv/sandbox"));
  });

  test("derives <EVELAND_DATA_DIR>/sandbox when no override is set", () => {
    expect(
      resolveSandboxCacheRoot({ EVELAND_DATA_DIR: "/var/lib/eveland-data" } as NodeJS.ProcessEnv),
    ).toBe(path.resolve("/var/lib/eveland-data", "sandbox"));
  });

  test("defaults to .eveland-data/sandbox when neither env var is set", () => {
    expect(resolveSandboxCacheRoot({} as NodeJS.ProcessEnv)).toBe(
      path.resolve(".eveland-data", "sandbox"),
    );
  });
});

describe("buildSystemdStartCommand", () => {
  test("serves eve projects on loopback without any bridge hack", () => {
    const command = buildSystemdStartCommand({ hasLockfile: true }, 41000);
    expect(command).toBe("npx eve start --host 127.0.0.1 --port 41000");
  });
});

describe("buildReleaseBuildCommand", () => {
  test("uses the frozen pnpm lockfile selected from the imported project", () => {
    expect(
      buildReleaseBuildCommand({
        hasLockfile: true,
        packageManager: "pnpm",
      }),
    ).toBe(
      "pnpm install --frozen-lockfile --config.minimum-release-age=0 && npx eve info --json >/dev/null && node .eveland/extensions/integrate.mjs && npx eve build && npx eve info --json >/dev/null",
    );
  });

  test("installs the platform-owned world through pnpm without leaving manifest or lockfile changes", () => {
    const command = buildReleaseBuildCommand(
      {
        hasLockfile: true,
        packageManager: "pnpm",
      },
      { packageName: "@workflow/world-postgres", packageVersion: "5.0.0-beta.34" },
    );

    expect(command).toContain("pnpm install --frozen-lockfile --config.minimum-release-age=0");
    expect(command).toContain(
      "pnpm add --lockfile=false --ignore-scripts --config.minimum-release-age=0 @workflow/world-postgres@5.0.0-beta.34",
    );
    expect(command).toContain("trap");
    expect(command).not.toMatch(/(^|&& )npm install/);
  });

  test("installs the platform-owned world outside the project lock before building Eve", () => {
    expect(
      buildReleaseBuildCommand(
        { hasLockfile: true },
        { packageName: "@workflow/world-postgres", packageVersion: "5.0.0-beta.34" },
      ),
    ).toBe(
      "npm ci && npm install --no-save --package-lock=false --ignore-scripts @workflow/world-postgres@5.0.0-beta.34 && npx eve info --json >/dev/null && node .eveland/extensions/integrate.mjs && npx eve build && npx eve info --json >/dev/null",
    );
  });

  test("uses npm install and eve build without a lockfile", () => {
    expect(buildReleaseBuildCommand({ hasLockfile: false })).toBe(
      "npm install && npx eve info --json >/dev/null && node .eveland/extensions/integrate.mjs && npx eve build && npx eve info --json >/dev/null",
    );
  });
});

describe("buildReleaseBuildEnvironment", () => {
  test("gives eve build the Agent's non-secret variables", () => {
    const { environment } = buildReleaseBuildEnvironment({
      npmCacheDir: "/var/lib/eveland/npm-cache",
      pathValue: "/usr/bin",
      variables: { MODEL_NAME: "configured-model" },
    });

    expect(environment).toEqual({
      MODEL_NAME: "configured-model",
      PATH: "/usr/bin",
      npm_config_cache: "/var/lib/eveland/npm-cache",
    });
  });

  test("keeps the platform's own build toolchain names out of a project's reach", () => {
    const { environment, rejectedKeys } = buildReleaseBuildEnvironment({
      npmCacheDir: "/var/lib/eveland/npm-cache",
      pathValue: "/usr/bin",
      variables: { NPM_CONFIG_CACHE: "/tmp/attacker", PATH: "/tmp/attacker-bin" },
    });

    expect(environment).toEqual({
      PATH: "/usr/bin",
      npm_config_cache: "/var/lib/eveland/npm-cache",
    });
    expect(rejectedKeys).toEqual(["NPM_CONFIG_CACHE", "PATH"]);
  });

  // The install and `npx eve build` share one shell, so NODE_ENV=production
  // here would omit devDependencies from the very tree eve build compiles
  // against.
  test("keeps NODE_ENV away from the install that eve build runs against", () => {
    const { environment, rejectedKeys } = buildReleaseBuildEnvironment({
      npmCacheDir: "/var/lib/eveland/npm-cache",
      pathValue: "/usr/bin",
      variables: { MODEL_NAME: "configured-model", NODE_ENV: "production" },
    });

    expect(environment.NODE_ENV).toBeUndefined();
    expect(environment.MODEL_NAME).toBe("configured-model");
    expect(rejectedKeys).toEqual(["NODE_ENV"]);
  });
});

/**
 * `buildReleaseBuildEnvironment` returning a complete environment only keeps
 * worker secrets out while its caller also passes `extendEnv: false` -- execa
 * extends `process.env` by default, and this process holds APP_SECRET_KEY,
 * DATABASE_URL and WORKFLOW_POSTGRES_URL. That pairing used to be self-evident
 * from one inline literal beside the execa call; now that the environment is
 * built elsewhere, only this asserts it.
 */
describe("release build execa contract", () => {
  // readFileSync, because this file mocks node:fs/promises.
  test("every build execa call that takes buildEnv also refuses process.env", () => {
    const source = readFileSync(new URL("./systemd.ts", import.meta.url), "utf8");
    const uses = [...source.matchAll(/env: buildEnv/g)];

    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const use of uses) {
      expect(source.slice(use.index, use.index + 200)).toContain("extendEnv: false");
    }
  });
});

describe("buildBwrapArgs", () => {
  test("mounts the rootfs read-only, shadows dataDir, then re-exposes only the release dir and npm cache", () => {
    const args = buildBwrapArgs({
      releaseDir: "/var/lib/eveland-data/builds/proj_123/rel_789",
      npmCacheDir: "/var/lib/eveland-data/npm-cache",
      dataDir: "/var/lib/eveland-data",
      command: "npm ci && npx eve build",
    });

    expect(args).toEqual([
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/var/lib/eveland-data",
      "--bind",
      "/var/lib/eveland-data/builds/proj_123/rel_789",
      "/var/lib/eveland-data/builds/proj_123/rel_789",
      "--bind",
      "/var/lib/eveland-data/npm-cache",
      "/var/lib/eveland-data/npm-cache",
      "--unshare-pid",
      "--die-with-parent",
      "--chdir",
      "/var/lib/eveland-data/builds/proj_123/rel_789",
      "--setenv",
      "HOME",
      "/var/lib/eveland-data/builds/proj_123/rel_789",
      "sh",
      "-lc",
      "npm ci && npx eve build",
    ]);
  });
});

const baseAdapterConfig = {
  dataDir: "/var/lib/eveland-data",
  user: "eveland-app",
  buildUser: "eveland-build",
  memoryMax: "2G",
  cpuQuota: "200%",
  buildSandbox: "bwrap" as const,
  sandboxCacheDir: "/var/lib/eveland-data/sandbox",
  backendDistDir: () => "/opt/sandbox-bwrap/dist",
};

describe("createSystemdAdapter listProcesses", () => {
  test("lists running eveland units stripped of their .service suffix", async () => {
    const adapter = createSystemdAdapter(baseAdapterConfig);
    vi.mocked(execa).mockResolvedValueOnce({
      failed: false,
      stdout: [
        "eveland-proj_alpha-dep_one.service loaded active running Eveland deployment",
        "  eveland-proj_beta-dep_two.service loaded active running Eveland deployment",
        "",
      ].join("\n"),
    } as never);

    await expect(adapter.listProcesses!("eveland-")).resolves.toEqual([
      "eveland-proj_alpha-dep_one",
      "eveland-proj_beta-dep_two",
    ]);
    expect(execa).toHaveBeenLastCalledWith(
      "systemctl",
      [
        "list-units",
        "--type=service",
        "--state=active,activating",
        "--plain",
        "--no-legend",
        "--no-pager",
        "eveland-*.service",
      ],
      expect.objectContaining({ reject: false }),
    );
  });

  test("throws when systemctl cannot list units", async () => {
    const adapter = createSystemdAdapter(baseAdapterConfig);
    vi.mocked(execa).mockResolvedValueOnce({
      failed: true,
      all: "systemctl: command not found",
    } as never);

    await expect(adapter.listProcesses!("eveland-")).rejects.toThrow(/systemctl list-units/);
  });
});

describe("createSystemdAdapter backendDistDir laziness", () => {
  test("never invokes the backendDistDir provider at construction time", () => {
    const backendDistDir = vi.fn(() => {
      throw new Error("should not be called until buildRelease runs");
    });

    expect(() => createSystemdAdapter({ ...baseAdapterConfig, backendDistDir })).not.toThrow();
    expect(backendDistDir).not.toHaveBeenCalled();
  });

  test("invokes the backendDistDir provider inside buildRelease, surfacing its error", async () => {
    const backendDistDir = vi.fn(() => {
      throw new Error("@evelandhq/sandbox-bwrap is not resolvable.");
    });
    const adapter = createSystemdAdapter({
      ...baseAdapterConfig,
      buildSandbox: "none",
      backendDistDir,
    });

    await expect(
      adapter.buildRelease({
        projectId: "proj_123",
        releaseId: "rel_789",
        sourcePath: "/data/sources/proj_123",
        buildDir: "/data/builds/proj_123/rel_789",
        commandContext: { hasLockfile: true },
      }),
    ).rejects.toThrow("@evelandhq/sandbox-bwrap is not resolvable.");
    expect(backendDistDir).toHaveBeenCalledTimes(1);
  });
});

describe("createSystemdAdapter startProcess", () => {
  test("defers recursive permission repair to an identity-aware ExecStartPre", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(writeFile).mockClear();
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await adapter.startProcess({
      processName: "eveland-proj_123-dep_456",
      releaseRef: "/data/builds/proj_123/rel_platform",
      port: 41000,
      env: {},
      commandContext: { hasLockfile: true },
      sandboxCacheDir: "/var/lib/eveland-data/sandbox/proj_123",
      memoryRootDir: "/var/lib/eveland-data/memory/proj_123",
      observabilityPolicyDir: "/var/lib/eveland-data/observability/proj_123/dep_456",
    });

    expect(vi.mocked(execa).mock.calls.slice(0, 3)).toEqual([
      ["chown", ["-R", "root:eveland-app", "/var/lib/eveland-data/observability/proj_123/dep_456"]],
      ["chmod", ["2750", "/var/lib/eveland-data/observability/proj_123/dep_456"]],
      ["chmod", ["0640", "/var/lib/eveland-data/observability/proj_123/dep_456/agent-policy.json"]],
    ]);
    expect(vi.mocked(execa).mock.calls).not.toContainEqual([
      "chmod",
      expect.arrayContaining(["-R", "/data/builds/proj_123/rel_platform"]),
    ]);
    expect(writeFile).toHaveBeenCalledWith(
      "/var/lib/eveland-data/observability/proj_123/dep_456/.dynamic-user-uid",
      "",
      { flag: "a", mode: 0o600 },
    );
    expect(writeFile).toHaveBeenCalledWith(
      "/var/lib/eveland-data/deployment-env/eveland-proj_123-dep_456.prepare-access.sh",
      expect.stringContaining(
        'if [ -z "$current_uid" ] || [ "$current_uid" != "$previous_uid" ]; then',
      ),
      { mode: 0o700 },
    );
    const systemdArgs = vi.mocked(execa).mock.calls.at(-1)?.[1];
    expect(systemdArgs).toContain(
      "--property=ExecStartPre=+/bin/sh /run/eveland/prepare-dynamic-user-access",
    );
    expect(vi.mocked(execa).mock.calls.at(-1)?.[0]).toBe("systemd-run");
  });

  test("repairs every persistent root in one pass only after the dynamic uid changes", () => {
    const script = buildDynamicUserAccessRepairScript({
      deploymentUser: "eveland-d-123",
      releaseDir: "/data/release with spaces",
      sandboxCacheDir: "/data/cache",
      memoryRootDir: "/data/memory",
    });

    expect(script).toContain(
      'if [ -z "$current_uid" ] || [ "$current_uid" != "$previous_uid" ]; then',
    );
    expect(script.match(/chmod -R/g)).toHaveLength(1);
    expect(script).toContain(
      "chmod -R g+rwX,g-s -- '/data/release with spaces' '/data/cache' '/data/memory'",
    );
    expect(script.indexOf("chmod -R")).toBeLessThan(script.indexOf("printf '%s\\n'"));
  });

  test("reads the dynamic uid from systemd's registry, not from NSS", () => {
    const script = buildDynamicUserAccessRepairScript({
      deploymentUser: "eveland-d-123",
      releaseDir: "/data/release",
      sandboxCacheDir: "/data/cache",
      memoryRootDir: "/data/memory",
    });

    expect(script).toContain("readlink '/run/systemd/dynamic-uid/direct:eveland-d-123'");
    expect(script).not.toContain("id -u");
    expect(script).not.toContain("getent");
  });

  test("does not let project env override the platform template revision", async () => {
    vi.mocked(writeFile).mockClear();
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await adapter.startProcess({
      processName: "eveland-proj_123-dep_456",
      releaseRef: "/data/builds/proj_123/rel_platform",
      port: 41000,
      env: {
        EVELAND_SANDBOX_TEMPLATE_REVISION: "project-controlled",
        OPENAI_API_KEY: "test-key",
      },
      commandContext: { hasLockfile: true },
      sandboxCacheDir: "/var/lib/eveland-data/sandbox/proj_123",
      memoryRootDir: "/var/lib/eveland-data/memory/proj_123",
      observabilityPolicyDir: "/var/lib/eveland-data/observability/proj_123/dep_456",
    });

    expect(writeFile).toHaveBeenCalledWith(
      path.join("/var/lib/eveland-data", "deployment-env", "eveland-proj_123-dep_456.env"),
      'OPENAI_API_KEY="test-key"\n',
      { mode: 0o600 },
    );
  });

  test("ensureProcess reuses an active unit that owns its port without invoking systemd-run", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({ failed: false, stdout: "active\n", all: "active\n" } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: 'LISTEN 0 511 127.0.0.1:41000 0.0.0.0:* users:(("node",pid=1234,fd=20))',
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "eveland-proj_123-dep_456.service\n",
      } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    const result = await adapter.ensureProcess!({
      processName: "eveland-proj_123-dep_456",
      releaseRef: "/data/builds/proj_123/rel_456",
      port: 41000,
      env: {},
      commandContext: { hasLockfile: true },
      sandboxCacheDir: "/var/lib/eveland-data/sandbox/proj_123",
      memoryRootDir: "/var/lib/eveland-data/memory/proj_123",
      observabilityPolicyDir: "/var/lib/eveland-data/observability/proj_123/dep_456",
    });

    expect(result.log).toContain("Reused ready systemd process");
    expect(vi.mocked(execa).mock.calls).toEqual([
      [
        "systemctl",
        ["show", "eveland-proj_123-dep_456.service", "--property=ActiveState", "--value"],
        { all: true, reject: false },
      ],
      ["ss", ["-H", "-t", "-l", "-n", "-p", "sport", "=", ":41000"], { all: true, reject: false }],
      ["ps", ["-o", "unit=", "-p", "1234"], { all: true, reject: false }],
    ]);
  });

  test("ensureProcess reuses a starting unit that has not bound its port yet", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "activating\n",
        all: "activating\n",
      } as never)
      .mockResolvedValueOnce({ failed: false, stdout: "", all: "" } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    const result = await adapter.ensureProcess!({
      processName: "eveland-proj_123-dep_456",
      releaseRef: "/data/builds/proj_123/rel_456",
      port: 41000,
      env: {},
      commandContext: { hasLockfile: true },
      sandboxCacheDir: "/var/lib/eveland-data/sandbox/proj_123",
      memoryRootDir: "/var/lib/eveland-data/memory/proj_123",
      observabilityPolicyDir: "/var/lib/eveland-data/observability/proj_123/dep_456",
    });

    expect(result.log).toContain("Reused starting systemd process");
    expect(vi.mocked(execa).mock.calls.some(([command]) => command === "systemd-run")).toBe(false);
  });

  test("ensureProcess stops the unit and fails loudly when another process holds its port", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({ failed: false, stdout: "active\n", all: "active\n" } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: 'LISTEN 0 511 127.0.0.1:41000 0.0.0.0:* users:(("node",pid=9876,fd=20))',
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "eveland-proj_other-dep_999.service\n",
      } as never)
      .mockResolvedValueOnce({ failed: false } as never)
      .mockResolvedValueOnce({ failed: false } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(
      adapter.ensureProcess!({
        processName: "eveland-proj_123-dep_456",
        releaseRef: "/data/builds/proj_123/rel_456",
        port: 41000,
        env: {},
        commandContext: { hasLockfile: true },
        sandboxCacheDir: "/var/lib/eveland-data/sandbox/proj_123",
        memoryRootDir: "/var/lib/eveland-data/memory/proj_123",
        observabilityPolicyDir: "/var/lib/eveland-data/observability/proj_123/dep_456",
      }),
    ).rejects.toThrow(/eveland-proj_other-dep_999\.service/);

    expect(vi.mocked(execa).mock.calls).toContainEqual([
      "systemctl",
      ["stop", "eveland-proj_123-dep_456.service"],
      { reject: false },
    ]);
    expect(vi.mocked(execa).mock.calls.some(([command]) => command === "systemd-run")).toBe(false);
  });

  test("collects unit state and recent journal output before cleanup", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: false,
        stdout:
          "ActiveState=activating\nSubState=auto-restart\nNRestarts=3\nExecMainStatus=1\nResult=exit-code\n",
        all: "ActiveState=activating\nSubState=auto-restart\nNRestarts=3\nExecMainStatus=1\nResult=exit-code\n",
      } as never)
      .mockResolvedValueOnce({ failed: false, all: "Eve startup failed\nstack trace" } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig) as ReturnType<
      typeof createSystemdAdapter
    > & {
      getProcessDiagnostics(processName: string): Promise<{ state: string; logs: string }>;
    };

    await expect(adapter.getProcessDiagnostics("eveland-proj_123-dep_456")).resolves.toEqual({
      state:
        "ActiveState=activating\nSubState=auto-restart\nNRestarts=3\nExecMainStatus=1\nResult=exit-code",
      logs: "Eve startup failed\nstack trace",
    });
    expect(vi.mocked(execa).mock.calls).toEqual([
      [
        "systemctl",
        [
          "show",
          "eveland-proj_123-dep_456.service",
          "--property=ActiveState,SubState,NRestarts,ExecMainCode,ExecMainStatus,Result",
          "--no-pager",
        ],
        { all: true, reject: false },
      ],
      [
        "journalctl",
        [
          "--unit",
          "eveland-proj_123-dep_456.service",
          "--lines",
          "200",
          "--no-pager",
          "--output=short-iso",
        ],
        { all: true, reject: false },
      ],
    ]);
  });
});

describe("createSystemdAdapter stopProcess", () => {
  test("deletes transient deployment files after stopping the unit", async () => {
    vi.mocked(rm).mockClear();
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await adapter.stopProcess("eveland-proj_123-dep_456");

    expect(rm).toHaveBeenCalledWith(
      path.join("/var/lib/eveland-data", "deployment-env", "eveland-proj_123-dep_456.env"),
      { force: true },
    );
    expect(rm).toHaveBeenCalledWith(
      path.join(
        "/var/lib/eveland-data",
        "deployment-env",
        "eveland-proj_123-dep_456.prepare-access.sh",
      ),
      { force: true },
    );
  });

  test("tolerates a not-loaded unit on both stop and reset-failed, and still deletes the env file", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(rm).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: true,
        exitCode: 5,
        stderr: "Unit eveland-proj_123-dep_456.service not loaded.",
        all: "",
      } as never)
      .mockResolvedValueOnce({
        failed: true,
        exitCode: 5,
        stderr: "Unit eveland-proj_123-dep_456.service not loaded.",
        all: "",
      } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(adapter.stopProcess("eveland-proj_123-dep_456")).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledWith(
      path.join("/var/lib/eveland-data", "deployment-env", "eveland-proj_123-dep_456.env"),
      { force: true },
    );
    expect(rm).toHaveBeenCalledWith(
      path.join(
        "/var/lib/eveland-data",
        "deployment-env",
        "eveland-proj_123-dep_456.prepare-access.sh",
      ),
      { force: true },
    );
  });

  test("throws naming the command and stderr when systemctl stop fails for an unknown reason", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({
      failed: true,
      exitCode: 1,
      stderr: "Access denied",
      all: "",
    } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(adapter.stopProcess("eveland-proj_123-dep_456")).rejects.toThrow(
      /systemctl stop eveland-proj_123-dep_456\.service failed/,
    );
  });

  test("throws when reset-failed fails for an unknown reason even though stop succeeded", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({ failed: false, exitCode: 0, stderr: "", all: "" } as never)
      .mockResolvedValueOnce({
        failed: true,
        exitCode: 1,
        stderr: "Access denied",
        all: "",
      } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(adapter.stopProcess("eveland-proj_123-dep_456")).rejects.toThrow(
      /systemctl reset-failed eveland-proj_123-dep_456\.service failed/,
    );
  });

  test("throws when systemctl itself cannot be spawned (ENOENT, no exit code or stderr)", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({
      failed: true,
      exitCode: undefined,
      stderr: "",
      all: "",
    } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(adapter.stopProcess("eveland-proj_123-dep_456")).rejects.toThrow(/systemctl stop/);
  });
});

describe("isBenignSystemctlStopFailure", () => {
  test("tolerates a successful call", () => {
    expect(isBenignSystemctlStopFailure({ failed: false })).toBe(true);
  });

  test("tolerates a not-loaded unit -- the idempotent no-op case", () => {
    expect(
      isBenignSystemctlStopFailure({
        failed: true,
        exitCode: 5,
        stderr: "Unit eveland-proj_123-dep_456.service not loaded.",
      }),
    ).toBe(true);
  });

  test("tolerates the 'not loaded, or not found' phrasing from newer systemd", () => {
    expect(
      isBenignSystemctlStopFailure({
        failed: true,
        exitCode: 5,
        stderr: "Unit eveland-proj_123-dep_456.service not loaded, or not found.",
      }),
    ).toBe(true);
  });

  test("does not tolerate a spawn failure (systemctl missing, no exit code or stderr)", () => {
    expect(isBenignSystemctlStopFailure({ failed: true, exitCode: undefined, stderr: "" })).toBe(
      false,
    );
  });

  test("does not tolerate an unknown non-zero exit", () => {
    expect(
      isBenignSystemctlStopFailure({ failed: true, exitCode: 1, stderr: "Access denied" }),
    ).toBe(false);
  });
});

describe("createSystemdAdapter buildRelease (sandbox injection)", () => {
  test("fails closed when final scheduler definitions cannot be read", async () => {
    vi.mocked(readReleaseSchedulerDefinitions).mockRejectedValueOnce(
      new Error("Required scheduler definitions are missing."),
    );
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none" });

    await expect(
      adapter.buildRelease({
        projectId: "proj_123",
        releaseId: "rel_789",
        sourcePath: "/data/sources/proj_123",
        buildDir: "/data/builds/proj_123/rel_789",
        commandContext: { hasLockfile: true },
      }),
    ).rejects.toThrow(/required scheduler definitions/i);
    expect(readReleaseDiscovery).toHaveBeenCalled();
  });

  test("injects the sandbox after cp -a and before the build command, then creates and chowns the project cache dir", async () => {
    vi.mocked(injectSandboxModules).mockResolvedValueOnce({
      generated: ["agent/sandbox.js"],
      replaced: [],
      wrapped: [],
    });
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none" });

    const result = await adapter.buildRelease({
      projectId: "proj_123",
      releaseId: "rel_789",
      sourcePath: "/data/sources/proj_123",
      buildDir: "/data/builds/proj_123/rel_789",
      commandContext: { hasLockfile: true },
    });

    const execaCalls = vi.mocked(execa).mock.calls;
    const cpCallIndex = execaCalls.findIndex(([cmd]) => cmd === "cp");
    const buildCallIndex = execaCalls.findIndex(([cmd]) => cmd === "runuser");
    expect(cpCallIndex).toBeGreaterThanOrEqual(0);
    expect(buildCallIndex).toBeGreaterThan(cpCallIndex);

    const cpOrder = vi.mocked(execa).mock.invocationCallOrder[cpCallIndex]!;
    const buildOrder = vi.mocked(execa).mock.invocationCallOrder[buildCallIndex]!;
    const injectOrder = vi.mocked(injectSandboxModules).mock.invocationCallOrder[0]!;
    expect(cpOrder).toBeLessThan(injectOrder);
    expect(injectOrder).toBeLessThan(buildOrder);

    expect(injectSandboxModules).toHaveBeenCalledWith({
      releaseDir: path.resolve("/data/builds/proj_123/rel_789"),
      backendDistDir: "/opt/sandbox-bwrap/dist",
    });

    const cacheDir = path.resolve("/var/lib/eveland-data/sandbox", "proj_123");
    expect(mkdir).toHaveBeenCalledWith(cacheDir, { recursive: true });

    const chownCalls = execaCalls.filter(([cmd]) => cmd === "chown").map(([, args]) => args);
    expect(chownCalls).toContainEqual([
      "-R",
      "eveland-app:",
      path.resolve("/data/builds/proj_123/rel_789"),
    ]);
    expect(chownCalls).toContainEqual(["-R", "eveland-app:", cacheDir]);
    expect(execaCalls).toContainEqual([
      "chmod",
      ["-R", "g+rwX,g-s", path.resolve("/data/builds/proj_123/rel_789")],
    ]);
    expect(execaCalls).toContainEqual(["chmod", ["-R", "g+rwX,g-s", cacheDir]]);

    expect(result.log).toContain("Injected eve sandbox modules: agent/sandbox.js");
    expect(result.log).not.toContain("WARNING");
  });

  test("reports every authored sandbox whose lifecycle is preserved", async () => {
    vi.mocked(injectSandboxModules).mockResolvedValueOnce({
      generated: ["agent/sandbox.js"],
      replaced: [],
      wrapped: ["agent/sandbox.ts", "agent/subagents/researcher/sandbox.js"],
    });
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none" });

    const result = await adapter.buildRelease({
      projectId: "proj_123",
      releaseId: "rel_789",
      sourcePath: "/data/sources/proj_123",
      buildDir: "/data/builds/proj_123/rel_789",
      commandContext: { hasLockfile: true },
    });

    expect(result.log).toContain("agent/sandbox.ts, agent/subagents/researcher/sandbox.js");
    expect(result.log).toContain("overrides only the backend");
    expect(result.log).toContain("bootstrap()");
    expect(result.log).toContain("onSession()");
    expect(result.log).toContain("revalidationKey");
    expect(result.log).not.toContain("are not used");
  });
});

describe("createSystemdAdapter buildRelease (build user handover)", () => {
  test("chowns the release and npm cache to the build user before the build, then to the app user after (none mode)", async () => {
    vi.mocked(execa).mockClear();
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none" });

    await adapter.buildRelease({
      projectId: "proj_123",
      releaseId: "rel_789",
      sourcePath: "/data/sources/proj_123",
      buildDir: "/data/builds/proj_123/rel_789",
      commandContext: { hasLockfile: true },
    });

    const releaseDir = path.resolve("/data/builds/proj_123/rel_789");
    const npmCacheDir = path.resolve("/var/lib/eveland-data", "npm-cache");
    const cacheDir = path.resolve("/var/lib/eveland-data/sandbox", "proj_123");

    const calls = vi.mocked(execa).mock.calls;
    const order = vi.mocked(execa).mock.invocationCallOrder;

    const buildUserChownReleaseIndex = calls.findIndex(
      ([cmd, args]) =>
        cmd === "chown" &&
        Array.isArray(args) &&
        args[1] === "eveland-build:" &&
        args[2] === releaseDir,
    );
    const buildUserChownCacheIndex = calls.findIndex(
      ([cmd, args]) =>
        cmd === "chown" &&
        Array.isArray(args) &&
        args[1] === "eveland-build:" &&
        args[2] === npmCacheDir,
    );
    const runuserIndex = calls.findIndex(([cmd]) => cmd === "runuser");
    const appUserChownReleaseIndex = calls.findIndex(
      ([cmd, args]) =>
        cmd === "chown" &&
        Array.isArray(args) &&
        args[1] === "eveland-app:" &&
        args[2] === releaseDir,
    );
    const appUserChownCacheIndex = calls.findIndex(
      ([cmd, args]) =>
        cmd === "chown" &&
        Array.isArray(args) &&
        args[1] === "eveland-app:" &&
        args[2] === cacheDir,
    );

    expect(buildUserChownReleaseIndex).toBeGreaterThanOrEqual(0);
    expect(buildUserChownCacheIndex).toBeGreaterThanOrEqual(0);
    expect(runuserIndex).toBeGreaterThanOrEqual(0);
    expect(appUserChownReleaseIndex).toBeGreaterThanOrEqual(0);
    expect(appUserChownCacheIndex).toBeGreaterThanOrEqual(0);

    // chown-to-build-user happens before the build call; chown-to-app-user after.
    expect(order[buildUserChownReleaseIndex]!).toBeLessThan(order[runuserIndex]!);
    expect(order[buildUserChownCacheIndex]!).toBeLessThan(order[runuserIndex]!);
    expect(order[runuserIndex]!).toBeLessThan(order[appUserChownReleaseIndex]!);
    expect(order[runuserIndex]!).toBeLessThan(order[appUserChownCacheIndex]!);

    // execa's overloaded signature makes Parameters<> resolve to a union of tuple
    // shapes; cast the found call to the (file, args, options) shape actually used
    // by every call site in systemd.ts so the destructure below type-checks.
    const [, runuserArgs, runuserOptions] = calls[runuserIndex]! as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    // HOME rides as an `env` wrapper inside the runuser'd argv, not as an execa
    // env var: runuser (without -m) resets HOME to the build user's own passwd
    // entry after the user switch, so an execa-env HOME would never survive.
    expect(runuserArgs).toEqual([
      "-u",
      "eveland-build",
      "--",
      "env",
      `HOME=${releaseDir}`,
      "sh",
      "-lc",
      "npm ci && npx eve build && npx eve info --json >/dev/null",
    ]);
    expect(runuserOptions).toMatchObject({
      all: true,
      cwd: releaseDir,
      env: { npm_config_cache: npmCacheDir },
      extendEnv: false,
    });
    // The execa env must never carry HOME (it would be discarded by runuser
    // anyway) nor any worker secret -- see the dedicated secrecy test below.
    expect(runuserOptions.env).not.toHaveProperty("HOME");
  });

  test("wraps the bwrap invocation with runuser in bwrap mode, keeping the inner bwrap argv unchanged", async () => {
    vi.mocked(execa).mockClear();
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "bwrap" });

    await adapter.buildRelease({
      projectId: "proj_123",
      releaseId: "rel_789",
      sourcePath: "/data/sources/proj_123",
      buildDir: "/data/builds/proj_123/rel_789",
      commandContext: { hasLockfile: true },
    });

    const releaseDir = path.resolve("/data/builds/proj_123/rel_789");
    const npmCacheDir = path.resolve("/var/lib/eveland-data", "npm-cache");
    const dataDir = path.resolve("/var/lib/eveland-data");

    const calls = vi.mocked(execa).mock.calls;
    const runuserCall = calls.find(([cmd]) => cmd === "runuser");
    expect(runuserCall).toBeDefined();
    // See the cast comment in the sibling "none mode" test above.
    const [, args, options] = runuserCall! as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];

    expect(args).toEqual([
      "-u",
      "eveland-build",
      "--",
      "bwrap",
      ...buildBwrapArgs({
        releaseDir,
        npmCacheDir,
        dataDir,
        command: "npm ci && npx eve build && npx eve info --json >/dev/null",
      }),
    ]);
    // buildBwrapArgs (asserted above) already carries `--setenv HOME
    // <releaseDir>` inside the sandbox -- runuser (without -m) would discard
    // an execa-env HOME after the user switch, so it must not ride here.
    expect(options).toMatchObject({
      all: true,
      env: { npm_config_cache: npmCacheDir },
      extendEnv: false,
    });
    expect(options.env as Record<string, unknown>).not.toHaveProperty("HOME");
  });

  test("passes extendEnv:false and only PATH/npm_config_cache in the build env, excluding worker secrets even when process.env carries them", async () => {
    vi.mocked(execa).mockClear();
    const secretEnvKeys = ["APP_SECRET_KEY", "DATABASE_URL", "WORKFLOW_POSTGRES_URL"] as const;
    const originalValues = secretEnvKeys.map((key) => process.env[key]);
    secretEnvKeys.forEach((key) => {
      process.env[key] = `secret-value-for-${key}`;
    });

    try {
      const npmCacheDir = path.resolve("/var/lib/eveland-data", "npm-cache");

      for (const buildSandbox of ["bwrap", "none"] as const) {
        vi.mocked(execa).mockClear();
        const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox });

        await adapter.buildRelease({
          projectId: "proj_123",
          releaseId: "rel_789",
          sourcePath: "/data/sources/proj_123",
          buildDir: "/data/builds/proj_123/rel_789",
          commandContext: { hasLockfile: true },
        });

        const calls = vi.mocked(execa).mock.calls;
        const runuserCall = calls.find(([cmd]) => cmd === "runuser");
        expect(runuserCall).toBeDefined();
        const [, , options] = runuserCall! as unknown as [
          string,
          string[],
          Record<string, unknown>,
        ];

        expect(options.extendEnv).toBe(false);
        expect(options.env).toEqual({
          PATH: process.env.PATH,
          npm_config_cache: npmCacheDir,
        });
        for (const key of secretEnvKeys) {
          expect(options.env).not.toHaveProperty(key);
        }
      }
    } finally {
      secretEnvKeys.forEach((key, index) => {
        const original = originalValues[index];
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      });
    }
  });
});

describe("createSystemdAdapter buildRelease (no sandbox roots found)", () => {
  test("still vendors and verifies, but warns loudly instead of failing the build", async () => {
    vi.mocked(injectSandboxModules).mockResolvedValueOnce({
      generated: [],
      replaced: [],
      wrapped: [],
    });
    vi.mocked(verifySandbox).mockClear();
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none" });

    const result = await adapter.buildRelease({
      projectId: "proj_123",
      releaseId: "rel_789",
      sourcePath: "/data/sources/proj_123",
      buildDir: "/data/builds/proj_123/rel_789",
      commandContext: { hasLockfile: true },
    });

    const cacheDir = path.resolve("/var/lib/eveland-data/sandbox", "proj_123");
    expect(verifySandbox).toHaveBeenCalledWith({
      releaseDir: path.resolve("/data/builds/proj_123/rel_789"),
      user: "eveland-app",
      cacheDir,
    });
    expect(result.log).toContain("Injected eve sandbox modules: none");
    expect(result.log).toMatch(/WARNING.*no agent\/ directory/i);
    expect(result.log).toContain("default");
  });
});

describe("createSystemdAdapter buildRelease (sandbox verify)", () => {
  test("verifies the sandbox after both chowns, as the service user against the release and cache dirs", async () => {
    vi.mocked(verifySandbox).mockClear();
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none" });

    const result = await adapter.buildRelease({
      projectId: "proj_123",
      releaseId: "rel_789",
      sourcePath: "/data/sources/proj_123",
      buildDir: "/data/builds/proj_123/rel_789",
      commandContext: { hasLockfile: true },
    });

    const cacheDir = path.resolve("/var/lib/eveland-data/sandbox", "proj_123");
    expect(verifySandbox).toHaveBeenCalledWith({
      releaseDir: path.resolve("/data/builds/proj_123/rel_789"),
      user: "eveland-app",
      cacheDir,
    });

    const chownCalls = vi.mocked(execa).mock.calls;
    const lastChownIndex = chownCalls.map(([cmd]) => cmd).lastIndexOf("chown");
    const lastChownOrder = vi.mocked(execa).mock.invocationCallOrder[lastChownIndex]!;
    const verifyOrder = vi.mocked(verifySandbox).mock.invocationCallOrder[0]!;
    expect(verifyOrder).toBeGreaterThan(lastChownOrder);

    expect(result.log).toContain("Sandbox self-check passed");
  });

  test("propagates a verify failure so the build itself fails", async () => {
    vi.mocked(verifySandbox).mockRejectedValueOnce(
      new Error("sandbox self-check failed: bwrap missing"),
    );
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none" });

    await expect(
      adapter.buildRelease({
        projectId: "proj_123",
        releaseId: "rel_789",
        sourcePath: "/data/sources/proj_123",
        buildDir: "/data/builds/proj_123/rel_789",
        commandContext: { hasLockfile: true },
      }),
    ).rejects.toThrow("sandbox self-check failed: bwrap missing");
  });
});

describe("buildRunAsUserArgs", () => {
  test("wraps an argv with runuser's user-select and argument-terminator flags", () => {
    expect(buildRunAsUserArgs("eveland-build", ["sh", "-lc", "npm ci"])).toEqual([
      "-u",
      "eveland-build",
      "--",
      "sh",
      "-lc",
      "npm ci",
    ]);
  });

  test("leaves the wrapped argv's own arguments untouched, including nested flags", () => {
    expect(buildRunAsUserArgs("eveland-build", ["bwrap", "--ro-bind", "/", "/"])).toEqual([
      "-u",
      "eveland-build",
      "--",
      "bwrap",
      "--ro-bind",
      "/",
      "/",
    ]);
  });
});

describe("buildEnvFileContent", () => {
  test("writes sorted, quoted assignments with escaped quotes and backslashes", () => {
    const content = buildEnvFileContent({ B_KEY: 'va"lue', A_KEY: "back\\slash" });
    expect(content).toBe('A_KEY="back\\\\slash"\nB_KEY="va\\"lue"\n');
  });

  test("rejects values containing newlines", () => {
    expect(() => buildEnvFileContent({ BAD: "line1\nline2" })).toThrow(/newline/);
  });
});

describe("createSystemdAdapter verifyPortOwnership", () => {
  const ownershipInput = { processName: "eveland-proj_123-dep_456", port: 41032 };

  test("reports owned when a listener pid belongs to the unit", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: false,
        stdout: [
          'LISTEN 0 511 127.0.0.1:41032 0.0.0.0:* users:(("npm",pid=1200,fd=18))',
          'LISTEN 0 511 127.0.0.1:41032 0.0.0.0:* users:(("node",pid=1234,fd=20))',
        ].join("\n"),
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "eveland-proj_other-dep_9.service\n",
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "eveland-proj_123-dep_456.service\n",
      } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(adapter.verifyPortOwnership!(ownershipInput)).resolves.toEqual({
      status: "owned",
    });
    expect(vi.mocked(execa).mock.calls[0]).toEqual([
      "ss",
      ["-H", "-t", "-l", "-n", "-p", "sport", "=", ":41032"],
      { all: true, reject: false },
    ]);
  });

  test("reports foreign with the holding unit when only another process listens", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: false,
        stdout: 'LISTEN 0 511 127.0.0.1:41032 0.0.0.0:* users:(("node",pid=9876,fd=20))',
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "eveland-proj_other-dep_9.service\n",
      } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(adapter.verifyPortOwnership!(ownershipInput)).resolves.toEqual({
      status: "foreign",
      holder: "pid 9876 (unit eveland-proj_other-dep_9.service)",
    });
  });

  test("reports foreign even when the holder's unit cannot be resolved", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: false,
        stdout: 'LISTEN 0 511 127.0.0.1:41032 0.0.0.0:* users:(("node",pid=9876,fd=20))',
      } as never)
      .mockResolvedValueOnce({ failed: true, stdout: "" } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(adapter.verifyPortOwnership!(ownershipInput)).resolves.toEqual({
      status: "foreign",
      holder: "pid 9876",
    });
  });

  test("reports unbound when nothing listens on the port", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({ failed: false, stdout: "" } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(adapter.verifyPortOwnership!(ownershipInput)).resolves.toEqual({
      status: "unbound",
    });
  });

  test("fails loudly instead of passing silently when ss itself fails", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa).mockResolvedValueOnce({ failed: true, all: "ss: command not found" } as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(adapter.verifyPortOwnership!(ownershipInput)).rejects.toThrow(
      /ss.*command not found/,
    );
  });
});

describe("createSystemdAdapter startProcess failure cleanup", () => {
  test("deletes the decrypted env file and repair script when systemd-run fails", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(rm).mockClear();
    vi.mocked(execa).mockImplementation((async (command: unknown) => {
      if (command === "systemd-run") throw new Error("Failed to start transient service unit");
      return { all: "", stdout: "", stderr: "" };
    }) as never);
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await expect(
      adapter.startProcess({
        processName: "eveland-proj_123-dep_456",
        releaseRef: "/data/builds/proj_123/rel_456",
        port: 41000,
        env: { OPENAI_API_KEY: "secret" },
        commandContext: { hasLockfile: true },
        sandboxCacheDir: "/var/lib/eveland-data/sandbox/proj_123",
        memoryRootDir: "/var/lib/eveland-data/memory/proj_123",
        observabilityPolicyDir: "/var/lib/eveland-data/observability/proj_123/dep_456",
      }),
    ).rejects.toThrow(/transient service unit/);

    expect(vi.mocked(rm).mock.calls).toEqual(
      expect.arrayContaining([
        ["/var/lib/eveland-data/deployment-env/eveland-proj_123-dep_456.env", { force: true }],
        [
          "/var/lib/eveland-data/deployment-env/eveland-proj_123-dep_456.prepare-access.sh",
          { force: true },
        ],
      ]),
    );
    vi.mocked(execa).mockReset();
    vi.mocked(execa).mockResolvedValue({ all: "", stdout: "", stderr: "" } as never);
  });
});
