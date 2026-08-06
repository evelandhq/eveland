import { describe, expect, test, vi } from "vitest";
import { execa } from "execa";
import {
  assertWorkerPreflight,
  collectSystemdPreflightIssues,
  probeDockerNetworkPool,
  type PreflightDeps,
} from "./preflight.js";
import { SANDBOX_TOOLCHAIN_COMMANDS } from "./sandbox-toolchain.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

/**
 * Every dep passing by default so each test only needs to override the one
 * thing it's exercising. `canTraverseAs`/`userExists` etc. are `vi.fn()` so
 * tests can also assert a dep was (or wasn't) invoked at all. `commandExists`
 * and `userExists` return `true` for any name, so this fixture needs no edit
 * when a check gains another required binary (e.g. `runuser`) or user (e.g.
 * the build user) -- every name it's asked about already passes.
 */
function makePassingDeps(
  env: NodeJS.ProcessEnv = { EVELAND_RUNTIME: "systemd", EVELAND_DATA_DIR: "/var/lib/eveland" },
): PreflightDeps {
  return {
    env,
    platform: "linux",
    getuid: vi.fn(() => 0),
    pathExists: vi.fn(async () => true),
    isDirectory: vi.fn(async () => true),
    mkdir: vi.fn(async () => {}),
    commandExists: vi.fn(async () => true),
    userExists: vi.fn(async () => true),
    groupExists: vi.fn(async () => true),
    canTraverseAs: vi.fn(async () => true),
    backendDistDir: vi.fn(() => "/opt/eveland/dist"),
    probeDockerNetworkPool: vi.fn(async () => undefined),
  };
}

const productionSchedulerEnv = {
  EVELAND_SCHEDULER_RUNTIME_SECRET: "scheduler-runtime-secret-at-least-32-bytes",
  EVELAND_SCHEDULER_DISPATCH_SECRET: "scheduler-dispatch-secret-at-least-32-bytes",
  EVELAND_SCHEDULER_REDEEM_URL: "http://127.0.0.1:4000/internal/scheduler/dispatch",
};

describe("assertWorkerPreflight", () => {
  test("allocates and removes one disposable Docker bridge", async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never);

    await expect(probeDockerNetworkPool()).resolves.toBeUndefined();

    const [create, remove] = vi.mocked(execa).mock.calls.slice(-2);
    expect(create?.[0]).toBe("docker");
    expect(create?.[1]).toEqual(expect.arrayContaining(["network", "create"]));
    const networkName = (create![1] as string[]).at(-1);
    expect(remove).toEqual([
      "docker",
      ["network", "rm", networkName],
      { all: true, reject: false },
    ]);
  });

  test("checks Docker bridge allocation without running systemd host probes", async () => {
    const deps = makePassingDeps({});
    await assertWorkerPreflight({}, deps);
    expect(deps.probeDockerNetworkPool).toHaveBeenCalledOnce();
    expect(deps.getuid).not.toHaveBeenCalled();
    expect(deps.pathExists).not.toHaveBeenCalled();
    expect(deps.commandExists).not.toHaveBeenCalled();
    expect(deps.userExists).not.toHaveBeenCalled();
    expect(deps.groupExists).not.toHaveBeenCalled();
    expect(deps.canTraverseAs).not.toHaveBeenCalled();
    expect(deps.backendDistDir).not.toHaveBeenCalled();
  });

  test("checks Docker bridge allocation for an explicit docker runtime", async () => {
    const deps = makePassingDeps({ EVELAND_RUNTIME: "docker" });
    await expect(
      assertWorkerPreflight({ EVELAND_RUNTIME: "docker" }, deps),
    ).resolves.toBeUndefined();
    expect(deps.probeDockerNetworkPool).toHaveBeenCalledOnce();
    expect(deps.commandExists).not.toHaveBeenCalled();
  });

  test("fails before deployment when Docker cannot allocate another bridge subnet", async () => {
    const deps = makePassingDeps({ EVELAND_RUNTIME: "docker" });
    deps.probeDockerNetworkPool = vi.fn(
      async () => "all predefined address pools have been fully subnetted",
    );

    await expect(assertWorkerPreflight({ EVELAND_RUNTIME: "docker" }, deps)).rejects.toThrow(
      /default-address-pools/,
    );
    await expect(assertWorkerPreflight({ EVELAND_RUNTIME: "docker" }, deps)).rejects.toThrow(
      /fully subnetted/,
    );
  });

  test("rejects an invalid APP_SECRET_KEY before a docker worker starts", async () => {
    await expect(
      assertWorkerPreflight({
        EVELAND_RUNTIME: "docker",
        APP_SECRET_KEY: "1234567890123456789012345678901",
      }),
    ).rejects.toThrow("APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.");
  });

  test("rejects missing scheduler secrets before a production docker worker starts", async () => {
    await expect(
      assertWorkerPreflight({ NODE_ENV: "production", EVELAND_RUNTIME: "docker" }),
    ).rejects.toThrow(/EVELAND_SCHEDULER_RUNTIME_SECRET/);
  });

  test("rejects a short scheduler secret before a production docker worker starts", async () => {
    await expect(
      assertWorkerPreflight({
        NODE_ENV: "production",
        EVELAND_RUNTIME: "docker",
        EVELAND_SCHEDULER_RUNTIME_SECRET: "too-short",
        EVELAND_SCHEDULER_DISPATCH_SECRET: "scheduler-dispatch-secret-at-least-32-bytes",
        EVELAND_SCHEDULER_REDEEM_URL: "http://127.0.0.1:4000/internal/scheduler/dispatch",
      }),
    ).rejects.toThrow(/EVELAND_SCHEDULER_RUNTIME_SECRET.*at least 32 bytes/);
  });

  test("runs the full preflight when NODE_ENV=production resolves the systemd default, even with EVELAND_RUNTIME unset", async () => {
    // The gate must follow the RESOLVED runtime, not the raw env var: a
    // production host relying on the systemd default gets the same safety net
    // as one that sets EVELAND_RUNTIME=systemd explicitly.
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      EVELAND_DATA_DIR: "/var/lib/eveland",
      ...productionSchedulerEnv,
    };
    const deps = makePassingDeps(env);
    await expect(assertWorkerPreflight(env, deps)).resolves.toBeUndefined();
    expect(deps.getuid).toHaveBeenCalled();
    expect(deps.commandExists).toHaveBeenCalled();
    expect(deps.userExists).toHaveBeenCalled();
    expect(deps.canTraverseAs).toHaveBeenCalledWith("eveland-app", "/var/lib/eveland");
    expect(deps.backendDistDir).toHaveBeenCalled();
  });

  test("collects issues on the NODE_ENV=production default path, not just the explicit-systemd one", async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      EVELAND_DATA_DIR: "/var/lib/eveland",
      ...productionSchedulerEnv,
    };
    const deps = makePassingDeps(env);
    deps.platform = "darwin";
    await expect(assertWorkerPreflight(env, deps)).rejects.toThrow(
      /^systemd runtime preflight failed:/,
    );
  });

  test("uses Docker-only preflight when NODE_ENV=production but EVELAND_RUNTIME=docker is explicit", async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      EVELAND_RUNTIME: "docker",
      EVELAND_SCHEDULER_RUNTIME_SECRET: "scheduler-runtime-secret-at-least-32-bytes",
      EVELAND_SCHEDULER_DISPATCH_SECRET: "scheduler-dispatch-secret-at-least-32-bytes",
      EVELAND_SCHEDULER_REDEEM_URL: "http://127.0.0.1:4000/internal/scheduler/dispatch",
    };
    const deps = makePassingDeps(env);
    await expect(assertWorkerPreflight(env, deps)).resolves.toBeUndefined();
    expect(deps.probeDockerNetworkPool).toHaveBeenCalledOnce();
    expect(deps.getuid).not.toHaveBeenCalled();
    expect(deps.commandExists).not.toHaveBeenCalled();
    expect(deps.backendDistDir).not.toHaveBeenCalled();
  });

  test("resolves when every check passes", async () => {
    const deps = makePassingDeps();
    await expect(assertWorkerPreflight(deps.env, deps)).resolves.toBeUndefined();
  });

  test("throws one Error naming every failing check, prefixed consistently", async () => {
    const deps = makePassingDeps();
    deps.platform = "darwin";
    deps.getuid = vi.fn(() => 1000);

    await expect(assertWorkerPreflight(deps.env, deps)).rejects.toThrow(
      /^systemd runtime preflight failed:/,
    );
    try {
      await assertWorkerPreflight(deps.env, deps);
      throw new Error("expected assertWorkerPreflight to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("- ");
      expect(message).toMatch(/linux/i);
      expect(message).toMatch(/uid/i);
    }
  });
});

describe("collectSystemdPreflightIssues", () => {
  test("returns no issues when every check passes", async () => {
    expect(await collectSystemdPreflightIssues(makePassingDeps())).toEqual([]);
  });

  test("flags a non-linux platform", async () => {
    const deps = makePassingDeps();
    deps.platform = "darwin";
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => /linux/i.test(issue) && /darwin/.test(issue))).toBe(true);
  });

  test("flags a missing systemd install", async () => {
    const deps = makePassingDeps();
    deps.pathExists = vi.fn(async (p: string) => p !== "/run/systemd/system");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("/run/systemd/system"))).toBe(true);
  });

  test("flags a non-root uid", async () => {
    const deps = makePassingDeps();
    deps.getuid = vi.fn(() => 1000);
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => /root/i.test(issue) && issue.includes("1000"))).toBe(true);
  });

  test("flags an unset EVELAND_DATA_DIR", async () => {
    const deps = makePassingDeps({ EVELAND_RUNTIME: "systemd" });
    const issues = await collectSystemdPreflightIssues(deps);
    expect(
      issues.some(
        (issue) =>
          issue.includes("EVELAND_DATA_DIR") &&
          /not set/i.test(issue) &&
          issue.includes("/var/lib/eveland"),
      ),
    ).toBe(true);
  });

  test("flags a relative EVELAND_DATA_DIR, and skips check 9 entirely rather than mkdir-ing it relative to cwd", async () => {
    const deps = makePassingDeps({
      EVELAND_RUNTIME: "systemd",
      EVELAND_DATA_DIR: "relative-data-dir",
    });
    const issues = await collectSystemdPreflightIssues(deps);
    expect(
      issues.some((issue) => issue.includes("relative-data-dir") && /absolute/i.test(issue)),
    ).toBe(true);
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.canTraverseAs).not.toHaveBeenCalled();
  });

  test("flags each missing required binary by name", async () => {
    const deps = makePassingDeps();
    deps.commandExists = vi.fn(
      async (name: string) => name !== "systemd-run" && name !== "node" && name !== "git",
    );
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("systemd-run"))).toBe(true);
    expect(issues.some((issue) => issue.includes("node"))).toBe(true);
    expect(issues.some((issue) => issue.includes("git"))).toBe(true);
    expect(issues.some((issue) => issue.includes("systemctl"))).toBe(false);
  });

  test("reports every missing platform-owned sandbox command in one preflight run", async () => {
    const deps = makePassingDeps();
    const missing = new Set<string>(SANDBOX_TOOLCHAIN_COMMANDS);
    deps.commandExists = vi.fn(async (name: string) => !missing.has(name));

    const issues = await collectSystemdPreflightIssues(deps);

    for (const command of SANDBOX_TOOLCHAIN_COMMANDS) {
      expect(
        issues.some((issue) => issue.includes(`"${command}"`)),
        command,
      ).toBe(true);
    }
  });

  test("requires git unconditionally -- the worker shells out to git clone for source imports", async () => {
    const deps = makePassingDeps();
    deps.commandExists = vi.fn(async (name: string) => name !== "git");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes('"git"'))).toBe(true);
  });

  test("requires docker to validate and reload the managed OpenTelemetry Collector", async () => {
    const deps = makePassingDeps();
    deps.commandExists = vi.fn(async (name: string) => name !== "docker");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes('"docker"'))).toBe(true);
  });

  test("requires bwrap by default", async () => {
    const deps = makePassingDeps();
    deps.commandExists = vi.fn(async (name: string) => name !== "bwrap");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("bwrap"))).toBe(true);
  });

  test("does not require bwrap when EVELAND_BUILD_SANDBOX=none", async () => {
    const deps = makePassingDeps({
      EVELAND_RUNTIME: "systemd",
      EVELAND_DATA_DIR: "/var/lib/eveland",
      EVELAND_BUILD_SANDBOX: "none",
    });
    const commandExists = vi.fn(async (name: string) => name !== "bwrap");
    deps.commandExists = commandExists;
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("bwrap"))).toBe(false);
    expect(commandExists).not.toHaveBeenCalledWith("bwrap");
  });

  test("requires runuser unconditionally -- the build itself now runs under it, not just the traversal probe", async () => {
    const deps = makePassingDeps();
    deps.commandExists = vi.fn(async (name: string) => name !== "runuser");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("runuser"))).toBe(true);
  });

  test("still requires runuser when EVELAND_BUILD_SANDBOX=none, unlike bwrap", async () => {
    const deps = makePassingDeps({
      EVELAND_RUNTIME: "systemd",
      EVELAND_DATA_DIR: "/var/lib/eveland",
      EVELAND_BUILD_SANDBOX: "none",
    });
    deps.commandExists = vi.fn(async (name: string) => name !== "runuser");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("runuser"))).toBe(true);
  });

  test("flags a missing app user, defaulting the name to eveland-app", async () => {
    const deps = makePassingDeps();
    deps.userExists = vi.fn(async () => false);
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("eveland-app"))).toBe(true);
  });

  test("flags a missing app user using EVELAND_APP_USER when set", async () => {
    const deps = makePassingDeps({
      EVELAND_RUNTIME: "systemd",
      EVELAND_DATA_DIR: "/var/lib/eveland",
      EVELAND_APP_USER: "custom-app",
    });
    deps.userExists = vi.fn(async () => false);
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("custom-app"))).toBe(true);
  });

  test("requires a same-named access group for dynamic Deployment users", async () => {
    const deps = makePassingDeps({
      EVELAND_RUNTIME: "systemd",
      EVELAND_DATA_DIR: "/var/lib/eveland",
      EVELAND_APP_USER: "custom-app",
    });
    deps.groupExists = vi.fn(async () => false);

    const issues = await collectSystemdPreflightIssues(deps);

    expect(
      issues.some(
        (issue) => issue.includes('Access group "custom-app"') && issue.includes("--user-group"),
      ),
    ).toBe(true);
  });

  test("flags a missing build user, defaulting the name to eveland-build, and names EVELAND_BUILD_USER plus the useradd fix", async () => {
    const deps = makePassingDeps();
    deps.userExists = vi.fn(async (name: string) => name !== "eveland-build");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(
      issues.some(
        (issue) =>
          issue.includes("eveland-build") &&
          issue.includes("EVELAND_BUILD_USER") &&
          issue.includes("useradd"),
      ),
    ).toBe(true);
  });

  test("flags a missing build user using EVELAND_BUILD_USER when set", async () => {
    const deps = makePassingDeps({
      EVELAND_RUNTIME: "systemd",
      EVELAND_DATA_DIR: "/var/lib/eveland",
      EVELAND_BUILD_USER: "custom-build",
    });
    deps.userExists = vi.fn(async (name: string) => name !== "custom-build");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("custom-build"))).toBe(true);
  });

  test("flags both the app user and the build user missing independently, one issue each", async () => {
    const deps = makePassingDeps();
    deps.userExists = vi.fn(async () => false);
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.filter((issue) => issue.includes("eveland-app"))).toHaveLength(1);
    expect(issues.filter((issue) => issue.includes("eveland-build"))).toHaveLength(1);
  });

  test("flags a missing /workspace directory", async () => {
    const deps = makePassingDeps();
    deps.pathExists = vi.fn(async (p: string) => p !== "/workspace");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("/workspace"))).toBe(true);
  });

  test("flags /workspace existing but not being a directory", async () => {
    const deps = makePassingDeps();
    deps.isDirectory = vi.fn(async (p: string) => p !== "/workspace");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("/workspace"))).toBe(true);
  });

  test("converts a backendDistDir() throw into an issue, keeping its message", async () => {
    const deps = makePassingDeps();
    deps.backendDistDir = vi.fn(() => {
      throw new Error("@evelandhq/sandbox-bwrap is not resolvable. Run `pnpm install`.");
    });
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("sandbox-bwrap is not resolvable"))).toBe(true);
  });

  test("flags the app user being unable to traverse the data dir", async () => {
    const deps = makePassingDeps();
    deps.canTraverseAs = vi.fn(async () => false);
    const issues = await collectSystemdPreflightIssues(deps);
    expect(
      issues.some((issue) => /traverse/i.test(issue) && issue.includes("/var/lib/eveland")),
    ).toBe(true);
  });

  test("flags the build user being unable to traverse the data dir, independent of the app-user probe passing", async () => {
    const deps = makePassingDeps();
    deps.canTraverseAs = vi.fn(async (user: string) => user !== "eveland-build");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(
      issues.some(
        (issue) =>
          /traverse/i.test(issue) &&
          issue.includes("eveland-build") &&
          issue.includes("/var/lib/eveland"),
      ),
    ).toBe(true);
    expect(issues.some((issue) => /traverse/i.test(issue) && issue.includes("eveland-app"))).toBe(
      false,
    );
  });

  test("mkdirs the data dir and probes both app-user and build-user traversal on it", async () => {
    const deps = makePassingDeps();
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues).toEqual([]);
    expect(deps.mkdir).toHaveBeenCalledWith("/var/lib/eveland");
    expect(deps.canTraverseAs).toHaveBeenCalledWith("eveland-app", "/var/lib/eveland");
    expect(deps.canTraverseAs).toHaveBeenCalledWith("eveland-build", "/var/lib/eveland");
  });

  test("skips the traversal probe when the app user does not exist, without a duplicate issue", async () => {
    const deps = makePassingDeps();
    deps.userExists = vi.fn(async () => false);
    const canTraverseAs = vi.fn(async () => true);
    deps.canTraverseAs = canTraverseAs;
    const issues = await collectSystemdPreflightIssues(deps);
    expect(canTraverseAs).not.toHaveBeenCalled();
    expect(issues.filter((issue) => /eveland-app/.test(issue))).toHaveLength(1);
  });

  test("skips the build-user traversal probe when the build user does not exist, without a duplicate issue (app user still probed)", async () => {
    const deps = makePassingDeps();
    deps.userExists = vi.fn(async (name: string) => name !== "eveland-build");
    const canTraverseAs = vi.fn(async () => true);
    deps.canTraverseAs = canTraverseAs;
    const issues = await collectSystemdPreflightIssues(deps);
    expect(canTraverseAs).toHaveBeenCalledWith("eveland-app", "/var/lib/eveland");
    expect(canTraverseAs).not.toHaveBeenCalledWith("eveland-build", "/var/lib/eveland");
    expect(issues.filter((issue) => /eveland-build/.test(issue))).toHaveLength(1);
  });

  test("skips the data-dir-usable check entirely when EVELAND_DATA_DIR is unset, reporting only issue 4", async () => {
    const deps = makePassingDeps({ EVELAND_RUNTIME: "systemd" });
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("EVELAND_DATA_DIR");
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.canTraverseAs).not.toHaveBeenCalled();
  });

  test("converts a throwing mkdir into an issue, keeps earlier issues, and skips the traversal probe", async () => {
    const deps = makePassingDeps();
    deps.getuid = vi.fn(() => 1000);
    deps.mkdir = vi.fn(async () => {
      throw new Error("EACCES: permission denied, mkdir '/var/lib/eveland'");
    });
    const canTraverseAs = vi.fn(async () => true);
    deps.canTraverseAs = canTraverseAs;

    const issues = await collectSystemdPreflightIssues(deps);

    expect(
      issues.some((issue) => issue.includes("/var/lib/eveland") && issue.includes("EACCES")),
    ).toBe(true);
    expect(issues.some((issue) => /root/i.test(issue) && issue.includes("1000"))).toBe(true);
    expect(canTraverseAs).not.toHaveBeenCalled();
  });

  test("reports every failure together, not just the first", async () => {
    const deps = makePassingDeps();
    deps.platform = "darwin";
    deps.getuid = vi.fn(() => 1000);
    deps.userExists = vi.fn(async () => false);
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => /linux/i.test(issue))).toBe(true);
    expect(issues.some((issue) => /root/i.test(issue))).toBe(true);
    expect(issues.some((issue) => issue.includes("eveland-app"))).toBe(true);
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  test("still runs checks 4-9 even when earlier checks (1-3) failed", async () => {
    const deps = makePassingDeps();
    deps.platform = "darwin";
    deps.getuid = vi.fn(() => 1000);
    deps.pathExists = vi.fn(async (p: string) => p !== "/run/systemd/system");
    await collectSystemdPreflightIssues(deps);
    // mkdir/canTraverseAs (check 9) still ran despite checks 1-3 failing.
    expect(deps.mkdir).toHaveBeenCalledWith("/var/lib/eveland");
    expect(deps.canTraverseAs).toHaveBeenCalled();
  });
});
