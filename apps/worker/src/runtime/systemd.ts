import { execa } from "execa";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { rejectedBuildVariablesLog, selectBuildVariables } from "./build-environment.js";
import { readReleaseDiscovery } from "./discovery-artifacts.js";
import { injectSandboxModules } from "./sandbox-inject.js";
import { prepareReleaseTree } from "./prepare-release.js";
import { PNPM_FROZEN_INSTALL_COMMAND } from "./package-manager.js";
import { verifySandbox } from "./sandbox-verify.js";
import {
  processSafeName,
  type PortOwnership,
  type ProcessStartInput,
  type ProcessStartResult,
  type ReleaseBuildInput,
  type ReleaseBuildResult,
  type CompleteRuntimeAdapter,
  type PortOwnershipCapability,
  type RuntimeCommandContext,
} from "./types.js";
import {
  buildWorkflowWorldInstallCommand,
  type WorkflowWorldBuildConfig,
} from "./workflow-world.js";
import {
  AGENT_OBSERVABILITY_MOUNT_DIR,
  AGENT_OBSERVABILITY_POLICY_FILE_NAME,
} from "./observability/policy.js";

export type SystemdStartInput = {
  unitName: string;
  releaseDir: string;
  envFilePath: string;
  port: number;
  user: string;
  memoryMax: string;
  cpuQuota: string;
  sandboxCacheDir: string;
  dataDir: string;
  observabilityPolicyDir: string;
  accessRepairScriptPath: string;
  dynamicUserUidMarkerPath: string;
  command: string;
};

const dynamicUserAccessRepairScriptMount = "/run/eveland/prepare-dynamic-user-access";
const dynamicUserUidMarkerMount = "/run/eveland/dynamic-user-uid";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildDynamicUserAccessRepairScript(input: {
  deploymentUser: string;
  releaseDir: string;
  sandboxCacheDir: string;
}): string {
  // systemd registers every DynamicUser= allocation under
  // /run/systemd/dynamic-uid/ before ExecStartPre= runs, with
  // `direct:<name>` a symlink whose target is the allocated uid. That registry
  // is read directly rather than via `id -u`/`getent` because those go through
  // NSS, and resolving a transient name needs nss-systemd enabled in
  // /etc/nsswitch.conf -- Amazon Linux 2023 ships `passwd: sss files`, where
  // the name resolves nowhere, not even for the process running as it. An
  // unreadable uid falls back to repairing unconditionally: the marker is only
  // an optimization that skips a recursive chmod, so losing it costs one extra
  // pass per start, while skipping the chmod would leave the new identity
  // unable to write files the previous one created outside the group umask.
  return `#!/bin/sh
set -eu
current_uid="$(readlink ${shellQuote(
    `/run/systemd/dynamic-uid/direct:${input.deploymentUser}`,
  )} 2>/dev/null || true)"
previous_uid="$(cat ${dynamicUserUidMarkerMount} 2>/dev/null || true)"
if [ -z "$current_uid" ] || [ "$current_uid" != "$previous_uid" ]; then
  chmod -R g+rwX,g-s -- ${shellQuote(input.releaseDir)} ${shellQuote(input.sandboxCacheDir)}
  printf '%s\\n' "$current_uid" > ${dynamicUserUidMarkerMount}
fi
`;
}

/**
 * Every project's sandbox cache lives at `<root>/<processSafeName(projectId)>`.
 * Exported so `createSystemdAdapter` (which knows the projectId at build time)
 * and `jobs/process-support.ts` (which must pass the identical path into
 * `startProcess` via the launch context, since `ProcessStartInput` carries no
 * projectId) can never compute two different paths for the same project.
 */
export function resolveProjectSandboxCacheDir(root: string, projectId: string): string {
  return path.resolve(root, processSafeName(projectId));
}

/**
 * Root holding every project's durable sandbox cache. `select.ts` (constructing
 * the systemd adapter) and `jobs/process-support.ts` (which must pass the
 * identical path into `startProcess` via the launch context, since
 * `ProcessStartInput` carries no projectId) both call this so the two can
 * never compute two different roots for the same env -- a typo'd env var name
 * in one of the two call sites is now a single point of failure this
 * function's own tests would catch.
 */
export function resolveSandboxCacheRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(
    env.EVELAND_SANDBOX_CACHE_DIR ?? path.join(env.EVELAND_DATA_DIR ?? ".eveland-data", "sandbox"),
  );
}

export function resolveSystemdDeploymentUser(unitName: string): string {
  const digest = createHash("sha256").update(unitName).digest("hex").slice(0, 20);
  return `eveland-d-${digest}`;
}

export function buildSystemdRunArgs(input: SystemdStartInput): string[] {
  return [
    "--unit",
    input.unitName,
    "--collect",
    "--service-type=exec",
    "--property=Restart=on-failure",
    "--property=RestartSec=2",
    // A unit that cannot come up (a lost port bind, a crashed release) must
    // give up instead of flapping in auto-restart indefinitely.
    "--property=StartLimitIntervalSec=60",
    "--property=StartLimitBurst=5",
    `--property=User=${resolveSystemdDeploymentUser(input.unitName)}`,
    "--property=DynamicUser=yes",
    `--property=Group=${input.user}`,
    "--property=UMask=0002",
    `--property=WorkingDirectory=${input.releaseDir}`,
    `--property=EnvironmentFile=${input.envFilePath}`,
    `--property=Environment=PORT=${input.port}`,
    `--property=Environment=HOME=${input.releaseDir}`,
    `--property=Environment=EVELAND_SANDBOX_CACHE_DIR=${input.sandboxCacheDir}`,
    `--property=Environment=EVELAND_SANDBOX_TEMPLATE_REVISION=${input.releaseDir}`,
    `--property=MemoryMax=${input.memoryMax}`,
    `--property=CPUQuota=${input.cpuQuota}`,
    "--property=ProtectSystem=strict",
    `--property=ReadWritePaths=${input.releaseDir}`,
    // systemd list-type settings (ReadWritePaths= included) append across repeated
    // assignments rather than overwriting -- confirmed live via `systemd-run
    // --property=ReadWritePaths=/tmp --property=ReadWritePaths=/var/tmp` followed by
    // `systemctl show -p ReadWritePaths`, which reported "ReadWritePaths=/tmp /var/tmp".
    `--property=ReadWritePaths=${input.sandboxCacheDir}`,
    `--property=ReadWritePaths=${dynamicUserUidMarkerMount}`,
    // Each unit gets a distinct dynamic UID. The data-root mask then limits the
    // paths visible to that identity to this Deployment's own release, cache,
    // environment file, and observability policy.
    `--property=TemporaryFileSystem=${input.dataDir}:ro`,
    `--property=BindPaths=${input.releaseDir}`,
    `--property=BindPaths=${input.sandboxCacheDir}`,
    `--property=BindPaths=${input.dynamicUserUidMarkerPath}:${dynamicUserUidMarkerMount}`,
    // EnvironmentFile= also lives under the masked data root. Whether systemd
    // resolves it before or inside the unit's namespace varies with the other
    // namespacing options in play, and losing it would strip every project
    // secret from the Deployment, so reopen it explicitly. It stays root-owned
    // 0600 (see startProcess), unreadable by the unprivileged unit user.
    `--property=BindReadOnlyPaths=${input.envFilePath}`,
    `--property=BindReadOnlyPaths=${input.accessRepairScriptPath}:${dynamicUserAccessRepairScriptMount}`,
    `--property=BindReadOnlyPaths=${input.observabilityPolicyDir}:${AGENT_OBSERVABILITY_MOUNT_DIR}`,
    "--property=ProtectProc=invisible",
    "--property=PrivateTmp=yes",
    "--property=NoNewPrivileges=yes",
    `--property=ExecStartPre=+/bin/sh ${dynamicUserAccessRepairScriptMount}`,
    "sh",
    "-lc",
    input.command,
  ];
}

export function buildSystemdStartCommand(_context: RuntimeCommandContext, port: number): string {
  // Host process: loopback binding is enough, and Ollama on localhost needs no bridge.
  return `npx eve start --host 127.0.0.1 --port ${port}`;
}

export function buildReleaseBuildCommand(
  context: RuntimeCommandContext,
  workflowWorld?: WorkflowWorldBuildConfig,
): string {
  const install =
    context.packageManager === "pnpm"
      ? PNPM_FROZEN_INSTALL_COMMAND
      : context.hasLockfile
        ? "npm ci"
        : "npm install";
  const worldInstall = workflowWorld
    ? ` && ${buildWorkflowWorldInstallCommand(workflowWorld, context.packageManager ?? "npm")}`
    : "";
  // `eve build` writes `.eve/agent-summary.json`, but the full discovery
  // manifest (including hooks and remote subagents) is materialized by
  // `eve info`. Run both inside the same secret-free build sandbox so the
  // Release summary is derived from the exact dependency tree we deploy.
  return `${install}${worldInstall} && npx eve build && npx eve info --json >/dev/null`;
}

/**
 * The complete environment `runuser` hands the build, and nothing else.
 *
 * execa extends `process.env` by default, so the caller pairs this with
 * `extendEnv: false`: that pairing is what keeps `APP_SECRET_KEY`,
 * `DATABASE_URL`, `WORKFLOW_POSTGRES_URL` and every other worker secret out of
 * a build whose lifecycle scripts can read `/proc/self/environ`. `PATH` and
 * `npm_config_cache` both survive runuser's user switch unmodified, so they
 * can ride here; see ./build-environment.ts for the variables.
 *
 * HOME cannot: util-linux `runuser` (without `-m`/`--preserve-environment`)
 * resets HOME, SHELL, USER and LOGNAME to the target user's passwd entry as
 * part of the switch, so a HOME set here is silently discarded. It has to be
 * injected after the switch -- `buildBwrapArgs`' `--setenv HOME` in bwrap
 * mode, an `env HOME=...` wrapper in none mode -- and must point at releaseDir,
 * the only writable path in bwrap mode that npm and lifecycle scripts can use.
 */
export function buildReleaseBuildEnvironment(input: {
  npmCacheDir: string;
  pathValue: string;
  variables: Readonly<Record<string, string>> | undefined;
}): { environment: Record<string, string>; rejectedKeys: string[] } {
  const selected = selectBuildVariables(input.variables);
  return {
    environment: {
      ...selected.variables,
      PATH: input.pathValue,
      npm_config_cache: input.npmCacheDir,
    },
    rejectedKeys: selected.rejectedKeys,
  };
}

export type BwrapBuildInput = {
  releaseDir: string;
  npmCacheDir: string;
  dataDir: string;
  command: string;
};

export function buildBwrapArgs(input: BwrapBuildInput): string[] {
  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
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
    "--tmpfs",
    input.dataDir,
    "--bind",
    input.releaseDir,
    input.releaseDir,
    "--bind",
    input.npmCacheDir,
    input.npmCacheDir,
    "--unshare-pid",
    "--die-with-parent",
    "--chdir",
    input.releaseDir,
    // util-linux `runuser` (without -m/--preserve-environment) resets HOME to
    // the build user's passwd entry once it switches users, so an execa-env
    // HOME never survives into this sandbox -- it must be (re)injected here,
    // after the switch. See the comment beside `buildEnv` in buildRelease for
    // why HOME must point at releaseDir at all.
    "--setenv",
    "HOME",
    input.releaseDir,
    "sh",
    "-lc",
    input.command,
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
        throw new Error(
          `Secret ${key} contains a newline; systemd EnvironmentFile cannot represent it.`,
        );
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

/**
 * Extracts the pids of every process holding a listening socket from
 * `ss -H -t -l -n -p` output lines, e.g.
 * `LISTEN 0 511 127.0.0.1:41032 0.0.0.0:* users:(("node",pid=1234,fd=20))`.
 */
export function parseSsListenerPids(output: string): number[] {
  const pids = new Set<number>();
  for (const match of output.matchAll(/pid=(\d+)/g)) {
    pids.add(Number(match[1]));
  }
  return [...pids];
}

async function runSystemctl(subcommand: string, unit: string): Promise<void> {
  const result = await execa("systemctl", [subcommand, unit], { reject: false });
  const outcome: SystemctlCommandOutcome = {
    failed: result.failed,
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
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

export function createSystemdAdapter(
  config: SystemdAdapterConfig,
): CompleteRuntimeAdapter & PortOwnershipCapability {
  const dataDir = path.resolve(config.dataDir);
  const npmCacheDir = path.resolve(dataDir, "npm-cache");
  const envDir = path.resolve(dataDir, "deployment-env");
  const projectCacheDir = (projectId: string) =>
    resolveProjectSandboxCacheDir(config.sandboxCacheDir, projectId);

  const adapter: CompleteRuntimeAdapter & PortOwnershipCapability = {
    name: "systemd",
    async buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult> {
      const releaseDir = path.resolve(input.buildDir);
      await mkdir(npmCacheDir, { recursive: true });
      const observerInjection = await prepareReleaseTree({
        sourcePath: input.sourcePath,
        buildDir: releaseDir,
        workflowWorld: input.workflowWorld,
      });

      // Runs after cp -a (so it has a release to write into) and before the build
      // command (so `npx eve build` compiles the generated module). `npm ci` only
      // clears node_modules, so .eveland/ survives into the compiled output.
      const injection = await injectSandboxModules({
        releaseDir,
        backendDistDir: config.backendDistDir(),
      });
      const cacheDir = projectCacheDir(input.projectId);
      // The dynamic runtime user runs under ProtectSystem=strict and cannot
      // create this directory itself, so the worker creates it before start.
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
      const { environment: buildEnv, rejectedKeys } = buildReleaseBuildEnvironment({
        npmCacheDir,
        pathValue:
          process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        variables: input.buildVariables,
      });
      // cancelSignal kills the untrusted build if this job's lease is fenced
      // away mid-build -- a second execution of the same job is already
      // building, and letting both finish races their host side effects.
      const cancelOptions = input.signal ? { cancelSignal: input.signal } : {};
      const execution =
        config.buildSandbox === "bwrap"
          ? // Running bwrap as the unprivileged build user relies on the same
            // AppArmor grant the deployed agent's own sandbox already requires
            // (/etc/apparmor.d/bwrap, userns) -- see docs/deploy/linux.md for
            // the host provisioning that grants it; not re-documented here.
            await execa(
              "runuser",
              buildRunAsUserArgs(config.buildUser, [
                "bwrap",
                ...buildBwrapArgs({ releaseDir, npmCacheDir, dataDir, command }),
              ]),
              { all: true, env: buildEnv, extendEnv: false, ...cancelOptions },
            )
          : await execa(
              "runuser",
              buildRunAsUserArgs(config.buildUser, [
                "env",
                `HOME=${releaseDir}`,
                "sh",
                "-lc",
                command,
              ]),
              {
                all: true,
                cwd: releaseDir,
                env: buildEnv,
                extendEnv: false,
                ...cancelOptions,
              },
            );

      // The artifact-access group needs write access to the release: eve's
      // default local workflow world writes .eve/.workflow-data/ (pre-0.24.4:
      // .workflow-data/) into the working directory, and each dynamic runtime
      // user receives this group only inside its own masked mount namespace.
      await execa("chown", ["-R", `${config.user}:`, releaseDir]);
      await execa("chown", ["-R", `${config.user}:`, cacheDir]);

      // Runs after both chowns: the check executes as the unprivileged service
      // user, so it needs to read the release and write the cache dir. eve build
      // never calls prewarm on a self-hosted release and /eve/v1/health returns
      // 200 regardless of sandbox health, so without this a host that cannot run
      // bwrap would deploy "successfully" and only fail on a user's first turn.
      await verifySandbox({ releaseDir, user: config.user, cacheDir });
      await execa("chmod", ["-R", "g+rwX,g-s", releaseDir]);
      await execa("chmod", ["-R", "g+rwX,g-s", cacheDir]);

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
      const discovery = await readReleaseDiscovery(releaseDir);
      return {
        releaseRef: releaseDir,
        schedulerDefinitions: observerInjection.scheduler?.definitions,
        ...(discovery ? { discovery } : {}),
        log: [
          `Injected Eveland observer hooks: ${observerInjection.injectedFiles.join(", ") || "none"}`,
          observerInjection.workflowWorld
            ? `Injected platform workflow world: ${input.workflowWorld?.packageName} (${observerInjection.workflowWorld.agentConfigPath})`
            : undefined,
          rejectedBuildVariablesLog(rejectedKeys),
          injectionLog,
          execution.all ?? "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
    async startProcess(input: ProcessStartInput): Promise<ProcessStartResult> {
      await mkdir(envDir, { recursive: true });
      const envFilePath = path.join(envDir, `${input.processName}.env`);
      const accessRepairScriptPath = path.join(envDir, `${input.processName}.prepare-access.sh`);
      const dynamicUserUidMarkerPath = path.join(input.observabilityPolicyDir, ".dynamic-user-uid");
      const deploymentEnv = { ...input.env };
      delete deploymentEnv.EVELAND_SANDBOX_TEMPLATE_REVISION;
      await writeFile(envFilePath, buildEnvFileContent(deploymentEnv), { mode: 0o600 });

      await execa("chown", ["-R", `root:${config.user}`, input.observabilityPolicyDir]);
      await execa("chmod", ["2750", input.observabilityPolicyDir]);
      await execa("chmod", [
        "0640",
        path.join(input.observabilityPolicyDir, AGENT_OBSERVABILITY_POLICY_FILE_NAME),
      ]);
      await writeFile(dynamicUserUidMarkerPath, "", {
        flag: "a",
        mode: 0o600,
      });
      await writeFile(
        accessRepairScriptPath,
        buildDynamicUserAccessRepairScript({
          deploymentUser: resolveSystemdDeploymentUser(input.processName),
          releaseDir: input.releaseRef,
          sandboxCacheDir: input.sandboxCacheDir,
        }),
        { mode: 0o700 },
      );

      let result;
      try {
        result = await execa(
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
            dataDir,
            observabilityPolicyDir: input.observabilityPolicyDir,
            accessRepairScriptPath,
            dynamicUserUidMarkerPath,
            command: buildSystemdStartCommand(input.commandContext, input.port),
          }),
          { all: true },
        );
      } catch (error) {
        // No unit was created, so no later stopProcess will ever delete the
        // decrypted EnvironmentFile written above -- remove it here or the
        // plaintext secrets persist indefinitely.
        await rm(envFilePath, { force: true }).catch(() => undefined);
        await rm(accessRepairScriptPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return { internalPort: input.port, log: result.all ?? "" };
    },
    async inspectProcess(processName) {
      const unit = `${processName}.service`;
      const result = await execa("systemctl", ["show", unit, "--property=ActiveState", "--value"], {
        all: true,
        reject: false,
      });
      if (result.failed) {
        if (/not-found|not be found|could not be found|does not exist/i.test(result.all ?? ""))
          return "missing";
        throw new Error(`systemctl show ${unit} failed: ${result.all || "no output captured"}`);
      }
      const status = (result.stdout ?? "").trim();
      if (status === "active") return "ready";
      if (status === "activating" || status === "reloading") return "starting";
      if (status === "inactive" || status === "deactivating") return "stopped";
      return "failed";
    },
    async getProcessDiagnostics(processName) {
      const unit = `${processName}.service`;
      const [state, logs] = await Promise.all([
        execa(
          "systemctl",
          [
            "show",
            unit,
            "--property=ActiveState,SubState,NRestarts,ExecMainCode,ExecMainStatus,Result",
            "--no-pager",
          ],
          { all: true, reject: false },
        ),
        execa(
          "journalctl",
          ["--unit", unit, "--lines", "200", "--no-pager", "--output=short-iso"],
          {
            all: true,
            reject: false,
          },
        ),
      ]);
      return {
        state: diagnosticCommandOutput(state, "systemctl show"),
        logs: diagnosticCommandOutput(logs, "journalctl"),
      };
    },
    async verifyPortOwnership({ processName, port }): Promise<PortOwnership> {
      const unit = `${processName}.service`;
      const listeners = await execa(
        "ss",
        ["-H", "-t", "-l", "-n", "-p", "sport", "=", `:${port}`],
        { all: true, reject: false },
      );
      if (listeners.failed) {
        // Silently passing here would reintroduce blind trust in whatever
        // answers on the port, so an unusable ss fails the activation loudly.
        throw new Error(
          `ss listener lookup for port ${port} failed: ${listeners.all || "no output captured"}`,
        );
      }
      const pids = parseSsListenerPids(listeners.stdout ?? "");
      if (pids.length === 0) return { status: "unbound" };
      const holders: string[] = [];
      for (const pid of pids) {
        const owner = await execa("ps", ["-o", "unit=", "-p", String(pid)], {
          all: true,
          reject: false,
        });
        const owningUnit = owner.failed ? "" : (owner.stdout ?? "").trim();
        if (owningUnit === unit) return { status: "owned" };
        holders.push(`pid ${pid}${owningUnit ? ` (unit ${owningUnit})` : ""}`);
      }
      return { status: "foreign", holder: holders.join(", ") };
    },
    async ensureProcess(input) {
      const status = await adapter.inspectProcess(input.processName);
      if (status === "ready" || status === "starting") {
        const ownership = await adapter.verifyPortOwnership({
          processName: input.processName,
          port: input.port,
        });
        if (
          ownership.status === "owned" ||
          (ownership.status === "unbound" && status === "starting")
        ) {
          // An activating unit that has not bound yet is a legitimate reuse;
          // the readiness gate keeps polling ownership afterwards.
          return {
            internalPort: input.port,
            log: `Reused ${status} systemd process ${input.processName}.`,
          };
        }
        if (ownership.status === "foreign") {
          // The unit is alive but can never become the listener while another
          // process holds its port; left running it would flap in auto-restart
          // and its traffic would be served by the foreign holder.
          await adapter.stopProcess(input.processName);
          throw new Error(
            `systemd process ${input.processName} cannot bind port ${input.port}: ` +
              `the listening socket is held by ${ownership.holder}. Stopped the unit instead of ` +
              "reusing it against another process's socket.",
          );
        }
        // Active but not listening on the requested port: a long-running
        // process never rebinds, so reuse would time out. Restart it onto the
        // requested port.
        await adapter.stopProcess(input.processName);
        return adapter.startProcess(input);
      }
      if (status !== "missing") await adapter.stopProcess(input.processName);
      return adapter.startProcess(input);
    },
    async listProcesses(namePrefix) {
      const result = await execa(
        "systemctl",
        // "activating" included deliberately: a unit flapping in
        // auto-restart (e.g. a lost port bind) never reaches "active", and
        // excluding it hid exactly those zombies from the orphan sweep.
        [
          "list-units",
          "--type=service",
          "--state=active,activating",
          "--plain",
          "--no-legend",
          "--no-pager",
          `${namePrefix}*.service`,
        ],
        { all: true, reject: false },
      );
      if (result.failed) {
        throw new Error(`systemctl list-units failed: ${result.all || "no output captured"}`);
      }
      return (result.stdout ?? "")
        .split("\n")
        .map((line) => line.trim().split(/\s+/, 1)[0] ?? "")
        .filter((unit) => unit.startsWith(namePrefix) && unit.endsWith(".service"))
        .map((unit) => unit.slice(0, -".service".length));
    },
    async stopProcess(processName: string): Promise<void> {
      const unit = `${processName}.service`;
      await runSystemctl("stop", unit);
      await runSystemctl("reset-failed", unit);
      // Secrets are decrypted onto disk for systemd's EnvironmentFile; delete
      // them once the unit is stopped instead of leaving plaintext behind.
      // Release directories are removed separately when retention archives the
      // stopped Deployment.
      await rm(path.join(envDir, `${processName}.env`), { force: true });
      await rm(path.join(envDir, `${processName}.prepare-access.sh`), { force: true });
    },
    async removeRelease(releaseRef: string): Promise<void> {
      await rm(path.resolve(releaseRef), { recursive: true, force: true });
    },
  };
  return adapter;
}

function diagnosticCommandOutput(
  result: { failed?: boolean; all?: string; stdout?: string; stderr?: string },
  command: string,
): string {
  const output = (result.all || result.stdout || result.stderr || "").trim();
  if (result.failed) return output ? `${command} unavailable: ${output}` : `${command} unavailable`;
  return output;
}
