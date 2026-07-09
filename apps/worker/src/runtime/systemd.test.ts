import { describe, expect, test, vi } from "vitest";
import path from "node:path";
import { rm } from "node:fs/promises";
import { buildBwrapArgs, buildEnvFileContent, buildReleaseBuildCommand, buildSystemdRunArgs, buildSystemdStartCommand, createSystemdAdapter } from "./systemd.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ all: "", stdout: "", stderr: "" }),
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
      "--property=MemoryMax=2G",
      "--property=CPUQuota=200%",
      "--property=ProtectSystem=strict",
      "--property=ReadWritePaths=/data/builds/proj_123/rel_789",
      "--property=PrivateTmp=yes",
      "--property=NoNewPrivileges=yes",
      "sh",
      "-lc",
      "npx eve start --host 127.0.0.1 --port 41000",
    ]);
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

describe("createSystemdAdapter stopProcess", () => {
  test("deletes the deployment env file after stopping the unit, tolerating an already-missing file", async () => {
    const adapter = createSystemdAdapter({
      dataDir: "/var/lib/eveland-data",
      user: "eveland-app",
      memoryMax: "2G",
      cpuQuota: "200%",
      buildSandbox: "bwrap",
    });

    await adapter.stopProcess("eveland-proj_123-dep_456");

    expect(rm).toHaveBeenCalledWith(
      path.join("/var/lib/eveland-data", "deployment-env", "eveland-proj_123-dep_456.env"),
      { force: true },
    );
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
