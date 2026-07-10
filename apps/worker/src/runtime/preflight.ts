import { execa } from "execa";
import { access, mkdir as fsMkdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveBackendDistDir } from "./select.js";

export type PreflightDeps = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  getuid: () => number;
  pathExists: (p: string) => Promise<boolean>;
  isDirectory: (p: string) => Promise<boolean>;
  mkdir: (p: string) => Promise<void>;
  commandExists: (name: string) => Promise<boolean>;
  userExists: (name: string) => Promise<boolean>;
  canTraverseAs: (user: string, dir: string) => Promise<boolean>;
  backendDistDir: () => string;
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
  // PATH to exec directly, so this must run through a shell.
  const result = await execa("sh", ["-lc", `command -v ${name}`], { reject: false });
  return result.exitCode === 0;
}

async function defaultUserExists(name: string): Promise<boolean> {
  const result = await execa("id", ["-u", name], { reject: false });
  return result.exitCode === 0;
}

async function defaultCanTraverseAs(user: string, dir: string): Promise<boolean> {
  const result = await execa("runuser", ["-u", user, "--", "test", "-x", dir], { reject: false });
  return result.exitCode === 0;
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
    canTraverseAs: defaultCanTraverseAs,
    backendDistDir: resolveBackendDistDir,
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
 * unset, since there's nothing to mkdir), and check 9's traversal probe is
 * skipped when check 6 (app user) already failed -- there's no user to probe
 * traversal as.
 */
export async function collectSystemdPreflightIssues(deps: PreflightDeps): Promise<string[]> {
  const issues: string[] = [];

  // 1. Platform is linux.
  if (deps.platform !== "linux") {
    issues.push(`The systemd runtime requires a Linux host, but this process reports platform "${deps.platform}". Run with EVELAND_RUNTIME=docker instead, or deploy on Linux.`);
  }

  // 2. systemd is present.
  if (!(await deps.pathExists("/run/systemd/system"))) {
    issues.push("systemd was not detected: /run/systemd/system does not exist. The systemd runtime requires a host booted with systemd as PID 1.");
  }

  // 3. Running as root -- the worker itself shells out to systemd-run, systemctl and chown.
  const uid = deps.getuid();
  if (uid !== 0) {
    issues.push(`The worker must run as root to drive systemd-run/systemctl/chown, but its uid is ${uid}. Run the worker process as root.`);
  }

  // 4. EVELAND_DATA_DIR set and absolute -- the API container and this worker
  // must agree on stored sourcePath values, so a relative default is unsafe.
  const dataDir = deps.env.EVELAND_DATA_DIR;
  if (!dataDir) {
    issues.push('EVELAND_DATA_DIR is not set. Set it to an absolute path (e.g. "/var/lib/eveland") shared by the API container and this worker.');
  } else if (!path.isAbsolute(dataDir)) {
    issues.push(`EVELAND_DATA_DIR ("${dataDir}") must be an absolute path (e.g. "/var/lib/eveland") shared by the API container and this worker.`);
  }

  // 5. Required binaries.
  const requiredBinaries = ["systemd-run", "systemctl", "node", ...(deps.env.EVELAND_BUILD_SANDBOX === "none" ? [] : ["bwrap"])];
  for (const bin of requiredBinaries) {
    if (!(await deps.commandExists(bin))) {
      issues.push(`Required binary "${bin}" was not found on PATH. Install it before starting the worker.`);
    }
  }

  // 6. The app user exists.
  const appUser = deps.env.EVELAND_APP_USER ?? "eveland-app";
  const appUserExists = await deps.userExists(appUser);
  if (!appUserExists) {
    issues.push(`App user "${appUser}" does not exist. Create it (e.g. "useradd --system --no-create-home ${appUser}") before starting the worker.`);
  }

  // 7. /workspace exists and is a directory -- bwrap's bind destination (see sandbox-verify.ts);
  // bwrap cannot create it itself because the host root is bind-mounted read-only first.
  if (!((await deps.pathExists("/workspace")) && (await deps.isDirectory("/workspace")))) {
    issues.push('/workspace does not exist as a directory. Create it with "mkdir -p /workspace" -- bwrap binds it as the sandbox workspace destination and cannot create it itself.');
  }

  // 8. The sandbox backend is built.
  try {
    deps.backendDistDir();
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  // 9. The data dir is usable: mkdir it, then confirm the app user can traverse it.
  // Skipped entirely when EVELAND_DATA_DIR is unset (check 4 already reported that).
  if (dataDir) {
    // A throwing mkdir (e.g. EACCES when check 3's root requirement is also
    // violated) must become one more issue, not reject the whole collection
    // and discard everything checks 1-8 already found.
    let dataDirCreated = true;
    try {
      await deps.mkdir(dataDir);
    } catch (error) {
      dataDirCreated = false;
      issues.push(`Could not create the data dir "${dataDir}": ${error instanceof Error ? error.message : String(error)}. Ensure the worker can create it, or create it manually.`);
    }
    // No user to probe traversal as when check 6 failed; no dir to probe when mkdir did.
    if (dataDirCreated && appUserExists && !(await deps.canTraverseAs(appUser, dataDir))) {
      issues.push(
        `App user "${appUser}" cannot traverse the data dir "${dataDir}". Releases are chowned to that user under ` +
          `<dataDir>/builds, but a non-traversable ancestor (e.g. mode 0700) still blocks the unit at start -- ` +
          `ensure every ancestor directory grants execute/traverse permission to "${appUser}" (e.g. "chmod o+x" each ancestor).`,
      );
    }
  }

  return issues;
}

/**
 * No-op unless EVELAND_RUNTIME=systemd -- the docker runtime has no host
 * prerequisites for this worker to preflight.
 */
export async function assertWorkerPreflight(env: NodeJS.ProcessEnv, overrides: Partial<PreflightDeps> = {}): Promise<void> {
  if (env.EVELAND_RUNTIME !== "systemd") {
    return;
  }

  const deps: PreflightDeps = { ...defaultDeps(env), ...overrides };
  const issues = await collectSystemdPreflightIssues(deps);
  if (issues.length > 0) {
    throw new Error(`systemd runtime preflight failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  }
}
