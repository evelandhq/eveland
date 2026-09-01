import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  BWRAP_APPARMOR_PROFILE,
  HOST_APT_PACKAGES,
  provisionLinuxHost,
  type LinuxHostDeps,
} from "./linux-host.ts";

type HarnessOptions = {
  uid?: number;
  hasApt?: boolean;
  existingCommands?: string[];
  existingUsers?: string[];
  existingPaths?: string[];
};

async function makeDeps(options: HarnessOptions = {}) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-linuxhost-"));
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.7.0" }),
    "utf8",
  );
  const out: string[] = [];
  const err: string[] = [];
  const execCalls: string[][] = [];
  const streamCalls: string[][] = [];
  const written: Record<string, string> = {};
  const commands = new Set(options.existingCommands ?? []);
  if (options.hasApt !== false) commands.add("apt-get");
  const users = new Set(options.existingUsers ?? []);
  const paths = new Set(
    options.existingPaths ?? [
      "/etc/apparmor.d",
      "/node-bin/node",
      "/node-bin/npm",
      "/node-bin/npx",
    ],
  );

  const deps: LinuxHostDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    execCommand: async (argv) => {
      execCalls.push(argv);
      if (argv[0] === "sh" && argv[1] === "-c") {
        const probed = argv[2]!.replace("command -v ", "");
        return { code: commands.has(probed) ? 0 : 1, output: "" };
      }
      if (argv[0] === "id") return { code: users.has(argv[2]!) ? 0 : 1, output: "" };
      return { code: 0, output: "" };
    },
    streamCommand: async (argv) => {
      streamCalls.push(argv);
      return 0;
    },
    fileExists: async (filePath) => paths.has(filePath) || filePath in written,
    writeTextFile: async (filePath, content) => {
      written[filePath] = content;
    },
    env: {},
    repoRootDir: repo,
    nodeBinDir: "/node-bin",
    getuid: () => options.uid ?? 0,
  };
  return { deps, out, err, execCalls, streamCalls, written };
}

describe("provisionLinuxHost", () => {
  test("as root on an apt host: toolchain, AppArmor profile, /workspace, users, system PATH", async () => {
    const harness = await makeDeps({});
    await provisionLinuxHost(harness.deps);

    expect(harness.streamCalls[0]).toEqual(["apt-get", "update"]);
    expect(harness.streamCalls[1]).toEqual(["apt-get", "install", "-y", ...HOST_APT_PACKAGES]);

    expect(harness.written["/etc/apparmor.d/bwrap"]).toBe(BWRAP_APPARMOR_PROFILE);
    expect(harness.execCalls).toContainEqual([
      "apparmor_parser",
      "-r",
      "-W",
      "/etc/apparmor.d/bwrap",
    ]);
    expect(harness.execCalls).toContainEqual(["install", "-d", "-m", "0755", "/workspace"]);
    expect(
      harness.execCalls.some((argv) => argv[0] === "useradd" && argv.includes("eveland-app")),
    ).toBe(true);
    expect(
      harness.execCalls.some((argv) => argv[0] === "useradd" && argv.includes("eveland-build")),
    ).toBe(true);
    // The pinned node lands on the system PATH for units and sandboxes.
    expect(harness.execCalls).toContainEqual([
      "ln",
      "-sf",
      "/node-bin/node",
      "/usr/local/bin/node",
    ]);
    // pnpm was absent, so corepack installs the pinned version system-wide.
    expect(harness.execCalls).toContainEqual([
      "/node-bin/corepack",
      "enable",
      "--install-directory",
      "/usr/local/bin",
    ]);
    expect(harness.execCalls).toContainEqual([
      "/node-bin/corepack",
      "install",
      "--global",
      "pnpm@11.7.0",
    ]);
  });

  test("docker.io installs only when no docker exists — a Docker CE host must not get the conflicting package", async () => {
    const withDocker = await makeDeps({ existingCommands: ["docker", "pnpm"] });
    await provisionLinuxHost(withDocker.deps);
    expect(withDocker.streamCalls.some((argv) => argv.includes("docker.io"))).toBe(false);
    expect(
      withDocker.streamCalls.find((argv) => argv[1] === "install")!.includes("docker.io"),
    ).toBe(false);

    const withoutDocker = await makeDeps({ existingCommands: ["pnpm"] });
    await provisionLinuxHost(withoutDocker.deps);
    expect(withoutDocker.streamCalls).toContainEqual(["apt-get", "install", "-y", "docker.io"]);
  });

  test("existing users and an existing profile are left alone", async () => {
    const harness = await makeDeps({
      existingUsers: ["eveland-app", "eveland-build"],
      existingPaths: ["/etc/apparmor.d", "/etc/apparmor.d/bwrap", "/node-bin/node"],
      existingCommands: ["pnpm"],
    });
    await provisionLinuxHost(harness.deps);
    expect(harness.execCalls.some((argv) => argv[0] === "useradd")).toBe(false);
    expect(Object.keys(harness.written)).toEqual([]);
    expect(harness.execCalls.some((argv) => argv[0]?.endsWith("corepack"))).toBe(false);
  });

  test("without root it warns and changes nothing", async () => {
    const harness = await makeDeps({ uid: 1000 });
    await provisionLinuxHost(harness.deps);
    expect(harness.err.join("\n")).toContain("skipping Linux host provisioning");
    expect(harness.execCalls).toEqual([]);
    expect(harness.streamCalls).toEqual([]);
  });

  test("a non-apt host with the full toolchain present passes verification", async () => {
    const harness = await makeDeps({
      hasApt: false,
      existingCommands: [
        "systemd-run",
        "systemctl",
        "runuser",
        "docker",
        "ss",
        "ps",
        "bash",
        "rg",
        "grep",
        "find",
        "git",
        "curl",
        "jq",
        "python3",
        "pip3",
        "unzip",
        "zstd",
        "bwrap",
        "pnpm",
      ],
      existingUsers: ["eveland-app", "eveland-build"],
    });
    await expect(provisionLinuxHost(harness.deps)).resolves.toBeUndefined();
  });

  test("a non-apt host missing commands fails with the complete list", async () => {
    const harness = await makeDeps({ hasApt: false, existingCommands: ["bash", "git"] });
    await expect(provisionLinuxHost(harness.deps)).rejects.toThrow(/bwrap/);
  });
});
