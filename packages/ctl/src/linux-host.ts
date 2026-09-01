import path from "node:path";
import { readFile } from "node:fs/promises";
import type { ExecCommand, StreamCommand } from "./io.ts";

/**
 * Linux production-host provisioning, run by first boot as root: the
 * productized form of docs/en/production/prerequisites.md. Everything here
 * is what the worker's systemd preflight fails closed on — the sandbox
 * toolchain, the bwrap AppArmor profile, /workspace, the two service users,
 * and the system-PATH node/pnpm that deployment units and sandboxes see.
 * Idempotent: every step checks before it changes.
 */

// docs/en/production/prerequisites.md's apt list — minus docker.io, which
// is installed separately and only when no docker exists: on a host that
// already runs Docker CE, docker.io conflicts with containerd.io.
export const HOST_APT_PACKAGES = [
  "apparmor",
  "bash",
  "bubblewrap",
  "ca-certificates",
  "curl",
  "findutils",
  "git",
  "grep",
  "jq",
  "python-is-python3",
  "python3",
  "python3-pip",
  "ripgrep",
  "unzip",
  "zstd",
];

// The preflight's PATH contract (required binaries + sandbox toolchain),
// checked directly on distros without apt.
export const HOST_REQUIRED_COMMANDS = [
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
];

// docs/en/production/prerequisites.md's bwrap AppArmor profile, verbatim:
// Ubuntu restricts unprivileged user namespaces and ships no profile for
// bubblewrap, so both sandboxes (build user, Deployment DynamicUser) would
// fail without it. The profile grants exactly userns — narrower than
// flipping the kernel-wide sysctl off.
export const BWRAP_APPARMOR_PROFILE = `abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/bwrap>
}
`;

export type LinuxHostDeps = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  execCommand: ExecCommand;
  streamCommand: StreamCommand;
  fileExists: (filePath: string) => Promise<boolean>;
  writeTextFile: (filePath: string, content: string) => Promise<void>;
  env: NodeJS.ProcessEnv;
  repoRootDir: string;
  /** Directory holding the pinned node binary; symlinked onto the system PATH. */
  nodeBinDir: string;
  getuid: () => number;
};

async function commandExists(deps: LinuxHostDeps, command: string): Promise<boolean> {
  const result = await deps.execCommand(["sh", "-c", `command -v ${command}`], {
    cwd: deps.repoRootDir,
  });
  return result.code === 0;
}

/**
 * Probes with a FIXED system PATH: the provisioner's own PATH carries the
 * installer's node bin dir, so an inherited-PATH probe would see pnpm there
 * and skip the system-wide install that deployment units and bwrap
 * sandboxes (which run with a plain system PATH) actually need.
 */
async function commandExistsOnSystemPath(deps: LinuxHostDeps, command: string): Promise<boolean> {
  const result = await deps.execCommand(
    [
      "env",
      "-i",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "sh",
      "-c",
      `command -v ${command}`,
    ],
    { cwd: deps.repoRootDir },
  );
  return result.code === 0;
}

async function debInstalled(deps: LinuxHostDeps, pkg: string): Promise<boolean> {
  const result = await deps.execCommand(["dpkg", "-s", pkg], { cwd: deps.repoRootDir });
  return result.code === 0;
}

/**
 * Docker + Compose v2 on an apt host, from ONE package family. Ubuntu's
 * docker-compose-v2 depends on docker.io, which conflicts with Docker CE's
 * containerd.io; Docker CE ships Compose as docker-compose-plugin. A host
 * with neither gets Ubuntu's pair; a host whose Docker family is unknown
 * (static binary, snap) is told how to add Compose instead of guessed at.
 */
export async function dockerPackagesToInstall(deps: LinuxHostDeps): Promise<string[]> {
  if (!(await commandExists(deps, "docker"))) return ["docker.io", "docker-compose-v2"];
  const compose = await deps.execCommand(["docker", "compose", "version"], {
    cwd: deps.repoRootDir,
  });
  if (compose.code === 0) return [];
  if (await debInstalled(deps, "docker-ce")) return ["docker-compose-plugin"];
  if (await debInstalled(deps, "docker.io")) return ["docker-compose-v2"];
  throw new Error(
    "docker is installed but `docker compose` is not, and its package family is unknown. " +
      "Install Compose v2 the way you installed Docker (Docker CE: apt-get install docker-compose-plugin; " +
      "Ubuntu: apt-get install docker-compose-v2) and re-run.",
  );
}

async function userExists(deps: LinuxHostDeps, user: string): Promise<boolean> {
  const result = await deps.execCommand(["id", "-u", user], { cwd: deps.repoRootDir });
  return result.code === 0;
}

export async function provisionLinuxHost(deps: LinuxHostDeps): Promise<void> {
  if (deps.getuid() !== 0) {
    deps.stderr(
      "Not running as root: skipping Linux host provisioning (sandbox toolchain, users, /workspace).",
    );
    deps.stderr(
      "The worker's systemd preflight will fail until the host is prepared — see docs/production/prerequisites.",
    );
    return;
  }

  // 1. The sandbox toolchain. apt hosts install the documented package list;
  // anything else must already have the commands and merely gets verified.
  if (await commandExists(deps, "apt-get")) {
    deps.stdout("Provisioning the sandbox toolchain (apt)...");
    const aptEnv = { ...deps.env, DEBIAN_FRONTEND: "noninteractive" };
    await deps.streamCommand(["apt-get", "update"], { cwd: deps.repoRootDir, env: aptEnv });
    const install = await deps.streamCommand(["apt-get", "install", "-y", ...HOST_APT_PACKAGES], {
      cwd: deps.repoRootDir,
      env: aptEnv,
    });
    if (install !== 0) {
      throw new Error("apt-get install of the sandbox toolchain failed; see the output above.");
    }
    const dockerPackages = await dockerPackagesToInstall(deps);
    if (dockerPackages.length > 0) {
      deps.stdout(`Installing ${dockerPackages.join(" ")} via apt...`);
      const dockerInstall = await deps.streamCommand(
        ["apt-get", "install", "-y", ...dockerPackages],
        { cwd: deps.repoRootDir, env: aptEnv },
      );
      if (dockerInstall !== 0) {
        throw new Error(
          `apt-get install ${dockerPackages.join(" ")} failed; install Docker and Compose v2 and re-run.`,
        );
      }
    }
  } else {
    const missing: string[] = [];
    for (const command of HOST_REQUIRED_COMMANDS) {
      if (!(await commandExists(deps, command))) missing.push(command);
    }
    if (missing.length > 0) {
      throw new Error(
        `This host has no apt-get and is missing required commands: ${missing.join(", ")}. ` +
          "Install them with your package manager (see docs/production/prerequisites) and re-run.",
      );
    }
  }

  // 2. The bwrap AppArmor profile (only where AppArmor manages profiles).
  const profilePath = "/etc/apparmor.d/bwrap";
  if ((await deps.fileExists("/etc/apparmor.d")) && !(await deps.fileExists(profilePath))) {
    deps.stdout("Installing the bwrap AppArmor profile (grants userns to the sandboxes)...");
    await deps.writeTextFile(profilePath, BWRAP_APPARMOR_PROFILE);
    const load = await deps.execCommand(["apparmor_parser", "-r", "-W", profilePath], {
      cwd: deps.repoRootDir,
    });
    if (load.code !== 0) {
      deps.stderr(
        `Loading the AppArmor profile failed (${load.output.trim().slice(0, 200)}); ` +
          "if AppArmor is disabled on this host this is harmless.",
      );
    }
  }

  // 3. /workspace: bwrap's bind destination; it cannot create it itself.
  const workspace = await deps.execCommand(["install", "-d", "-m", "0755", "/workspace"], {
    cwd: deps.repoRootDir,
  });
  if (workspace.code !== 0) {
    throw new Error(`Could not create /workspace:\n${workspace.output.trim()}`);
  }

  // 4. The two service users, exactly as the preflight prescribes them.
  if (!(await userExists(deps, "eveland-app"))) {
    deps.stdout("Creating the eveland-app artifact-access user...");
    const result = await deps.execCommand(
      [
        "useradd",
        "--system",
        "--user-group",
        "--home-dir",
        "/var/lib/eveland-app",
        "--create-home",
        "eveland-app",
      ],
      { cwd: deps.repoRootDir },
    );
    if (result.code !== 0) throw new Error(`useradd eveland-app failed:\n${result.output.trim()}`);
  }
  if (!(await userExists(deps, "eveland-build"))) {
    deps.stdout("Creating the eveland-build build user...");
    const result = await deps.execCommand(
      [
        "useradd",
        "--system",
        "--home-dir",
        "/var/lib/eveland-build",
        "--create-home",
        "eveland-build",
      ],
      { cwd: deps.repoRootDir },
    );
    if (result.code !== 0) {
      throw new Error(`useradd eveland-build failed:\n${result.output.trim()}`);
    }
  }

  // 5. The system-PATH toolchain: deployment units and bwrap sandboxes run
  // with a plain system PATH, so the pinned node (and pnpm via corepack)
  // must be reachable there, not only in the installer's environment.
  await linkNodeOnSystemPath(deps);
  if (!(await commandExistsOnSystemPath(deps, "pnpm"))) {
    const pin = await pinnedPnpmVersion(deps.repoRootDir);
    deps.stdout(`Installing pnpm@${pin} onto the system PATH via corepack...`);
    const corepack = path.join(deps.nodeBinDir, "corepack");
    const enable = await deps.execCommand(
      [corepack, "enable", "--install-directory", "/usr/local/bin"],
      { cwd: deps.repoRootDir },
    );
    const install = await deps.execCommand([corepack, "install", "--global", `pnpm@${pin}`], {
      cwd: deps.repoRootDir,
    });
    if (enable.code !== 0 || install.code !== 0) {
      throw new Error(
        "corepack could not put pnpm on the system PATH; install pnpm globally and re-run.",
      );
    }
  }
  deps.stdout("Linux host provisioning complete.");
}

/**
 * (Re)points /usr/local/bin/{node,npm,npx} at the pinned interpreter. Also
 * run whenever the systemd artifacts are regenerated: a Node repair or an
 * update may have moved the pin, and a stale link would keep pointing at
 * an interpreter nvm removed.
 */
export async function linkNodeOnSystemPath(
  deps: Pick<LinuxHostDeps, "execCommand" | "fileExists" | "nodeBinDir" | "repoRootDir">,
): Promise<void> {
  for (const binary of ["node", "npm", "npx"]) {
    const target = path.join(deps.nodeBinDir, binary);
    if (await deps.fileExists(target)) {
      const link = await deps.execCommand(
        ["ln", "-sf", target, path.join("/usr/local/bin", binary)],
        { cwd: deps.repoRootDir },
      );
      if (link.code !== 0) {
        throw new Error(`Linking ${binary} onto the system PATH failed:\n${link.output.trim()}`);
      }
    }
  }
}

async function pinnedPnpmVersion(repoRootDir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(repoRootDir, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  return manifest.packageManager?.replace(/^pnpm@/, "") ?? "latest";
}
