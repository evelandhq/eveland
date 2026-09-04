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

/**
 * The unprivileged system user the API runs as.
 *
 * Deliberately NOT `eveland-app`: that identity exists so a deployed Agent's
 * artifacts can be read by tenant code, and giving the platform's own trust
 * root the same uid would put the API's uploads and the tenant artifact tree
 * under one owner. Deliberately not `DynamicUser=yes` either: the API owns
 * files that outlive one start (uploaded sources), and a uid that changes
 * every boot orphans them.
 *
 * It is the API's uid ALONE. The API's environment is the whole platform
 * configuration, and same-uid processes read each other's
 * `/proc/<pid>/environ` — Linux gates that on `PTRACE_MODE_READ_FSCREDS`,
 * which Yama's ptrace_scope does not restrict. Sharing this uid with the
 * public front door would hand a compromised proxy exactly the secrets
 * `GATEWAY_ENV_KEYS` exists to withhold.
 */
export const PLATFORM_SERVICE_USER = "eveland-platform";

/** Its home; the units point HOME here so nothing falls back to an unwritable one. */
export const PLATFORM_SERVICE_HOME = "/var/lib/eveland-platform";

/**
 * The Dashboard's own unprivileged user — separate from the API's for the
 * reason above, and a fixed uid rather than `DynamicUser=yes` because
 * `next start` owns a build cache (`apps/web/.next`) that outlives one boot.
 *
 * The Agent Gateway needs no entry here: it writes nothing that survives a
 * restart, so its unit takes `DynamicUser=yes` and a fresh uid every boot.
 */
export const WEB_SERVICE_USER = "eveland-web";
export const WEB_SERVICE_HOME = "/var/lib/eveland-web";

/** Every system account `provisionLinuxHost` guarantees, in creation order. */
export const HOST_SERVICE_ACCOUNTS: ReadonlyArray<{
  user: string;
  home: string;
  purpose: string;
  ownGroup: boolean;
}> = [
  {
    user: PLATFORM_SERVICE_USER,
    home: PLATFORM_SERVICE_HOME,
    purpose: "platform API service",
    ownGroup: true,
  },
  { user: WEB_SERVICE_USER, home: WEB_SERVICE_HOME, purpose: "Dashboard service", ownGroup: true },
  { user: "eveland-app", home: "/var/lib/eveland-app", purpose: "artifact-access", ownGroup: true },
  { user: "eveland-build", home: "/var/lib/eveland-build", purpose: "build", ownGroup: false },
];

/**
 * Every account in `HOST_SERVICE_ACCOUNTS`, created if missing.
 *
 * Called from the first-boot provisioning AND from every render of the
 * systemd units, because those are two different moments: an installation
 * provisioned before a service gained its own identity gets the new units
 * from an update, and a unit naming a user this host does not have fails to
 * start with "Failed to determine user credentials".
 */
export async function ensureHostServiceAccounts(deps: {
  execCommand: ExecCommand;
  repoRootDir: string;
  stdout: (line: string) => void;
}): Promise<void> {
  for (const account of HOST_SERVICE_ACCOUNTS) {
    const exists = await deps.execCommand(["id", "-u", account.user], { cwd: deps.repoRootDir });
    if (exists.code === 0) continue;
    deps.stdout(`Creating the ${account.user} ${account.purpose} user...`);
    const result = await deps.execCommand(
      [
        "useradd",
        "--system",
        // Its own group, so one service's files are never group-readable by
        // another's. eveland-build is the exception the worker prescribes.
        ...(account.ownGroup ? ["--user-group"] : []),
        "--home-dir",
        account.home,
        "--create-home",
        account.user,
      ],
      { cwd: deps.repoRootDir },
    );
    if (result.code !== 0) {
      throw new Error(`useradd ${account.user} failed:\n${result.output.trim()}`);
    }
  }
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
    const compose = await deps.execCommand(["docker", "compose", "version"], {
      cwd: deps.repoRootDir,
    });
    if (compose.code !== 0) {
      throw new Error(
        "This host has docker but no `docker compose` (v2). Install Compose v2 with your package " +
          "manager (see docs/production/prerequisites) and re-run.",
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

  // 4. The service users: the two the worker's preflight prescribes, plus one
  // unprivileged identity per platform service that owns files.
  await ensureHostServiceAccounts(deps);

  // 5. The system-PATH toolchain: deployment units and bwrap sandboxes run
  // with a plain system PATH, so the pinned node (and pnpm via corepack)
  // must be reachable there, not only in the installer's environment.
  await refreshSystemToolchain(deps);
  deps.stdout("Linux host provisioning complete.");
}

const SYSTEM_BIN_DIR = "/usr/local/bin";

/**
 * (Re)points /usr/local/bin/{node,npm,npx,corepack,pnpm} at the pinned
 * interpreter's bin dir and makes sure a WORKING pnpm sits there. Also run
 * whenever the systemd artifacts are regenerated: a Node repair or an
 * update may have moved the pin, and a stale link — or corepack's pnpm
 * shim, which points into the old interpreter's lib dir — would keep
 * resolving to an interpreter nvm removed. pnpm is probed functionally
 * (`pnpm --version` on a plain system PATH), not by existence, for exactly
 * that reason. Corepack is optional: a Node without it (or the installer's
 * `npm i -g pnpm` fallback) already carries pnpm in its own bin dir, which
 * is linked like the rest; failing that, pnpm is installed into that bin
 * dir with the interpreter's npm.
 */
export async function refreshSystemToolchain(
  deps: Pick<LinuxHostDeps, "execCommand" | "fileExists" | "nodeBinDir" | "repoRootDir"> & {
    stdout?: (line: string) => void;
  },
): Promise<void> {
  const nodeBinDir = path.resolve(deps.nodeBinDir);
  const linkAll = async () => {
    for (const binary of ["node", "npm", "npx", "corepack", "pnpm"]) {
      const target = path.join(nodeBinDir, binary);
      const linkPath = path.join(SYSTEM_BIN_DIR, binary);
      // An interpreter that already lives in /usr/local/bin must not be
      // replaced by a symlink to itself (ln -sf would happily do that).
      if (target === linkPath) continue;
      if (await deps.fileExists(target)) {
        const link = await deps.execCommand(["ln", "-sf", target, linkPath], {
          cwd: deps.repoRootDir,
        });
        if (link.code !== 0) {
          throw new Error(`Linking ${binary} onto the system PATH failed:\n${link.output.trim()}`);
        }
      }
    }
  };
  await linkAll();
  const pin = await pinnedPnpmVersion(deps.repoRootDir);
  // Working AND the pinned version: any runnable pnpm would otherwise
  // silently satisfy the probe and bypass the repo's packageManager pin.
  // (A checkout without a pin — no package.json yet — accepts any working pnpm.)
  const pnpmIsPinned = async () => {
    const version = await commandVersionOnSystemPath(deps, "pnpm");
    return version !== null && (pin === null || version === pin);
  };
  if (await pnpmIsPinned()) return;

  const corepack = path.join(nodeBinDir, "corepack");
  if (await deps.fileExists(corepack)) {
    deps.stdout?.(`Installing pnpm@${pin ?? "latest"} onto the system PATH via corepack...`);
    const enable = await deps.execCommand(
      [corepack, "enable", "--install-directory", SYSTEM_BIN_DIR],
      { cwd: deps.repoRootDir },
    );
    const install = await deps.execCommand(
      [corepack, "install", "--global", `pnpm@${pin ?? "latest"}`],
      {
        cwd: deps.repoRootDir,
      },
    );
    if (enable.code === 0 && install.code === 0 && (await pnpmIsPinned())) return;
  }
  // No (working) corepack: install pnpm into the interpreter's own prefix
  // with its npm, then link it like the rest of the toolchain.
  deps.stdout?.(`Installing pnpm@${pin ?? "latest"} into ${nodeBinDir} via npm (no corepack)...`);
  const npmInstall = await deps.execCommand(
    [path.join(nodeBinDir, "npm"), "install", "-g", `pnpm@${pin ?? "latest"}`],
    { cwd: deps.repoRootDir },
  );
  if (npmInstall.code === 0) await linkAll();
  if (npmInstall.code !== 0 || !(await pnpmIsPinned())) {
    throw new Error(
      `Could not put pnpm@${pin ?? "latest"} on the system PATH (neither corepack nor \`npm install -g pnpm\` produced it); ` +
        "install that version globally and re-run.",
    );
  }
}

/**
 * `<command> --version` on a FIXED system PATH: a dangling shim fails where
 * `command -v` would pass. Returns the reported version, or null.
 */
async function commandVersionOnSystemPath(
  deps: Pick<LinuxHostDeps, "execCommand" | "repoRootDir">,
  command: string,
): Promise<string | null> {
  const result = await deps.execCommand(
    [
      "env",
      "-i",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      command,
      "--version",
    ],
    { cwd: deps.repoRootDir },
  );
  if (result.code !== 0) return null;
  return result.output.trim().split("\n")[0]?.replace(/^v/, "") ?? null;
}

/** The repo's packageManager pin; null when the checkout has no package.json (or no pin). */
async function pinnedPnpmVersion(repoRootDir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(repoRootDir, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    const pin = manifest.packageManager?.replace(/^pnpm@/, "");
    return pin && pin !== manifest.packageManager ? pin : null;
  } catch {
    return null;
  }
}
