import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  BWRAP_APPARMOR_PROFILE,
  HOST_APT_PACKAGES,
  HOST_SERVICE_ACCOUNTS,
  provisionLinuxHost,
  type LinuxHostDeps,
  HOST_REQUIRED_COMMANDS,
} from "./linux-host.ts";

type HarnessOptions = {
  uid?: number;
  hasApt?: boolean;
  existingCommands?: string[];
  existingUsers?: string[];
  existingPaths?: string[];
  /** dpkg-installed packages (Docker family detection). */
  debPackages?: string[];
  /** Whether `docker compose version` succeeds. */
  composeWorks?: boolean;
  /** Commands that exist on PATH but fail `--version` (a dangling corepack shim). */
  brokenCommands?: string[];
  /** What a working system pnpm reports (the repo pins 11.7.0). */
  pnpmVersion?: string;
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
  const broken = new Set(options.brokenCommands ?? []);
  let pnpmVersion = options.pnpmVersion ?? "11.7.0";
  if (options.hasApt !== false) commands.add("apt-get");
  const users = new Set(options.existingUsers ?? []);
  const paths = new Set(
    options.existingPaths ?? [
      "/etc/apparmor.d",
      "/node-bin/node",
      "/node-bin/npm",
      "/node-bin/npx",
      "/node-bin/corepack",
    ],
  );

  const deps: LinuxHostDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    execCommand: async (argv) => {
      execCalls.push(argv);
      if (argv[0] === "docker" && argv[1] === "compose") {
        return { code: (options.composeWorks ?? true) ? 0 : 1, output: "" };
      }
      if (argv[0] === "dpkg" && argv[1] === "-s") {
        return { code: (options.debPackages ?? []).includes(argv[2]!) ? 0 : 1, output: "" };
      }
      // Plain probes and fixed-system-PATH probes both resolve against the
      // same fake command set.
      const shIndex = argv.indexOf("sh");
      if (shIndex >= 0 && argv[shIndex + 1] === "-c") {
        const probed = argv[shIndex + 2]!.replace("command -v ", "");
        return { code: commands.has(probed) ? 0 : 1, output: "" };
      }
      if (argv[0] === "id") return { code: users.has(argv[2]!) ? 0 : 1, output: "" };
      // Functional probes: `<command> --version` on a fixed system PATH.
      const versionIndex = argv.indexOf("--version");
      if (versionIndex > 0) {
        const probed = argv[versionIndex - 1]!;
        const works = commands.has(probed) && !broken.has(probed);
        return { code: works ? 0 : 1, output: works ? `${pnpmVersion}\n` : "" };
      }
      // corepack's global install makes the PINNED pnpm work again.
      if (argv[0]?.endsWith("corepack") && argv[1] === "install") {
        commands.add("pnpm");
        broken.delete("pnpm");
        pnpmVersion = argv[3]!.replace(/^pnpm@/, "");
      }
      // Linking a pnpm from the interpreter's bin dir makes it work too.
      if (argv[0] === "ln" && argv[3] === "/usr/local/bin/pnpm") {
        commands.add("pnpm");
        broken.delete("pnpm");
      }
      // `npm install -g pnpm@…` lands pnpm in the interpreter's bin dir.
      if (argv[0]?.endsWith("/npm") && argv[1] === "install" && argv[2] === "-g") {
        paths.add("/node-bin/pnpm");
      }
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
    // Every account the table declares, and each with its own home. The
    // Dashboard's and the API's are separate on purpose: one uid per trust
    // level is what keeps a service's env allowlist from being decorative.
    for (const account of HOST_SERVICE_ACCOUNTS) {
      expect(harness.execCalls).toContainEqual([
        "useradd",
        "--system",
        ...(account.ownGroup ? ["--user-group"] : []),
        "--home-dir",
        account.home,
        "--create-home",
        account.user,
      ]);
    }
    expect(new Set(HOST_SERVICE_ACCOUNTS.map((account) => account.home)).size).toBe(
      HOST_SERVICE_ACCOUNTS.length,
    );
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

  test("Docker + Compose come from ONE package family; a Docker CE host never gets Ubuntu's docker.io pair", async () => {
    // Docker CE with Compose already working: nothing to install.
    const ceWithCompose = await makeDeps({
      existingCommands: ["docker", "pnpm"],
      debPackages: ["docker-ce"],
      composeWorks: true,
    });
    await provisionLinuxHost(ceWithCompose.deps);
    expect(ceWithCompose.streamCalls.some((argv) => argv.join(" ").includes("docker"))).toBe(false);

    // Docker CE without Compose: the plugin from Docker's own family.
    const ceNoCompose = await makeDeps({
      existingCommands: ["docker", "pnpm"],
      debPackages: ["docker-ce"],
      composeWorks: false,
    });
    await provisionLinuxHost(ceNoCompose.deps);
    expect(ceNoCompose.streamCalls).toContainEqual([
      "apt-get",
      "install",
      "-y",
      "docker-compose-plugin",
    ]);
    expect(ceNoCompose.streamCalls.some((argv) => argv.includes("docker.io"))).toBe(false);

    // Ubuntu's docker.io without Compose: docker-compose-v2.
    const ioNoCompose = await makeDeps({
      existingCommands: ["docker", "pnpm"],
      debPackages: ["docker.io"],
      composeWorks: false,
    });
    await provisionLinuxHost(ioNoCompose.deps);
    expect(ioNoCompose.streamCalls).toContainEqual([
      "apt-get",
      "install",
      "-y",
      "docker-compose-v2",
    ]);

    // No Docker at all: Ubuntu's pair, in one apt call.
    const withoutDocker = await makeDeps({ existingCommands: ["pnpm"] });
    await provisionLinuxHost(withoutDocker.deps);
    expect(withoutDocker.streamCalls).toContainEqual([
      "apt-get",
      "install",
      "-y",
      "docker.io",
      "docker-compose-v2",
    ]);

    // Docker of unknown provenance without Compose: told, not guessed at.
    const unknown = await makeDeps({ existingCommands: ["docker", "pnpm"], composeWorks: false });
    await expect(provisionLinuxHost(unknown.deps)).rejects.toThrow(/package family is unknown/);
  });

  test("a dangling system pnpm (shim into a removed interpreter) is refreshed through corepack", async () => {
    // `command -v pnpm` would pass (the symlink exists); `pnpm --version` fails.
    const harness = await makeDeps({
      existingCommands: ["docker", "pnpm"],
      brokenCommands: ["pnpm"],
    });
    await provisionLinuxHost(harness.deps);
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
    // corepack itself is linked too, so the shims resolve after a pin move.
    expect(harness.execCalls).toContainEqual([
      "ln",
      "-sf",
      "/node-bin/corepack",
      "/usr/local/bin/corepack",
    ]);
  });

  test("a runnable pnpm of the WRONG version does not satisfy the pin: the pinned one is installed", async () => {
    const harness = await makeDeps({ existingCommands: ["docker", "pnpm"], pnpmVersion: "9.0.0" });
    await provisionLinuxHost(harness.deps);
    expect(harness.execCalls).toContainEqual([
      "/node-bin/corepack",
      "install",
      "--global",
      "pnpm@11.7.0",
    ]);
  });

  test("a Node without corepack: a pnpm in its own bin dir is linked; otherwise npm installs it there", async () => {
    // Corepack absent, pnpm already in the interpreter's bin dir (the
    // installer's `npm i -g pnpm` fallback): linked like the rest, no corepack.
    const withPnpm = await makeDeps({
      existingCommands: ["docker"],
      existingPaths: ["/etc/apparmor.d", "/node-bin/node", "/node-bin/npm", "/node-bin/pnpm"],
    });
    await provisionLinuxHost(withPnpm.deps);
    expect(withPnpm.execCalls).toContainEqual([
      "ln",
      "-sf",
      "/node-bin/pnpm",
      "/usr/local/bin/pnpm",
    ]);
    expect(withPnpm.execCalls.some((argv) => argv[0]?.endsWith("corepack"))).toBe(false);
    expect(
      withPnpm.execCalls.some((argv) => argv[0]?.endsWith("/npm") && argv[1] === "install"),
    ).toBe(false);

    // Corepack absent and no pnpm anywhere: the interpreter's npm installs
    // the pinned pnpm into its prefix, which is then linked.
    const bare = await makeDeps({
      existingCommands: ["docker"],
      existingPaths: ["/etc/apparmor.d", "/node-bin/node", "/node-bin/npm"],
    });
    await provisionLinuxHost(bare.deps);
    expect(bare.execCalls).toContainEqual(["/node-bin/npm", "install", "-g", "pnpm@11.7.0"]);
    expect(bare.execCalls).toContainEqual(["ln", "-sf", "/node-bin/pnpm", "/usr/local/bin/pnpm"]);
    expect(bare.execCalls.some((argv) => argv[0]?.endsWith("corepack"))).toBe(false);
  });

  test("an interpreter that already lives in /usr/local/bin is never symlinked to itself", async () => {
    const harness = await makeDeps({
      existingCommands: ["docker", "pnpm"],
      existingPaths: ["/etc/apparmor.d", "/usr/local/bin/node", "/usr/local/bin/npm"],
    });
    harness.deps.nodeBinDir = "/usr/local/bin";
    await provisionLinuxHost(harness.deps);
    expect(harness.execCalls.some((argv) => argv[0] === "ln")).toBe(false);
  });

  test("a non-apt host with docker but no Compose v2 is refused with the prerequisite pointer", async () => {
    const harness = await makeDeps({
      hasApt: false,
      composeWorks: false,
      existingCommands: [...HOST_REQUIRED_COMMANDS, "pnpm"],
    });
    await expect(provisionLinuxHost(harness.deps)).rejects.toThrow(/docker compose/);
  });

  test("existing users and an existing profile are left alone", async () => {
    const harness = await makeDeps({
      existingUsers: HOST_SERVICE_ACCOUNTS.map((account) => account.user),
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
      existingUsers: HOST_SERVICE_ACCOUNTS.map((account) => account.user),
    });
    await expect(provisionLinuxHost(harness.deps)).resolves.toBeUndefined();
  });

  test("a non-apt host missing commands fails with the complete list", async () => {
    const harness = await makeDeps({ hasApt: false, existingCommands: ["bash", "git"] });
    await expect(provisionLinuxHost(harness.deps)).rejects.toThrow(/bwrap/);
  });
});
