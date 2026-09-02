import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { defaultStreamCommand, pinReleaseIdentity } from "./bootstrap.ts";
import { breakingChangesBetween } from "./changelog.ts";
import { loadPlatformEnvFile } from "./env-file.ts";
import { readInstallMetadata } from "./home.ts";
import type { LifecycleIo } from "./io.ts";
import { resolveLifecycle, runStart, runStop, systemdModeContext } from "./lifecycle.ts";
import {
  acquireMutex,
  MutexBusyError,
  pendingUpdatePath,
  readPendingUpdate,
  updateMutexPath,
  writePendingUpdate,
  type PendingUpdate,
} from "./state-files.ts";
import { createPrompter, nonInteractivePrompter } from "./prompt.ts";
import { installSystemdArtifacts } from "./systemd-mode.ts";

/**
 * `eveland-ctl update`: move the appliance's source checkout FORWARD to a
 * newer release tag, in two phases:
 *
 *   phase 1 (this, the OLD code): acknowledge breaking changes, pg_dump,
 *     stop the whole platform, stash a dirty tree, checkout, pnpm install;
 *   phase 2 (`_finish-update`, run from the NEW checkout so the new ctl
 *     owns its own artifacts): refresh release identity, regenerate the
 *     systemd form's units/env allowlists/overlay, build, migrate, start.
 *
 * Only forward moves are allowed: migrations are not reversed
 * automatically, so a rollback follows the release's rollback notes
 * (docs/operations/upgrades) — never a casual `--version <older>`.
 */

export type PgDump = (
  backupPath: string,
  options: { cwd: string; envFilePath: string },
) => Promise<number | null>;

/**
 * pg_dump through Compose into a `.partial` file that is fsync'd and only
 * then renamed to the final name: a backup either exists complete or not
 * at all. A failed dump, a write error (disk full), or an empty result
 * leaves no file behind and reports failure; the file is 0600.
 */
export function defaultPgDump(options: { argv?: string[] } = {}): PgDump {
  return async (backupPath, { cwd, envFilePath }) => {
    const argv = options.argv ?? [
      "docker",
      // --env-file: compose interpolates the whole file even for one exec.
      "compose",
      "--env-file",
      envFilePath,
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "eveland",
      "-d",
      "eveland",
    ];
    const partialPath = `${backupPath}.partial`;
    await rm(partialPath, { force: true });
    const result = await new Promise<{ code: number | null; writeError: Error | null }>(
      (resolve) => {
        const [command, ...rest] = argv;
        const child = spawn(command!, rest, { cwd, stdio: ["ignore", "pipe", "inherit"] });
        const out = createWriteStream(partialPath, { mode: 0o600, flags: "wx" });
        let writeError: Error | null = null;
        let code: number | null | undefined;
        let finished = false;
        const done = () => {
          if (code !== undefined && finished) resolve({ code, writeError });
        };
        out.on("error", (error) => {
          writeError = error;
          finished = true;
          child.kill("SIGTERM");
          done();
        });
        out.on("finish", () => {
          finished = true;
          done();
        });
        child.on("error", (error) => {
          writeError = writeError ?? error;
          code = null;
          out.end();
          done();
        });
        child.stdout!.pipe(out);
        child.on("close", (exitCode) => {
          code = exitCode;
          done();
        });
      },
    );
    if (result.code !== 0 || result.writeError) {
      await rm(partialPath, { force: true });
      return result.code === 0 ? null : result.code;
    }
    // Durable before it is named as a backup: fsync the data, then rename.
    try {
      const handle = await open(partialPath, "r+");
      try {
        const { size } = await handle.stat();
        if (size === 0) throw new Error("pg_dump produced no output");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(partialPath, backupPath);
    } catch {
      await rm(partialPath, { force: true });
      return null;
    }
    return 0;
  };
}

function templateEvePin(packageJsonRaw: string | null): string | null {
  if (!packageJsonRaw) return null;
  try {
    const parsed = JSON.parse(packageJsonRaw) as { dependencies?: Record<string, string> };
    return parsed.dependencies?.eve ?? null;
  } catch {
    return null;
  }
}

/** `vX.Y.Z` → [X, Y, Z]; anything else (a SHA, a branch, a pre-release) → null. */
export function parseReleaseTag(tag: string): [number, number, number] | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isForwardMove(currentVersion: string, targetTag: string): boolean {
  const current = parseReleaseTag(`v${currentVersion}`);
  const target = parseReleaseTag(targetTag);
  if (!current || !target) return false;
  for (let i = 0; i < 3; i += 1) {
    if (target[i]! !== current[i]!) return target[i]! > current[i]!;
  }
  return false;
}

/**
 * The failure text every post-stop step prints. It never claims a source
 * rollback is safe: migrations are not reversed automatically, so the
 * release's rollback notes decide, and the database backup is the floor.
 */
export function recoveryPlan(options: {
  failedStep: string;
  fromVersion: string;
  backupPath: string | null;
  repo: string;
}): string {
  const { failedStep, fromVersion, backupPath, repo } = options;
  return [
    `${failedStep} — the platform is left STOPPED so a half-updated tree cannot run.`,
    "To retry:     fix the cause and re-run `eveland-ctl update`.",
    "To roll back: migrations already applied are NOT reversed automatically. Follow the",
    '              release\'s rollback notes (docs/operations/upgrades, "Rollback boundary").',
    `              Only if those notes say v${fromVersion} is compatible with the applied migrations:`,
    `                git -C ${repo} checkout v${fromVersion} && (cd ${repo} && SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install --frozen-lockfile) && eveland-ctl start`,
    backupPath
      ? `              Otherwise restore the database from ${backupPath} first.`
      : "              Otherwise restore the database from your own backup first (this run skipped pg_dump).",
  ].join("\n");
}

export {
  pendingUpdatePath,
  readPendingUpdate,
  type PendingUpdate,
  updateMutexPath,
} from "./state-files.ts";

/** The newest exact vX.Y.Z tag: a pre-release sorts above the stable it precedes and is never a default target. */
export function newestStableTag(tagListOutput: string): string | undefined {
  return tagListOutput
    .split("\n")
    .map((line) => line.trim())
    .find((tag) => parseReleaseTag(tag) !== null);
}

type UpdateContext = {
  io: LifecycleIo;
  repo: string;
  layout: { runDir: string };
  git: (gitArgs: string[]) => Promise<{ code: number | null; output: string }>;
  streamCommand: NonNullable<LifecycleIo["streamCommand"]>;
  prompter: { confirm: (question: string, defaultValue: boolean) => Promise<boolean> };
};

export async function runUpdate(
  args: string[],
  io: LifecycleIo & { pgDump?: PgDump },
): Promise<number> {
  // Two concurrent updates (or an update racing a resume) would both stop,
  // stash, checkout and hand over; the whole state machine is serialized.
  const resolved = resolveLifecycle(io);
  await mkdir(resolved.layout.runDir, { recursive: true });
  let lock: Awaited<ReturnType<typeof acquireMutex>>;
  try {
    lock = await acquireMutex(
      updateMutexPath(resolved.layout),
      process.pid,
      resolved.processIdentity,
      { onLiveHolder: "fail", sleep: resolved.sleep },
    );
  } catch (error) {
    if (error instanceof MutexBusyError) {
      io.stderr(
        `Another eveland-ctl update is running (pid ${error.holderPid}); wait for it to finish.`,
      );
      return 1;
    }
    throw error;
  }
  try {
    return await runUpdateLocked(args, io, resolved);
  } finally {
    await lock.release();
  }
}

async function runUpdateLocked(
  args: string[],
  io: LifecycleIo & { pgDump?: PgDump },
  resolved: ReturnType<typeof resolveLifecycle>,
): Promise<number> {
  const parsed = parseArgs({
    args,
    options: {
      version: { type: "string" },
      yes: { type: "boolean" },
      "no-prompt": { type: "boolean" },
      "skip-backup": { type: "boolean" },
    },
    allowPositionals: false,
  });
  const metadata = await readInstallMetadata(resolved.layout);
  if (!metadata) {
    io.stderr(
      "update manages an installed appliance (etc/install.json). " +
        "This looks like a development checkout — use git pull instead.",
    );
    return 1;
  }
  const repo = resolved.repoRootDir;
  const git = (gitArgs: string[]) => resolved.execCommand(["git", ...gitArgs], { cwd: repo });
  const streamCommand = io.streamCommand ?? defaultStreamCommand(io.stdout);
  const prompter = parsed.values["no-prompt"]
    ? nonInteractivePrompter()
    : (io.prompter ?? createPrompter());
  const context: UpdateContext = {
    io,
    repo,
    layout: resolved.layout,
    git,
    streamCommand,
    prompter,
  };

  // An interrupted update comes first: the checkout may already report the
  // target version while the platform sits stopped from phase 1.
  const pending = await readPendingUpdate(resolved.layout);
  if (pending) {
    io.stdout(
      `Resuming the interrupted update v${pending.from} -> ${pending.target} ` +
        `(started ${pending.startedAt}; backup ${pending.backupPath ?? "skipped"}).`,
    );
    // Whatever is still up must be down before the tree moves again.
    const stopCode = await runStop([], io);
    if (stopCode !== 0) return stopCode;
    return completeUpdate(context, pending);
  }

  const fetch = await git(["fetch", "--tags", "--quiet"]);
  if (fetch.code !== 0) {
    io.stderr(`git fetch failed:\n${fetch.output.trim()}`);
    return 1;
  }

  const currentVersion = (
    JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as { version: string }
  ).version;
  let target = parsed.values.version;
  if (!target) {
    const tags = await git(["tag", "--list", "v*", "--sort=-v:refname"]);
    target = newestStableTag(tags.output);
  }
  if (!target) {
    io.stderr("No release tag found to update to.");
    return 1;
  }
  if (target === `v${currentVersion}`) {
    io.stdout(`Already up to date (v${currentVersion}).`);
    return 0;
  }
  if (!isForwardMove(currentVersion, target)) {
    io.stderr(
      `update only moves forward to a newer release tag (running v${currentVersion}, asked for ${target}). ` +
        "A rollback follows the release's rollback notes (docs/operations/upgrades) — " +
        "migrations are not reversed automatically; a pre-release or bare revision is not a release.",
    );
    return 1;
  }
  io.stdout(`Updating v${currentVersion} -> ${target}`);

  // Breaking changes between here and there, from the TARGET's changelog —
  // the running checkout has never heard of the new version.
  const changelogAtTarget = await git(["show", `${target}:CHANGELOG.md`]);
  if (changelogAtTarget.code === 0) {
    const targetVersion = target.replace(/^v/, "");
    const breaking = breakingChangesBetween(
      changelogAtTarget.output,
      currentVersion,
      targetVersion,
    );
    if (breaking.length > 0) {
      io.stdout("");
      io.stdout("This update crosses BREAKING CHANGES:");
      for (const entry of breaking) {
        io.stdout(`  v${entry.version}:`);
        for (const line of entry.changes.split("\n")) io.stdout(`    ${line}`);
      }
      io.stdout("");
      if (!parsed.values.yes) {
        const proceed = await prompter.confirm("Proceed with the update?", false);
        if (!proceed) {
          io.stderr("Update aborted (re-run with --yes to accept the breaking changes).");
          return 1;
        }
      }
    }
  } else {
    io.stdout(
      "(Could not read the target's CHANGELOG.md; proceeding without the breaking-change summary.)",
    );
  }

  const envFile = await loadPlatformEnvFile({
    env: io.env,
    repoRoot: repo,
    platform: resolved.platform,
  });
  if (!envFile) {
    io.stderr(`No configuration found at ${resolved.layout.envFilePath}.`);
    return 1;
  }

  // Backup before anything moves.
  let backupPath: string | null = null;
  if (!parsed.values["skip-backup"]) {
    await mkdir(resolved.layout.backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(resolved.layout.backupsDir, `eveland-v${currentVersion}-${stamp}.sql`);
    io.stdout(`Backing up the database to ${backupPath}...`);
    const dump = await (io.pgDump ?? defaultPgDump())(backupPath, {
      cwd: repo,
      envFilePath: envFile.path,
    });
    if (dump !== 0) {
      io.stderr(
        "pg_dump failed — refusing to update without a backup. " +
          "Fix the database (is the postgres container running?) or pass --skip-backup.",
      );
      return 1;
    }
  }

  // Stop the WHOLE platform before the working tree moves: replacing sources,
  // node_modules, and the .next build under running processes would let the
  // supervisor restart children from a half-updated tree, and overwrite the
  // artifacts the running Dashboard is serving.
  io.stdout("Stopping the platform before the update...");
  const stopCode = await runStop([], io);
  if (stopCode !== 0) return stopCode;

  const recovery = (failedStep: string) =>
    recoveryPlan({ failedStep, fromVersion: currentVersion, backupPath, repo });

  // Dirty-tree handling: an unmerged index breaks stash, so reset it first;
  // real modifications go into a named stash we offer to restore afterwards.
  const status = await git(["status", "--porcelain"]);
  const dirtyLines = status.output.split("\n").filter((line) => line.trim() !== "");
  let stashName: string | null = null;
  let stashRef: string | null = null;
  if (dirtyLines.length > 0) {
    if (
      dirtyLines.some((line) => line.startsWith("U") || line[1] === "U" || line.startsWith("AA"))
    ) {
      io.stdout("Resetting an unmerged index left behind by a previous operation...");
      await git(["reset"]);
    }
    stashName = `eveland-ctl-update-${Date.now()}`;
    io.stdout(`The source tree has local changes; stashing them as '${stashName}'.`);
    const stash = await git(["stash", "push", "--include-untracked", "-m", stashName]);
    if (stash.code !== 0) {
      io.stderr(`git stash failed:\n${stash.output.trim()}`);
      io.stderr(recovery("Stashing local changes failed"));
      return 1;
    }
    const ref = await git(["rev-parse", "refs/stash"]);
    stashRef = ref.code === 0 ? ref.output.trim().split("\n")[0] || null : null;
  }

  // The eve window BEFORE the checkout moves, persisted with the record: a
  // resumed run reads the target tree and could not detect the move itself.
  const templatePath = path.join(repo, "templates/starter-agent/package.json");
  const evePinBefore = templateEvePin(await readFile(templatePath, "utf8").catch(() => null));

  // From here the checkout may report the target version: record the
  // in-flight update so a failed step is resumed, never mistaken for done.
  const pendingRecord: PendingUpdate = {
    from: currentVersion,
    target,
    backupPath,
    stashName,
    stashRef,
    evePinBefore,
    startedAt: new Date().toISOString(),
  };
  await writePendingUpdate(resolved.layout, pendingRecord);
  return completeUpdate(context, pendingRecord);
}

/**
 * Restore exactly the stash this update created: by its recorded commit,
 * or — when the sha could not be recorded — by its unique name in the
 * stash list. Never a bare `pop`: that takes whatever the operator stashed
 * most recently while fixing a failed attempt.
 */
async function restoreStash(
  git: UpdateContext["git"],
  stashRef: string | null,
  stashName: string,
): Promise<{ ok: boolean; detail: string }> {
  const list = await git(["stash", "list", "--format=%H %gd %gs"]);
  const entries = list.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, index, ...subject] = line.split(" ");
      return { sha: sha ?? "", index: index ?? "", subject: subject.join(" ") };
    });
  const entry = stashRef
    ? entries.find((candidate) => candidate.sha === stashRef)
    : entries.find((candidate) => candidate.subject.includes(stashName));
  if (!entry) {
    return {
      ok: false,
      detail: `stash '${stashName}' was not found in git stash list; restore it by hand if it still exists.`,
    };
  }
  const apply = await git(["stash", "apply", entry.sha]);
  if (apply.code !== 0) return { ok: false, detail: apply.output.trim() };
  await git(["stash", "drop", entry.index]);
  return { ok: true, detail: "" };
}

/**
 * Everything after the pending record exists: checkout, pnpm install, the
 * handover to the new checkout's ctl, then the record is cleared. Shared by
 * a fresh update and a resumed one (every step is idempotent).
 */
async function completeUpdate(
  context: UpdateContext,
  initialPending: PendingUpdate,
): Promise<number> {
  let pending = initialPending;
  const { io, repo, git, streamCommand, prompter } = context;
  const { target, backupPath, stashName, stashRef, evePinBefore } = pending;
  const recovery = (failedStep: string) =>
    recoveryPlan({ failedStep, fromVersion: pending.from, backupPath, repo }) +
    "\n              (This update is recorded as in progress: re-running `eveland-ctl update` resumes it.)";
  const templatePath = path.join(repo, "templates/starter-agent/package.json");

  const checkout = await git(["checkout", "--quiet", target]);
  if (checkout.code !== 0) {
    io.stderr(`git checkout ${target} failed:\n${checkout.output.trim()}`);
    io.stderr(recovery("The checkout failed"));
    return 1;
  }

  io.stdout("Installing dependencies...");
  const install = await streamCommand(["pnpm", "install", "--frozen-lockfile"], {
    cwd: repo,
    env: { ...io.env, SHARP_IGNORE_GLOBAL_LIBVIPS: "1" },
  });
  if (install !== 0) {
    io.stderr(recovery("pnpm install failed"));
    return 1;
  }

  // Local changes go back BEFORE anything runs from this tree: applying a
  // stash under a started platform would edit sources beneath live
  // processes. The record remembers a restored stash so a resume after a
  // later failure never looks for it again.
  if (stashName && !pending.stashRestored) {
    const restore = await prompter.confirm(
      `Restore the stashed local changes ('${stashName}') into the updated tree before it starts?`,
      false,
    );
    if (restore) {
      // Exactly the recorded stash commit: an operator may have stashed
      // other work while fixing a failed attempt, and `pop` would take
      // whichever entry is newest.
      const restored = await restoreStash(git, stashRef, stashName);
      io.stdout(restored.ok ? "Stash restored." : `Stash restore failed:\n${restored.detail}`);
      if (restored.ok) {
        pending = { ...pending, stashRestored: true };
        await writePendingUpdate(context.layout, pending);
      }
    } else {
      io.stdout(`Local changes remain stashed as '${stashName}' (git stash list).`);
    }
  }

  // Phase 2 runs from the NEW checkout: this process still executes the old
  // code and must not decide the new version's artifacts or start sequence.
  io.stdout("Handing over to the updated eveland-ctl...");
  const finish = await streamCommand(
    [
      process.execPath,
      path.join(repo, "packages/ctl/src/bin.ts"),
      "_finish-update",
      "--from",
      pending.from,
      ...(backupPath ? ["--backup", backupPath] : []),
    ],
    { cwd: repo, env: io.env },
  );
  if (finish !== 0) {
    io.stderr(
      "The updated eveland-ctl could not finish the update; see its recovery plan above. " +
        "Re-running `eveland-ctl update` resumes from here.",
    );
    return 1;
  }

  const evePinAfter = templateEvePin(await readFile(templatePath, "utf8").catch(() => null));
  if (evePinBefore && evePinAfter && evePinBefore !== evePinAfter) {
    io.stdout("");
    io.stdout("*** The supported eve window moved with this update. ***");
    io.stdout("Releases built against the old window attest as unknown and their");
    io.stdout("schedules dead-letter until rebuilt: redeploy and promote EVERY project");
    io.stdout("(`eveland deploy` per project, or the Dashboard's rebuild).");
  }

  // The record goes last: every recovery action above has happened, so
  // nothing an interrupted run still owed can be lost with it.
  await rm(pendingUpdatePath(context.layout), { force: true });

  io.stdout("");
  io.stdout(`Updated to ${target}.`);
  return 0;
}

/**
 * The hidden `_finish-update` command, executed from the NEW checkout by
 * phase 1: refresh release identity, regenerate the systemd form's
 * artifacts (units, env allowlists, Compose overlay — so permission and
 * topology fixes reach installed machines), build, migrate, start. Every
 * failure prints the same recovery plan phase 1 uses.
 */
export async function runFinishUpdate(args: string[], io: LifecycleIo): Promise<number> {
  const parsed = parseArgs({
    args,
    options: { from: { type: "string" }, backup: { type: "string" } },
    allowPositionals: false,
  });
  const resolved = resolveLifecycle(io);
  const repo = resolved.repoRootDir;
  const fromVersion = parsed.values.from ?? "unknown";
  const backupPath = parsed.values.backup ?? null;
  const recovery = (failedStep: string) =>
    recoveryPlan({ failedStep, fromVersion, backupPath, repo });
  const streamCommand = io.streamCommand ?? defaultStreamCommand(io.stdout);

  const envFile = await loadPlatformEnvFile({
    env: io.env,
    repoRoot: repo,
    platform: resolved.platform,
  });
  if (!envFile) {
    io.stderr(recovery(`No configuration found at ${resolved.layout.envFilePath}`));
    return 1;
  }

  // Release identity follows the checkout (exact short SHA; stable only on
  // an exact release tag).
  await pinReleaseIdentity(resolved.execCommand, repo, envFile);

  const metadata = await readInstallMetadata(resolved.layout);
  const systemdForm = metadata?.supervision === "systemd";
  if (systemdForm) {
    // The new version owns its artifacts: units, per-service env
    // allowlists, and the Compose overlay are regenerated and reloaded.
    io.stdout("Regenerating the systemd form's units, env allowlists, and Compose overlay...");
    const installed = await installSystemdArtifacts(systemdModeContext(io, resolved), envFile);
    if (installed !== 0) {
      io.stderr(recovery("Regenerating the systemd artifacts failed"));
      return 1;
    }
  } else {
    io.stdout("Building the Dashboard...");
    const build = await streamCommand(["pnpm", "--filter", "@evelandhq/web", "build"], {
      cwd: repo,
      env: { ...io.env, ...envFile.values, SHARP_IGNORE_GLOBAL_LIBVIPS: "1" },
    });
    if (build !== 0) {
      io.stderr(recovery("The Dashboard build failed"));
      return 1;
    }
  }

  io.stdout("Applying database migrations...");
  const migrate = await streamCommand(["pnpm", "--filter", "@evelandhq/api", "db:migrate"], {
    cwd: repo,
    env: { ...io.env, ...envFile.values },
  });
  if (migrate !== 0) {
    io.stderr(recovery("Database migration failed"));
    return 1;
  }

  io.stdout("Starting the updated platform...");
  // The pending record still exists here (phase 1 clears it after we
  // return): tell start this is the update itself, not a stray start.
  const started = await runStart(["--from-update"], io);
  if (started !== 0) {
    io.stderr(recovery("Starting the updated platform failed"));
    return started;
  }

  // Node self-heal check: nvm uninstall silently breaks the pinned
  // interpreter; the shims and units depend on it.
  const pinnedNode = envFile.values.EVELAND_NODE;
  if (pinnedNode) {
    const probe = await resolved.execCommand([pinnedNode, "--version"], { cwd: repo });
    if (probe.code !== 0) {
      io.stderr(
        `EVELAND_NODE=${pinnedNode} no longer runs (removed by nvm uninstall?). ` +
          "Re-run the installer to re-resolve and re-pin Node.",
      );
    }
  }
  return 0;
}
