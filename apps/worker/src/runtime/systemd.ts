import { execa } from "execa";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferEveRuntimeCommand } from "@eveland/shared/runtime";
import { injectSandboxModules } from "./sandbox-inject.js";
import { verifySandbox } from "./sandbox-verify.js";
import { processSafeName, type ProcessStartInput, type ProcessStartResult, type ReleaseBuildInput, type ReleaseBuildResult, type RuntimeAdapter, type RuntimeCommandContext } from "./types.js";

export type SystemdStartInput = {
  unitName: string;
  releaseDir: string;
  envFilePath: string;
  port: number;
  user: string;
  memoryMax: string;
  cpuQuota: string;
  sandboxCacheDir: string;
  command: string;
};

/**
 * Every project's sandbox cache lives at `<root>/<processSafeName(projectId)>`.
 * Exported so `createSystemdAdapter` (which knows the projectId at build time)
 * and `jobs/process.ts` (which must pass the identical path into
 * `startProcess`, since `ProcessStartInput` carries no projectId) can never
 * compute two different paths for the same project.
 */
export function resolveProjectSandboxCacheDir(root: string, projectId: string): string {
  return path.resolve(root, processSafeName(projectId));
}

/**
 * Root holding every project's durable sandbox cache. `select.ts` (constructing
 * the systemd adapter) and `jobs/process.ts` (which must pass the identical
 * path into `startProcess`, since `ProcessStartInput` carries no projectId)
 * both call this so the two can never compute two different roots for the
 * same env -- a typo'd env var name in one of the two call sites is now a
 * single point of failure this function's own tests would catch.
 */
export function resolveSandboxCacheRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.EVELAND_SANDBOX_CACHE_DIR ?? path.join(env.EVELAND_DATA_DIR ?? ".eveland-data", "sandbox"));
}

export function buildSystemdRunArgs(input: SystemdStartInput): string[] {
  return [
    "--unit",
    input.unitName,
    "--collect",
    "--service-type=exec",
    "--property=Restart=on-failure",
    "--property=RestartSec=2",
    `--property=User=${input.user}`,
    `--property=WorkingDirectory=${input.releaseDir}`,
    `--property=EnvironmentFile=${input.envFilePath}`,
    `--property=Environment=PORT=${input.port}`,
    `--property=Environment=EVELAND_SANDBOX_CACHE_DIR=${input.sandboxCacheDir}`,
    `--property=MemoryMax=${input.memoryMax}`,
    `--property=CPUQuota=${input.cpuQuota}`,
    "--property=ProtectSystem=strict",
    `--property=ReadWritePaths=${input.releaseDir}`,
    // systemd list-type settings (ReadWritePaths= included) append across repeated
    // assignments rather than overwriting -- confirmed live via `systemd-run
    // --property=ReadWritePaths=/tmp --property=ReadWritePaths=/var/tmp` followed by
    // `systemctl show -p ReadWritePaths`, which reported "ReadWritePaths=/tmp /var/tmp".
    `--property=ReadWritePaths=${input.sandboxCacheDir}`,
    "--property=PrivateTmp=yes",
    "--property=NoNewPrivileges=yes",
    "sh",
    "-lc",
    input.command,
  ];
}

export function buildSystemdStartCommand(context: RuntimeCommandContext, port: number): string {
  if (context.isEveProject) {
    // Host process: loopback binding is enough, and Ollama on localhost needs no bridge.
    return `npx eve start --host 127.0.0.1 --port ${port}`;
  }
  return inferEveRuntimeCommand({ scripts: context.scripts });
}

export function buildReleaseBuildCommand(context: RuntimeCommandContext): string {
  const install = context.hasLockfile ? "npm ci" : "npm install";
  return context.isEveProject ? `${install} && npx eve build` : install;
}

export type BwrapBuildInput = {
  releaseDir: string;
  npmCacheDir: string;
  dataDir: string;
  command: string;
};

export function buildBwrapArgs(input: BwrapBuildInput): string[] {
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    // Shadow the whole data dir (deployment-env secrets, sources, every other
    // project's build) before re-exposing only this build's own release dir
    // and the shared npm cache. Without this, build-time npm/eve lifecycle
    // scripts -- which run as root, untrusted, from the imported project's
    // dependency tree -- could read every decrypted secret on the host via
    // the `--ro-bind / /` above. bwrap applies mounts in argument order and
    // creates bind destinations inside its own tmpfs, so the two --bind
    // entries below only re-open the subtrees they name.
    "--tmpfs", input.dataDir,
    "--bind", input.releaseDir, input.releaseDir,
    "--bind", input.npmCacheDir, input.npmCacheDir,
    "--unshare-pid",
    "--die-with-parent",
    "--chdir", input.releaseDir,
    "sh", "-lc", input.command,
  ];
}

/**
 * Wraps an argv so `execa("runuser", ...)` runs it as `user` instead of the
 * worker's own (root, in production) user. `--` stops `runuser` from parsing
 * any of the wrapped command's own leading flags (e.g. bwrap's `--ro-bind`)
 * as arguments to `runuser` itself.
 */
export function buildRunAsUserArgs(user: string, argv: string[]): string[] {
  return ["-u", user, "--", ...argv];
}

export function buildEnvFileContent(env: Record<string, string>): string {
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (value.includes("\n")) {
        throw new Error(`Secret ${key} contains a newline; systemd EnvironmentFile cannot represent it.`);
      }
      return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export type SystemctlCommandOutcome = {
  failed: boolean;
  exitCode?: number;
  stderr?: string;
};

/**
 * `systemctl stop`/`reset-failed` exit non-zero both when the unit was never
 * loaded -- an idempotent no-op eveland relies on (a half-finished delete
 * re-run, or a redeploy after the unit already exited and was reaped) --
 * and when systemctl itself is unusable (CLI missing, permission denied,
 * unknown failure). Only the former is safe to swallow silently; the caller
 * must throw on everything else so a missing/unreachable runtime fails the
 * job loudly instead of orphaning the process.
 */
export function isBenignSystemctlStopFailure(outcome: SystemctlCommandOutcome): boolean {
  if (!outcome.failed) {
    return true;
  }
  const stderr = outcome.stderr ?? "";
  return /not loaded/i.test(stderr) || /not found/i.test(stderr) || /no such/i.test(stderr);
}

async function runSystemctl(subcommand: string, unit: string): Promise<void> {
  const result = await execa("systemctl", [subcommand, unit], { reject: false });
  const outcome: SystemctlCommandOutcome = { failed: result.failed, exitCode: result.exitCode, stderr: result.stderr };
  if (isBenignSystemctlStopFailure(outcome)) {
    return;
  }
  throw new Error(
    `systemctl ${subcommand} ${unit} failed (exit ${outcome.exitCode ?? "none -- systemctl may be missing"}): ${
      outcome.stderr || "no stderr captured"
    }`,
  );
}

export type SystemdAdapterConfig = {
  dataDir: string;
  user: string;
  /** Unix user the build (`npm ci`/`npx eve build`, i.e. third-party lifecycle scripts) runs as. */
  buildUser: string;
  memoryMax: string;
  cpuQuota: string;
  buildSandbox: "bwrap" | "none";
  /** Root directory holding every project's durable eve sandbox session cache. */
  sandboxCacheDir: string;
  /**
   * Resolves the directory holding the built @eveland/sandbox-bwrap (its
   * dist/), vendored into each release. A provider rather than a resolved
   * string so constructing the adapter never touches the filesystem --
   * it's invoked only inside `buildRelease`, at the point the backend is
   * actually needed.
   */
  backendDistDir: () => string;
};

export function createSystemdAdapter(config: SystemdAdapterConfig): RuntimeAdapter {
  const dataDir = path.resolve(config.dataDir);
  const npmCacheDir = path.resolve(dataDir, "npm-cache");
  const envDir = path.resolve(dataDir, "deployment-env");
  const projectCacheDir = (projectId: string) => resolveProjectSandboxCacheDir(config.sandboxCacheDir, projectId);

  return {
    name: "systemd",
    async buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult> {
      const releaseDir = path.resolve(input.buildDir);
      await mkdir(releaseDir, { recursive: true });
      await mkdir(npmCacheDir, { recursive: true });
      await execa("cp", ["-a", `${path.resolve(input.sourcePath)}/.`, releaseDir]);

      // Only eve projects ever run `npx eve start`/`npx eve build`, so only eve
      // projects have an eve sandbox to inject a module into or self-check. A
      // plain Node project gets neither: injecting would vendor a backend
      // nothing imports, and verifying would run a check against a sandbox
      // that will never exist in that release.
      const isEveProject = input.commandContext.isEveProject;

      // Runs after cp -a (so it has a release to write into) and before the build
      // command (so `npx eve build` compiles the generated module). `npm ci` only
      // clears node_modules, so .eveland/ survives into the compiled output.
      const injection = isEveProject
        ? await injectSandboxModules({ releaseDir, backendDistDir: config.backendDistDir() })
        : undefined;
      const cacheDir = projectCacheDir(input.projectId);
      // The service user runs unprivileged under ProtectSystem=strict and cannot
      // create this directory itself, so build time (running as this process's
      // own, more privileged user) must create and hand it over.
      await mkdir(cacheDir, { recursive: true });

      // Hand the release and the shared npm cache to the unprivileged build user
      // before any third-party lifecycle script (npm ci/npx eve build) runs. The
      // npm cache may still be root-owned from installs that predate this change
      // (or from an earlier build that failed before its own handover), so this
      // chown cannot be conditional on prior ownership -- a recursive chown on
      // every build is the accepted correctness-first cost of not tracking cache
      // ownership state separately.
      await execa("chown", ["-R", `${config.buildUser}:`, releaseDir]);
      await execa("chown", ["-R", `${config.buildUser}:`, npmCacheDir]);

      const command = buildReleaseBuildCommand(input.commandContext);
      // HOME must point at the release dir, not root's real $HOME: the build
      // user has no read access to root's home directory, and npm consults
      // $HOME/.npmrc during install.
      const buildEnv = { npm_config_cache: npmCacheDir, HOME: releaseDir };
      const execution =
        config.buildSandbox === "bwrap"
          ? // Running bwrap as the unprivileged build user relies on the same
            // AppArmor grant the deployed agent's own sandbox already requires
            // (/etc/apparmor.d/bwrap, userns) -- see docs/deploy/linux.md for
            // the host provisioning that grants it; not re-documented here.
            await execa(
              "runuser",
              buildRunAsUserArgs(config.buildUser, ["bwrap", ...buildBwrapArgs({ releaseDir, npmCacheDir, dataDir, command })]),
              { all: true, env: buildEnv },
            )
          : await execa("runuser", buildRunAsUserArgs(config.buildUser, ["sh", "-lc", command]), {
              all: true,
              cwd: releaseDir,
              env: buildEnv,
            });

      // The unit's fixed service user needs to own the release dir: eve's default
      // local workflow world writes .workflow-data/ into the working directory.
      await execa("chown", ["-R", `${config.user}:`, releaseDir]);
      await execa("chown", ["-R", `${config.user}:`, cacheDir]);

      // Runs after both chowns: the check executes as the unprivileged service
      // user, so it needs to read the release and write the cache dir. eve build
      // never calls prewarm on a self-hosted release and /eve/v1/health returns
      // 200 regardless of sandbox health, so without this a host that cannot run
      // bwrap would deploy "successfully" and only fail on a user's first turn.
      if (isEveProject) {
        await verifySandbox({ releaseDir, user: config.user, cacheDir });
      }

      const injectionLog = injection
        ? [
            `Injected eve sandbox modules: ${injection.generated.join(", ") || "none"}`,
            ...(injection.generated.length === 0
              ? [
                  "WARNING: no agent/ directory was found at the project root, so no sandbox module could " +
                    "be injected. The deployed agent will fall back to eve's default sandbox backend chain.",
                ]
              : []),
            ...(injection.replaced.length
              ? [
                  `WARNING: replaced the project's authored sandbox (${injection.replaced.join(", ")}). ` +
                    "eveland selects the sandbox backend; the module's bootstrap(), onSession() and workspace seeds are NOT used.",
                ]
              : []),
            "Sandbox self-check passed: the vendored bwrap backend runs under this host's deployment hardening.",
          ].join("\n")
        : undefined;
      return {
        releaseRef: releaseDir,
        log: injectionLog ? `${injectionLog}\n${execution.all ?? ""}` : execution.all ?? "",
      };
    },
    async startProcess(input: ProcessStartInput): Promise<ProcessStartResult> {
      await mkdir(envDir, { recursive: true });
      const envFilePath = path.join(envDir, `${input.processName}.env`);
      await writeFile(envFilePath, buildEnvFileContent(input.env), { mode: 0o600 });

      const result = await execa(
        "systemd-run",
        buildSystemdRunArgs({
          unitName: input.processName,
          releaseDir: input.releaseRef,
          envFilePath,
          port: input.port,
          user: config.user,
          memoryMax: config.memoryMax,
          cpuQuota: config.cpuQuota,
          sandboxCacheDir: input.sandboxCacheDir,
          command: buildSystemdStartCommand(input.commandContext, input.port),
        }),
        { all: true },
      );
      return { internalPort: input.port, log: result.all ?? "" };
    },
    async stopProcess(processName: string): Promise<void> {
      const unit = `${processName}.service`;
      await runSystemctl("stop", unit);
      await runSystemctl("reset-failed", unit);
      // Secrets are decrypted onto disk for systemd's EnvironmentFile; delete them once the
      // unit is stopped instead of leaving plaintext behind indefinitely. Release-dir reaping
      // is out of scope (accepted disk hygiene debt) -- this only covers the env file.
      await rm(path.join(envDir, `${processName}.env`), { force: true });
    },
  };
}
