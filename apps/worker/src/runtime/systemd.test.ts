import { describe, expect, test, vi } from "vitest";
import path from "node:path";
import { execa } from "execa";
import { mkdir, rm } from "node:fs/promises";
import {
  buildBwrapArgs,
  buildEnvFileContent,
  buildReleaseBuildCommand,
  buildSystemdRunArgs,
  buildSystemdStartCommand,
  createSystemdAdapter,
  resolveProjectSandboxCacheDir,
  resolveSandboxCacheRoot,
} from "./systemd.js";
import { injectSandboxModules } from "./sandbox-inject.js";
import { verifySandbox } from "./sandbox-verify.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ all: "", stdout: "", stderr: "" }),
}));

// injectSandboxModules is exercised end-to-end in sandbox-inject.test.ts against a
// real filesystem fixture; here it's mocked so createSystemdAdapter's buildRelease
// tests can pin call *ordering* and the cache-dir/log-prefixing wiring in isolation.
vi.mock("./sandbox-inject.js", () => ({
  injectSandboxModules: vi.fn().mockResolvedValue({ generated: ["agent/sandbox.js"], replaced: [] }),
}));

// verifySandbox shells out to the real vendored backend under systemd-run; it has its
// own boundary tests in sandbox-verify.test.ts. Mocked here (mirroring injectSandboxModules
// above) so createSystemdAdapter's buildRelease tests can pin call ordering and log wiring
// without depending on the generic execa mock's shape (no exitCode/marker) below.
vi.mock("./sandbox-verify.js", () => ({
  verifySandbox: vi.fn().mockResolvedValue(undefined),
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
      command: "npx eve start --host 127.0.0.1 --port 41000",
    });

    expect(args).toEqual([
      "--unit",
      "eveland-proj_123-dep_456",
      "--collect",
      "--service-type=exec",
      "--property=Restart=on-failure",
      "--property=RestartSec=2",
      "--property=User=eveland-app",
      "--property=WorkingDirectory=/data/builds/proj_123/rel_789",
      "--property=EnvironmentFile=/data/deployment-env/eveland-proj_123-dep_456.env",
      "--property=Environment=PORT=41000",
      "--property=Environment=EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland-data/sandbox/proj_123",
      "--property=MemoryMax=2G",
      "--property=CPUQuota=200%",
      "--property=ProtectSystem=strict",
      "--property=ReadWritePaths=/data/builds/proj_123/rel_789",
      "--property=ReadWritePaths=/var/lib/eveland-data/sandbox/proj_123",
      "--property=PrivateTmp=yes",
      "--property=NoNewPrivileges=yes",
      "sh",
      "-lc",
      "npx eve start --host 127.0.0.1 --port 41000",
    ]);
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
      command: "npx eve start",
    });

    expect(args).toContain("--property=ReadWritePaths=/rel");
    expect(args).toContain("--property=ReadWritePaths=/var/lib/eveland-data/sandbox/p");
    expect(args).toContain("--property=Environment=EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland-data/sandbox/p");
    // The env file must still be read before PORT is forced.
    expect(args.indexOf("--property=EnvironmentFile=/env/p.env")).toBeLessThan(args.indexOf("--property=Environment=PORT=41000"));
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
    expect(resolveSandboxCacheRoot({ EVELAND_DATA_DIR: "/var/lib/eveland-data" } as NodeJS.ProcessEnv)).toBe(
      path.resolve("/var/lib/eveland-data", "sandbox"),
    );
  });

  test("defaults to .eveland-data/sandbox when neither env var is set", () => {
    expect(resolveSandboxCacheRoot({} as NodeJS.ProcessEnv)).toBe(path.resolve(".eveland-data", "sandbox"));
  });
});

describe("buildSystemdStartCommand", () => {
  test("serves eve projects on loopback without any bridge hack", () => {
    const command = buildSystemdStartCommand({ isEveProject: true, hasLockfile: true, scripts: {} }, 41000);
    expect(command).toBe("npx eve start --host 127.0.0.1 --port 41000");
  });

  test("falls back to the inferred runtime command for plain node projects", () => {
    const command = buildSystemdStartCommand({ isEveProject: false, hasLockfile: false, scripts: { start: "node server.js" } }, 41000);
    expect(command).toBe("npm run start");
  });
});

describe("buildReleaseBuildCommand", () => {
  test("uses npm ci and eve build when a lockfile and eve dependency exist", () => {
    expect(buildReleaseBuildCommand({ isEveProject: true, hasLockfile: true, scripts: {} })).toBe("npm ci && npx eve build");
  });

  test("uses npm install without eve build for plain projects without a lockfile", () => {
    expect(buildReleaseBuildCommand({ isEveProject: false, hasLockfile: false, scripts: {} })).toBe("npm install");
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
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--tmpfs", "/var/lib/eveland-data",
      "--bind", "/var/lib/eveland-data/builds/proj_123/rel_789", "/var/lib/eveland-data/builds/proj_123/rel_789",
      "--bind", "/var/lib/eveland-data/npm-cache", "/var/lib/eveland-data/npm-cache",
      "--unshare-pid",
      "--die-with-parent",
      "--chdir", "/var/lib/eveland-data/builds/proj_123/rel_789",
      "sh", "-lc", "npm ci && npx eve build",
    ]);
  });
});

const baseAdapterConfig = {
  dataDir: "/var/lib/eveland-data",
  user: "eveland-app",
  memoryMax: "2G",
  cpuQuota: "200%",
  buildSandbox: "bwrap" as const,
  sandboxCacheDir: "/var/lib/eveland-data/sandbox",
  backendDistDir: () => "/opt/sandbox-bwrap/dist",
};

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
      throw new Error("@eveland/sandbox-bwrap is not resolvable.");
    });
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none", backendDistDir });

    await expect(
      adapter.buildRelease({
        projectId: "proj_123",
        releaseId: "rel_789",
        sourcePath: "/data/sources/proj_123",
        buildDir: "/data/builds/proj_123/rel_789",
        commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
      }),
    ).rejects.toThrow("@eveland/sandbox-bwrap is not resolvable.");
    expect(backendDistDir).toHaveBeenCalledTimes(1);
  });
});

describe("createSystemdAdapter stopProcess", () => {
  test("deletes the deployment env file after stopping the unit, tolerating an already-missing file", async () => {
    const adapter = createSystemdAdapter(baseAdapterConfig);

    await adapter.stopProcess("eveland-proj_123-dep_456");

    expect(rm).toHaveBeenCalledWith(
      path.join("/var/lib/eveland-data", "deployment-env", "eveland-proj_123-dep_456.env"),
      { force: true },
    );
  });
});

describe("createSystemdAdapter buildRelease (sandbox injection)", () => {
  test("injects the sandbox after cp -a and before the build command, then creates and chowns the project cache dir", async () => {
    vi.mocked(injectSandboxModules).mockResolvedValueOnce({ generated: ["agent/sandbox.js"], replaced: [] });
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none" });

    const result = await adapter.buildRelease({
      projectId: "proj_123",
      releaseId: "rel_789",
      sourcePath: "/data/sources/proj_123",
      buildDir: "/data/builds/proj_123/rel_789",
      commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
    });

    const execaCalls = vi.mocked(execa).mock.calls;
    const cpCallIndex = execaCalls.findIndex(([cmd]) => cmd === "cp");
    const buildCallIndex = execaCalls.findIndex(([cmd]) => cmd === "sh");
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
    expect(chownCalls).toContainEqual(["-R", "eveland-app:", path.resolve("/data/builds/proj_123/rel_789")]);
    expect(chownCalls).toContainEqual(["-R", "eveland-app:", cacheDir]);

    expect(result.log).toContain("Injected eve sandbox modules: agent/sandbox.js");
    expect(result.log).not.toContain("WARNING");
  });

  test("prefixes a loud warning listing every replaced authored sandbox module", async () => {
    vi.mocked(injectSandboxModules).mockResolvedValueOnce({
      generated: ["agent/sandbox.js"],
      replaced: ["agent/sandbox.ts", "agent/subagents/researcher/sandbox.js"],
    });
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none" });

    const result = await adapter.buildRelease({
      projectId: "proj_123",
      releaseId: "rel_789",
      sourcePath: "/data/sources/proj_123",
      buildDir: "/data/builds/proj_123/rel_789",
      commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
    });

    expect(result.log).toContain(
      "WARNING: replaced the project's authored sandbox (agent/sandbox.ts, agent/subagents/researcher/sandbox.js)",
    );
    expect(result.log).toContain("bootstrap()");
    expect(result.log).toContain("onSession()");
    expect(result.log).toContain("workspace seeds are NOT used");
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
      commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
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
    vi.mocked(verifySandbox).mockRejectedValueOnce(new Error("sandbox self-check failed: bwrap missing"));
    const adapter = createSystemdAdapter({ ...baseAdapterConfig, buildSandbox: "none" });

    await expect(
      adapter.buildRelease({
        projectId: "proj_123",
        releaseId: "rel_789",
        sourcePath: "/data/sources/proj_123",
        buildDir: "/data/builds/proj_123/rel_789",
        commandContext: { isEveProject: true, hasLockfile: true, scripts: {} },
      }),
    ).rejects.toThrow("sandbox self-check failed: bwrap missing");
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
