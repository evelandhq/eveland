import { execa } from "execa";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferEveRuntimeCommand } from "@eveland/core/server/runtime-command";
import { injectSandboxModules } from "./sandbox-inject.js";
import { prepareReleaseTree } from "./prepare-release.js";
import { verifyObserverOutbox } from "./observer-verify.js";
import { verifySandbox } from "./sandbox-verify.js";
import { processSafeName, type ProcessStartInput, type ProcessStartResult, type ReleaseBuildInput, type ReleaseBuildResult, type RuntimeAdapter, type RuntimeCommandContext } from "./types.js";
import { buildWorkflowWorldInstallCommand, type WorkflowWorldBuildConfig } from "./workflow-world.js";

export type SystemdStartInput = {
  unitName: string;
  releaseDir: string;
  envFilePath: string;
  port: number;
  user: string;
  memoryMax: string;
  cpuQuota: string;
  sandboxCacheDir: string;
  observerOutboxDir: string;
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
    `--property=Environment=EVELAND_SANDBOX_TEMPLATE_REVISION=${input.releaseDir}`,
    `--property=Environment=EVELAND_OBSERVER_OUTBOX_DIR=${input.observerOutboxDir}`,
    `--property=MemoryMax=${input.memoryMax}`,
    `--property=CPUQuota=${input.cpuQuota}`,
    "--property=ProtectSystem=strict",
    `--property=ReadWritePaths=${input.releaseDir}`,
    // systemd list-type settings (ReadWritePaths= included) append across repeated
    // assignments rather than overwriting -- confirmed live via `systemd-run
    // --property=ReadWritePaths=/tmp --property=ReadWritePaths=/var/tmp` followed by
    // `systemctl show -p ReadWritePaths`, which reported "ReadWritePaths=/tmp /var/tmp".
    `--property=ReadWritePaths=${input.sandboxCacheDir}`,
    `--property=ReadWritePaths=${input.observerOutboxDir}`,
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

export function buildReleaseBuildCommand(
  context: RuntimeCommandContext,
  workflowWorld?: WorkflowWorldBuildConfig,
): string {
  const install = context.hasLockfile ? "npm ci" : "npm install";
  if (!context.isEveProject) return install;
  const worldInstall = workflowWorld ? ` && ${buildWorkflowWorldInstallCommand(workflowWorld)}` : "";
  return `${install}${worldInstall} && npx eve build`;
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
    // and the shared npm cache. The build runs as the unprivileged build user,
    // not root, so the root-owned 0600 deployment-env secret files are already
    // unreadable through the `--ro-bind / /` above regardless of this mask --
    // this tmpfs is defense-in-depth, hiding the paths the build user COULD
    // otherwise read through that read-only bind: other projects' imported
    // sources and build output. bwrap applies mounts in argument order and
    // creates bind destinations inside its own tmpfs, so the two --bind
    // entries below only re-open the subtrees they name.
    "--tmpfs", input.dataDir,
    "--bind", input.releaseDir, input.releaseDir,
    "--bind", input.npmCacheDir, input.npmCacheDir,
    "--unshare-pid",
    "--die-with-parent",
    "--chdir", input.releaseDir,
    // util-linux `runuser` (without -m/--preserve-environment) resets HOME to
    // the build user's passwd entry once it switches users, so an execa-env
    // HOME never survives into this sandbox -- it must be (re)injected here,
    // after the switch. See the comment beside `buildEnv` in buildRelease for
    // why HOME must point at releaseDir at all.
    "--setenv", "HOME", input.releaseDir,
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

  const adapter: RuntimeAdapter = {
    name: "systemd",
    async buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult> {
      const releaseDir = path.resolve(input.buildDir);
      await mkdir(npmCacheDir, { recursive: true });
      const observerInjection = await prepareReleaseTree({
        sourcePath: input.sourcePath,
        buildDir: releaseDir,
        workflowWorld: input.workflowWorld,
        scheduler: input.commandContext.isEveProject,
      });

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

      const command = buildReleaseBuildCommand(input.commandContext, input.workflowWorld);
      // The build env execa passes must contain nothing secret: npm/eve
      // lifecycle scripts run untrusted, from the imported project's own
      // dependency tree, and can read this process's env via
      // /proc/self/environ regardless of the unprivileged build user --
      // execa extends process.env by default, so extendEnv: false plus this
      // explicit allowlist is what actually keeps APP_SECRET_KEY,
      // DATABASE_URL, WORKFLOW_POSTGRES_URL etc. out of the build. PATH and
      // npm_config_cache both survive runuser's user switch unmodified, so
      // they can ride here.
      //
      // HOME is deliberately NOT included here. It still must end up set to
      // releaseDir rather than the build user's real passwd-entry home: the
      // build user cannot use root's HOME (no read access to it), npm
      // consults $HOME/.npmrc during install, and lifecycle scripts commonly
      // write caches under $HOME -- and even the build user's own real home
      // is useless in bwrap mode, since only releaseDir and the npm cache are
      // bound read-write there, so a lifecycle script writing e.g. ~/.cache
      // under any other HOME would hit the read-only rootfs. But util-linux
      // `runuser` (without -m/--preserve-environment) always resets HOME (and
      // SHELL/USER/LOGNAME) to the target user's passwd entry once it
      // switches users, so an execa-env HOME here would be silently discarded
      // -- it must instead be injected AFTER the switch: bwrap's own
      // `--setenv HOME` (see buildBwrapArgs) in bwrap mode, or an
      // `env HOME=...` wrapper in none mode, below.
      const buildEnv = {
        PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        npm_config_cache: npmCacheDir,
      };
      const execution =
        config.buildSandbox === "bwrap"
          ? // Running bwrap as the unprivileged build user relies on the same
            // AppArmor grant the deployed agent's own sandbox already requires
            // (/etc/apparmor.d/bwrap, userns) -- see docs/deploy/linux.md for
            // the host provisioning that grants it; not re-documented here.
            await execa(
              "runuser",
              buildRunAsUserArgs(config.buildUser, ["bwrap", ...buildBwrapArgs({ releaseDir, npmCacheDir, dataDir, command })]),
              { all: true, env: buildEnv, extendEnv: false },
            )
          : await execa(
              "runuser",
              buildRunAsUserArgs(config.buildUser, ["env", `HOME=${releaseDir}`, "sh", "-lc", command]),
              {
                all: true,
                cwd: releaseDir,
                env: buildEnv,
                extendEnv: false,
              },
            );

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
                    "eveland selects the sandbox backend; the authored module's bootstrap() and onSession() " +
                    "are not used, while workspace seeds are preserved.",
                ]
              : []),
            "Sandbox self-check passed: the vendored bwrap backend runs under this host's deployment hardening.",
          ].join("\n")
        : undefined;
      return {
        releaseRef: releaseDir,
        schedulerDefinitions: observerInjection.scheduler?.definitions,
        log: [
          `Injected Eveland observer hooks: ${observerInjection.injectedFiles.join(", ") || "none"}`,
          observerInjection.workflowWorld
            ? `Injected platform workflow world: ${input.workflowWorld?.packageName} (${observerInjection.workflowWorld.agentConfigPath})`
            : undefined,
          injectionLog,
          execution.all ?? "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
    async startProcess(input: ProcessStartInput): Promise<ProcessStartResult> {
      await mkdir(envDir, { recursive: true });
      await mkdir(input.observerOutboxDir, { recursive: true });
      await execa("chown", ["-R", `${config.user}:`, input.observerOutboxDir]);
      await verifyObserverOutbox({ user: config.user, outboxDir: input.observerOutboxDir });
      const envFilePath = path.join(envDir, `${input.processName}.env`);
      const deploymentEnv = { ...input.env };
      delete deploymentEnv.EVELAND_SANDBOX_TEMPLATE_REVISION;
      await writeFile(envFilePath, buildEnvFileContent(deploymentEnv), { mode: 0o600 });

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
          observerOutboxDir: input.observerOutboxDir,
          command: buildSystemdStartCommand(input.commandContext, input.port),
        }),
        { all: true },
      );
      return { internalPort: input.port, log: result.all ?? "" };
    },
    async inspectProcess(processName) {
      const unit = `${processName}.service`;
      const result = await execa("systemctl", ["show", unit, "--property=ActiveState", "--value"], {
        all: true,
        reject: false,
      });
      if (result.failed) {
        if (/not-found|not be found|could not be found|does not exist/i.test(result.all ?? "")) return "missing";
        throw new Error(`systemctl show ${unit} failed: ${result.all || "no output captured"}`);
      }
      const status = (result.stdout ?? "").trim();
      if (status === "active") return "ready";
      if (status === "activating" || status === "reloading") return "starting";
      if (status === "inactive" || status === "deactivating") return "stopped";
      return "failed";
    },
    async ensureProcess(input) {
      const status = await adapter.inspectProcess!(input.processName);
      if (status === "ready" || status === "starting") {
        return { internalPort: input.port, log: `Reused ${status} systemd process ${input.processName}.` };
      }
      if (status !== "missing") await adapter.stopProcess(input.processName);
      return adapter.startProcess(input);
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
    async removeRelease(releaseRef: string): Promise<void> {
      await rm(path.resolve(releaseRef), { recursive: true, force: true });
    },
  };
  return adapter;
}
