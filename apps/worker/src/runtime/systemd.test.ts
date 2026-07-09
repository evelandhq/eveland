import { describe, expect, test } from "vitest";
import { buildBwrapArgs, buildEnvFileContent, buildReleaseBuildCommand, buildSystemdRunArgs, buildSystemdStartCommand } from "./systemd.js";

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
  test("mounts the rootfs read-only with a writable release dir and npm cache", () => {
    const args = buildBwrapArgs({
      releaseDir: "/data/builds/proj_123/rel_789",
      npmCacheDir: "/data/npm-cache",
      command: "npm ci && npx eve build",
    });

    expect(args).toEqual([
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--bind", "/data/builds/proj_123/rel_789", "/data/builds/proj_123/rel_789",
      "--bind", "/data/npm-cache", "/data/npm-cache",
      "--unshare-pid",
      "--die-with-parent",
      "--chdir", "/data/builds/proj_123/rel_789",
      "sh", "-lc", "npm ci && npx eve build",
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
