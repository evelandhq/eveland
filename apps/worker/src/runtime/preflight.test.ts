import { describe, expect, test, vi } from "vitest";
import { assertWorkerPreflight, collectSystemdPreflightIssues, type PreflightDeps } from "./preflight.js";

/**
 * Every dep passing by default so each test only needs to override the one
 * thing it's exercising. `canTraverseAs`/`userExists` etc. are `vi.fn()` so
 * tests can also assert a dep was (or wasn't) invoked at all.
 */
function makePassingDeps(env: NodeJS.ProcessEnv = { EVELAND_RUNTIME: "systemd", EVELAND_DATA_DIR: "/var/lib/eveland" }): PreflightDeps {
  return {
    env,
    platform: "linux",
    getuid: vi.fn(() => 0),
    pathExists: vi.fn(async () => true),
    isDirectory: vi.fn(async () => true),
    mkdir: vi.fn(async () => {}),
    commandExists: vi.fn(async () => true),
    userExists: vi.fn(async () => true),
    canTraverseAs: vi.fn(async () => true),
    backendDistDir: vi.fn(() => "/opt/eveland/dist"),
  };
}

describe("assertWorkerPreflight", () => {
  test("is a no-op when EVELAND_RUNTIME is not systemd, invoking no dep", async () => {
    const deps = makePassingDeps({});
    await assertWorkerPreflight({}, deps);
    expect(deps.getuid).not.toHaveBeenCalled();
    expect(deps.pathExists).not.toHaveBeenCalled();
    expect(deps.commandExists).not.toHaveBeenCalled();
    expect(deps.userExists).not.toHaveBeenCalled();
    expect(deps.canTraverseAs).not.toHaveBeenCalled();
    expect(deps.backendDistDir).not.toHaveBeenCalled();
  });

  test("is a no-op for the docker runtime specifically", async () => {
    const deps = makePassingDeps({ EVELAND_RUNTIME: "docker" });
    await expect(assertWorkerPreflight({ EVELAND_RUNTIME: "docker" }, deps)).resolves.toBeUndefined();
    expect(deps.commandExists).not.toHaveBeenCalled();
  });

  test("resolves when every check passes", async () => {
    const deps = makePassingDeps();
    await expect(assertWorkerPreflight(deps.env, deps)).resolves.toBeUndefined();
  });

  test("throws one Error naming every failing check, prefixed consistently", async () => {
    const deps = makePassingDeps();
    deps.platform = "darwin";
    deps.getuid = vi.fn(() => 1000);

    await expect(assertWorkerPreflight(deps.env, deps)).rejects.toThrow(/^systemd runtime preflight failed:/);
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
    expect(issues.some((issue) => issue.includes("EVELAND_DATA_DIR") && /not set/i.test(issue) && issue.includes("/var/lib/eveland"))).toBe(true);
  });

  test("flags a relative EVELAND_DATA_DIR, and skips check 9 entirely rather than mkdir-ing it relative to cwd", async () => {
    const deps = makePassingDeps({ EVELAND_RUNTIME: "systemd", EVELAND_DATA_DIR: "relative-data-dir" });
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("relative-data-dir") && /absolute/i.test(issue))).toBe(true);
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.canTraverseAs).not.toHaveBeenCalled();
  });

  test("flags each missing required binary by name", async () => {
    const deps = makePassingDeps();
    deps.commandExists = vi.fn(async (name: string) => name !== "systemd-run" && name !== "node" && name !== "git");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("systemd-run"))).toBe(true);
    expect(issues.some((issue) => issue.includes("node"))).toBe(true);
    expect(issues.some((issue) => issue.includes("git"))).toBe(true);
    expect(issues.some((issue) => issue.includes("systemctl"))).toBe(false);
  });

  test("requires git unconditionally -- the worker shells out to git clone for source imports", async () => {
    const deps = makePassingDeps();
    deps.commandExists = vi.fn(async (name: string) => name !== "git");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes('"git"'))).toBe(true);
  });

  test("requires bwrap by default", async () => {
    const deps = makePassingDeps();
    deps.commandExists = vi.fn(async (name: string) => name !== "bwrap");
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("bwrap"))).toBe(true);
  });

  test("does not require bwrap when EVELAND_BUILD_SANDBOX=none", async () => {
    const deps = makePassingDeps({ EVELAND_RUNTIME: "systemd", EVELAND_DATA_DIR: "/var/lib/eveland", EVELAND_BUILD_SANDBOX: "none" });
    const commandExists = vi.fn(async (name: string) => name !== "bwrap");
    deps.commandExists = commandExists;
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("bwrap"))).toBe(false);
    expect(commandExists).not.toHaveBeenCalledWith("bwrap");
  });

  test("flags a missing app user, defaulting the name to eveland-app", async () => {
    const deps = makePassingDeps();
    deps.userExists = vi.fn(async () => false);
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("eveland-app"))).toBe(true);
  });

  test("flags a missing app user using EVELAND_APP_USER when set", async () => {
    const deps = makePassingDeps({ EVELAND_RUNTIME: "systemd", EVELAND_DATA_DIR: "/var/lib/eveland", EVELAND_APP_USER: "custom-app" });
    deps.userExists = vi.fn(async () => false);
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("custom-app"))).toBe(true);
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
      throw new Error("@eveland/sandbox-bwrap is not resolvable. Run `pnpm --filter @eveland/sandbox-bwrap build`.");
    });
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => issue.includes("sandbox-bwrap build"))).toBe(true);
  });

  test("flags the app user being unable to traverse the data dir", async () => {
    const deps = makePassingDeps();
    deps.canTraverseAs = vi.fn(async () => false);
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues.some((issue) => /traverse/i.test(issue) && issue.includes("/var/lib/eveland"))).toBe(true);
  });

  test("mkdirs the data dir and probes app-user traversal on it", async () => {
    const deps = makePassingDeps();
    const issues = await collectSystemdPreflightIssues(deps);
    expect(issues).toEqual([]);
    expect(deps.mkdir).toHaveBeenCalledWith("/var/lib/eveland");
    expect(deps.canTraverseAs).toHaveBeenCalledWith("eveland-app", "/var/lib/eveland");
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

    expect(issues.some((issue) => issue.includes("/var/lib/eveland") && issue.includes("EACCES"))).toBe(true);
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
    const issues = await collectSystemdPreflightIssues(deps);
    // mkdir/canTraverseAs (check 9) still ran despite checks 1-3 failing.
    expect(deps.mkdir).toHaveBeenCalledWith("/var/lib/eveland");
    expect(deps.canTraverseAs).toHaveBeenCalled();
  });
});
