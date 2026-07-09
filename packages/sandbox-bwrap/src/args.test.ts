import { describe, expect, test } from "vitest";
import { buildBwrapExecArgs, DEFAULT_SANDBOX_PATH } from "./args.js";

describe("buildBwrapExecArgs", () => {
  test("pins the exact sandbox argv (order is load-bearing)", () => {
    const args = buildBwrapExecArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/app/.eve/sandbox-cache/bwrap/sessions/abc",
      hidePaths: ["/app/.eve/sandbox-cache/bwrap"],
      shareNetwork: true,
      env: { PATH: DEFAULT_SANDBOX_PATH, HOME: "/workspace" },
      chdir: "/workspace",
      command: "echo hi",
    });

    expect(args).toEqual([
      "bwrap",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--tmpfs", "/app/.eve/sandbox-cache/bwrap",
      "--bind", "/app/.eve/sandbox-cache/bwrap/sessions/abc", "/workspace",
      "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent",
      "--clearenv",
      "--setenv", "PATH", DEFAULT_SANDBOX_PATH,
      "--setenv", "HOME", "/workspace",
      "--chdir", "/workspace",
      "bash", "-lc", "echo hi",
    ]);
  });

  test("deny-all adds --unshare-net after the workspace bind", () => {
    const args = buildBwrapExecArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/w",
      hidePaths: [],
      shareNetwork: false,
      env: {},
      chdir: "/workspace",
      command: "true",
    });
    const bindIndex = args.indexOf("--bind");
    const unshareNetIndex = args.indexOf("--unshare-net");
    expect(unshareNetIndex).toBeGreaterThan(bindIndex);
    expect(args).toContain("--clearenv");
  });

  test("tmpfs hides come before the workspace bind so the bind punches through", () => {
    const args = buildBwrapExecArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/data/cache/sessions/s1",
      hidePaths: ["/data/cache", "/srv/private"],
      shareNetwork: true,
      env: {},
      chdir: "/workspace",
      command: "true",
    });
    const lastTmpfs = args.lastIndexOf("--tmpfs");
    expect(lastTmpfs).toBeLessThan(args.indexOf("--bind"));
    expect(args.slice(lastTmpfs, lastTmpfs + 2)).toEqual(["--tmpfs", "/srv/private"]);
  });
});
