import { execa } from "execa";
import { assertValidSecretKey } from "@eveland/core/server/secrets";
import { access, mkdir as fsMkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { SANDBOX_TOOLCHAIN_COMMANDS } from "./sandbox-toolchain.js";
import { resolveBackendDistDir, resolveRuntimeKind } from "./select.js";

const devSecretKey = "eveland-dev-secret-key-000000000";

export type PreflightDeps = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  getuid: () => number;
  pathExists: (p: string) => Promise<boolean>;
  isDirectory: (p: string) => Promise<boolean>;
  mkdir: (p: string) => Promise<void>;
  commandExists: (name: string) => Promise<boolean>;
  userExists: (name: string) => Promise<boolean>;
  groupExists: (name: string) => Promise<boolean>;
  canTraverseAs: (user: string, dir: string) => Promise<boolean>;
  backendDistDir: () => string;
  probeDockerNetworkPool: () => Promise<string | undefined>;
};

async function defaultPathExists(p: string): Promise<boolean> {
  return await access(p).then(
    () => true,
    () => false,
  );
}

async function defaultIsDirectory(p: string): Promise<boolean> {
  return await stat(p).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function defaultMkdir(p: string): Promise<void> {
  await fsMkdir(p, { recursive: true });
}

async function defaultCommandExists(name: string): Promise<boolean> {
  // `command` is a shell builtin, not an executable -- there is nothing on
  // PATH to exec directly, so this must run through a shell. Use a non-login
  // shell (`-c`, not `-lc`): a login shell sources root's profile, which can
  // put a binary on PATH that the worker's own child processes (execa calls
  // against the plain service PATH, no profile sourced) would never see --
  // this probe must see exactly the PATH the worker's own children get.
  const result = await execa("sh", ["-c", `command -v ${name}`], { reject: false });
  return result.exitCode === 0;
}

async function defaultUserExists(name: string): Promise<boolean> {
  const result = await execa("id", ["-u", name], { reject: false });
  return result.exitCode === 0;
}

async function defaultGroupExists(name: string): Promise<boolean> {
  const result = await execa("sh", ["-c", 'getent group "$1" >/dev/null 2>&1', "preflight", name], {
    reject: false,
  });
  return result.exitCode === 0;
}

async function defaultCanTraverseAs(user: string, dir: string): Promise<boolean> {
  const result = await execa("runuser", ["-u", user, "--", "test", "-x", dir], { reject: false });
  return result.exitCode === 0;
}

export async function probeDockerNetworkPool(): Promise<string | undefined> {
  const networkName = `eveland-agent-preflight-${randomUUID()}`;
  const create = await execa(
    "docker",
    ["network", "create", "--label", "com.eveland.managed=preflight", networkName],
    { all: true, reject: false },
  );
  if (create.failed) {
    return create.all?.trim() || "docker network create failed";
  }
  const remove = await execa("docker", ["network", "rm", networkName], {
    all: true,
    reject: false,
  });
  if (remove.failed) {
    return remove.all?.trim() || "Docker allocated the preflight network but could not remove it.";
  }
  return undefined;
}

function defaultDeps(env: NodeJS.ProcessEnv): PreflightDeps {
  return {
    env,
    platform: process.platform,
    getuid: () => process.getuid?.() ?? -1,
    pathExists: defaultPathExists,
    isDirectory: defaultIsDirectory,
    mkdir: defaultMkdir,
    commandExists: defaultCommandExists,
    userExists: defaultUserExists,
    groupExists: defaultGroupExists,
    canTraverseAs: defaultCanTraverseAs,
    backendDistDir: resolveBackendDistDir,
    probeDockerNetworkPool,
  };
}

/**
 * Collects every host prerequisite failure for the systemd runtime rather than
 * throwing on the first one -- a misconfigured production host is far more
 * useful to an operator as one complete punch list than as a series of
 * fix-one-rerun-hit-the-next cycles.
 *
 * Checks 4-9 still run even when an earlier check already failed, except:
 * checks 8/9 gracefully no-op when their own inputs are missing (check 8 via
 * its own try/catch below; check 9 skips entirely when EVELAND_DATA_DIR is
 * unset or not absolute, since there's nothing safe to mkdir -- check 4
 * already reported either case), and check 9's two traversal probes are each
 * skipped independently when their own user is missing -- the app-user probe
 * when check 6 (app user) failed, the build-user probe when check 6b (build
 * user) failed -- there's no user to probe traversal as either way.
 */
export async function collectSystemdPreflightIssues(deps: PreflightDeps): Promise<string[]> {
  const issues: string[] = [];

  // 1. Platform is linux.
  if (deps.platform !== "linux") {
    issues.push(
      `The systemd runtime requires a Linux host, but this process reports platform "${deps.platform}". Run with EVELAND_RUNTIME=docker instead, or deploy on Linux.`,
    );
  }

  // 2. systemd is present.
  if (!(await deps.pathExists("/run/systemd/system"))) {
    issues.push(
      "systemd was not detected: /run/systemd/system does not exist. The systemd runtime requires a host booted with systemd as PID 1.",
    );
  }

  // 3. Running as root -- the worker itself shells out to systemd-run, systemctl and chown.
  const uid = deps.getuid();
  if (uid !== 0) {
    issues.push(
      `The worker must run as root to drive systemd-run/systemctl/chown, but its uid is ${uid}. Run the worker process as root.`,
    );
  }

  // 4. EVELAND_DATA_DIR set and absolute -- the API container and this worker
  // must agree on stored sourcePath values, so a relative default is unsafe.
  const dataDir = deps.env.EVELAND_DATA_DIR;
  if (!dataDir) {
    issues.push(
      'EVELAND_DATA_DIR is not set. Set it to an absolute path (e.g. "/var/lib/eveland") shared by the API container and this worker.',
    );
  } else if (!path.isAbsolute(dataDir)) {
    issues.push(
      `EVELAND_DATA_DIR ("${dataDir}") must be an absolute path (e.g. "/var/lib/eveland") shared by the API container and this worker.`,
    );
  }

  // 5. Required binaries. The sandbox toolchain is platform-owned on systemd:
  // bwrap mounts the host root read-only, so a project cannot repair a missing
  // command after deployment. `git` also serves the worker's import_source
  // jobs. Docker validates and reloads the platform Collector configuration.
  // `runuser` is unconditional because builds execute under it even when
  // EVELAND_BUILD_SANDBOX=none; only the bwrap build wrapper is optional.
  const requiredBinaries = [
    ...new Set([
      "systemd-run",
      "systemctl",
      "runuser",
      "docker",
      // Deployment readiness verifies the listening socket's owner (ss) and
      // maps the holding pid back to its systemd unit (ps -o unit=).
      "ss",
      "ps",
      ...SANDBOX_TOOLCHAIN_COMMANDS,
      ...(deps.env.EVELAND_BUILD_SANDBOX === "none" ? [] : ["bwrap"]),
    ]),
  ];
  for (const bin of requiredBinaries) {
    if (!(await deps.commandExists(bin))) {
      issues.push(
        `Required binary "${bin}" was not found on PATH. Install it before starting the worker.`,
      );
    }
  }

  // 6. The app user exists.
  const appUser = deps.env.EVELAND_APP_USER ?? "eveland-app";
  const appUserExists = await deps.userExists(appUser);
  if (!appUserExists) {
    issues.push(
      `App user "${appUser}" does not exist. Create it with a same-named group (e.g. "useradd --system --user-group --no-create-home ${appUser}") before starting the worker.`,
    );
  } else if (!(await deps.groupExists(appUser))) {
    issues.push(
      `Access group "${appUser}" does not exist. Dynamic Deployment users require a same-named group; recreate or update the app user with "--user-group" before starting the worker.`,
    );
  }

  // 6b. The build user exists -- npm ci/npx eve build's third-party lifecycle
  // scripts now run as this user via `runuser` (systemd.ts's buildRelease),
  // not as the worker's own root user.
  const buildUser = deps.env.EVELAND_BUILD_USER ?? "eveland-build";
  const buildUserExists = await deps.userExists(buildUser);
  if (!buildUserExists) {
    issues.push(
      `Build user "${buildUser}" does not exist (configure via EVELAND_BUILD_USER). Create it (e.g. "useradd --system --home-dir /var/lib/${buildUser} --create-home ${buildUser}") before starting the worker.`,
    );
  }

  // 7. /workspace exists and is a directory -- bwrap's bind destination (see sandbox-verify.ts);
  // bwrap cannot create it itself because the host root is bind-mounted read-only first.
  if (!((await deps.pathExists("/workspace")) && (await deps.isDirectory("/workspace")))) {
    issues.push(
      '/workspace does not exist as a directory. Create it with "mkdir -p /workspace" -- bwrap binds it as the sandbox workspace destination and cannot create it itself.',
    );
  }

  // 8. The sandbox backend is built.
  try {
    deps.backendDistDir();
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  // 9. The data dir is usable: mkdir it, then confirm the app user can traverse it.
  // Skipped entirely when EVELAND_DATA_DIR is unset or relative (check 4 already
  // reported either case) -- a relative value would otherwise get mkdir'd relative
  // to the worker's cwd, littering a stray directory that select.ts would never
  // resolve to the same path, on top of a second, confusing issue.
  if (dataDir && path.isAbsolute(dataDir)) {
    // A throwing mkdir (e.g. EACCES when check 3's root requirement is also
    // violated) must become one more issue, not reject the whole collection
    // and discard everything checks 1-8 already found.
    let dataDirCreated = true;
    try {
      await deps.mkdir(dataDir);
    } catch (error) {
      dataDirCreated = false;
      issues.push(
        `Could not create the data dir "${dataDir}": ${error instanceof Error ? error.message : String(error)}. Ensure the worker can create it, or create it manually.`,
      );
    }
    // No user to probe traversal as when check 6 failed; no dir to probe when mkdir did.
    if (dataDirCreated && appUserExists && !(await deps.canTraverseAs(appUser, dataDir))) {
      issues.push(
        `App user "${appUser}" cannot traverse the data dir "${dataDir}". Releases are chowned to that user under ` +
          `<dataDir>/builds, but a non-traversable ancestor (e.g. mode 0700) still blocks the unit at start -- ` +
          `ensure every ancestor directory grants execute/traverse permission to "${appUser}" (e.g. "chmod o+x" each ancestor).`,
      );
    }
    // Sibling probe for the build user: same skip semantics (no build user to probe as
    // when check 6b failed; no dir to probe when mkdir did), independent of whether the
    // app-user probe above passed. The build runs as this user under <dataDir>/builds
    // and the npm cache, so a non-traversable ancestor fails the first build with a
    // confusing npm EACCES rather than a clear preflight message.
    if (dataDirCreated && buildUserExists && !(await deps.canTraverseAs(buildUser, dataDir))) {
      issues.push(
        `Build user "${buildUser}" cannot traverse the data dir "${dataDir}". The build runs as that user under ` +
          `<dataDir>/builds and the shared npm cache, but a non-traversable ancestor (e.g. mode 0700) fails the ` +
          `first build with a confusing npm EACCES -- ensure every ancestor directory grants execute/traverse ` +
          `permission to "${buildUser}" (e.g. "chmod o+x" each ancestor).`,
      );
    }
  }

  return issues;
}

/**
 * The encryption key is runtime-independent and is always validated. Host
 * prerequisite checks are otherwise a no-op unless the RESOLVED runtime is
 * systemd -- the docker runtime has no host prerequisites for this worker to
 * preflight. Gating on resolveRuntimeKind, not the raw EVELAND_RUNTIME,
 * matters: a production host (NODE_ENV=production, EVELAND_RUNTIME unset)
 * defaults to the systemd adapter and must get the same preflight as an
 * explicit EVELAND_RUNTIME=systemd.
 */
export async function assertWorkerPreflight(
  env: NodeJS.ProcessEnv,
  overrides: Partial<PreflightDeps> = {},
): Promise<void> {
  assertValidSecretKey(env.APP_SECRET_KEY ?? devSecretKey);
  assertSchedulerPreflight(env);
  const runtimeKind = resolveRuntimeKind(env);
  const deps: PreflightDeps = { ...defaultDeps(env), ...overrides };
  if (runtimeKind === "docker") {
    const networkPoolIssue = await deps.probeDockerNetworkPool();
    if (networkPoolIssue) {
      throw new Error(
        "docker runtime preflight failed: Docker could not allocate and release an Agent bridge network. " +
          "Configure a non-overlapping default-address-pools range in /etc/docker/daemon.json as documented in docs/deploy/linux.md. " +
          `Docker reported: ${networkPoolIssue}`,
      );
    }
    return;
  }

  const issues = await collectSystemdPreflightIssues(deps);
  if (issues.length > 0) {
    throw new Error(
      `systemd runtime preflight failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
  }
}

function assertSchedulerPreflight(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== "production") return;
  const secrets = [
    ["EVELAND_SCHEDULER_RUNTIME_SECRET", env.EVELAND_SCHEDULER_RUNTIME_SECRET],
    ["EVELAND_SCHEDULER_DISPATCH_SECRET", env.EVELAND_SCHEDULER_DISPATCH_SECRET],
  ] as const;
  for (const [name, value] of secrets) {
    if (!value) throw new Error(`${name} is required in production.`);
    if (Buffer.byteLength(value, "utf8") < 32)
      throw new Error(`${name} must be at least 32 bytes.`);
  }
  if (env.EVELAND_SCHEDULER_RUNTIME_SECRET === env.EVELAND_SCHEDULER_DISPATCH_SECRET) {
    throw new Error(
      "EVELAND_SCHEDULER_RUNTIME_SECRET and EVELAND_SCHEDULER_DISPATCH_SECRET must be independent values.",
    );
  }
  if (!env.EVELAND_SCHEDULER_REDEEM_URL) {
    throw new Error("EVELAND_SCHEDULER_REDEEM_URL is required in production.");
  }
  try {
    const url = new URL(env.EVELAND_SCHEDULER_REDEEM_URL);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("unsupported protocol");
  } catch {
    throw new Error("EVELAND_SCHEDULER_REDEEM_URL must be an absolute HTTP(S) URL.");
  }
}
