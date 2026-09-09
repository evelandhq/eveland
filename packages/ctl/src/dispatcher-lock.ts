import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";
import { createPalette, type Palette } from "./color.ts";
import { defaultDispatcherLockStore, type DispatcherLockHolder } from "./dispatcher-lock-store.ts";
import { loadPlatformEnvFile } from "./env-file.ts";
import { resolveLifecycle, type LifecycleIo } from "./lifecycle.ts";

/**
 * `eveland-ctl dispatcher-lock`: who holds the workflow dispatcher's singleton
 * lock on the World database, and `--terminate` to evict a holder that is not
 * coming back.
 *
 * The lock is a session-scoped advisory lock. A dispatcher that dies with its
 * host closes no socket, so Postgres keeps its session — and the lock — until
 * it notices on its own. The dispatcher now asks the server to notice within
 * `WORKFLOW_DISPATCHER_OWNERSHIP_LIVENESS_MS` and waits for the lock instead of
 * exiting, so this command is for the holder those layers cannot reach: a
 * dispatcher from before they existed, or a server that ignores keepalives.
 * The symptom is `eveland-ctl status` saying the dispatcher is NOT CLAIMING and
 * its journal repeating "Another workflow dispatcher already owns this database".
 *
 * Report first, act only when asked. Terminating the holder needs the World
 * role to own that session (it does: the dispatcher connects as it) or a
 * superuser.
 */

type Options = {
  terminate: boolean;
  assumeYes: boolean;
};

export async function runDispatcherLock(args: string[], io: LifecycleIo): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(args);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const resolved = resolveLifecycle(io);
  const color = io.palette ?? createPalette(io.env);
  const envFile = await loadPlatformEnvFile({
    env: io.env,
    repoRoot: resolved.repoRootDir,
    platform: resolved.platform,
  });
  // The env file is this installation's single configuration source; a value
  // left over in the operator's shell must not point this at another world.
  const worldUrl = resolveWorkflowWorldPlatformUrl({ ...io.env, ...envFile?.values });
  if (!worldUrl) {
    io.stdout("No shared workflow world is configured, so there is no dispatcher lock to inspect.");
    io.stdout(
      color.dim("  (EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL / EVELAND_WORKFLOW_WORLD_URL are unset.)"),
    );
    return 0;
  }

  const store = io.dispatcherLock ?? defaultDispatcherLockStore();
  const holder = await store.holder(worldUrl);
  report(io, color, holder);
  if (!options.terminate) return 0;
  if (!holder) {
    io.stdout("Nothing to terminate.");
    return 0;
  }

  if (!options.assumeYes) {
    const prompter = io.prompter;
    const proceed = prompter?.interactive
      ? await prompter.confirm(
          `Terminate Postgres backend ${String(holder.pid)}? A live dispatcher would lose its lock and restart.`,
          false,
        )
      : false;
    if (!proceed) {
      io.stderr(
        prompter?.interactive
          ? "Cancelled."
          : "Refusing to terminate the holder without confirmation. Re-run with --yes.",
      );
      return 1;
    }
  }

  const terminated = await store.terminate(worldUrl, holder.pid);
  if (!terminated) {
    io.stderr(
      `Backend ${String(holder.pid)} was not signalled: it may have ended already, or the World role may not own it.`,
    );
    return 1;
  }
  io.stdout(`Terminated backend ${String(holder.pid)}.`);
  io.stdout(
    color.dim(
      "  A waiting dispatcher takes the lock on its next attempt; a failed unit needs `systemctl reset-failed` and a start.",
    ),
  );
  return 0;
}

function report(io: LifecycleIo, color: Palette, holder: DispatcherLockHolder | null): void {
  io.stdout(color.bold("Workflow dispatcher ownership lock"));
  io.stdout("");
  if (!holder) {
    io.stdout(`  ${color.green("✓")} Not held. A starting dispatcher will take it at once.`);
    return;
  }
  io.stdout(`  Held by Postgres backend ${color.bold(String(holder.pid))}`);
  io.stdout(`    application  ${holder.applicationName || color.dim("(none)")}`);
  io.stdout(`    client       ${holder.clientAddr ?? color.dim("(local or hidden)")}`);
  io.stdout(
    `    since        ${holder.backendStart ? timestamp(holder.backendStart) : color.dim("unknown")}`,
  );
  io.stdout(
    `    state        ${holder.state ?? color.dim("unknown")}${
      holder.stateChange ? color.dim(` (since ${timestamp(holder.stateChange)})`) : ""
    }`,
  );
  io.stdout("");
  io.stdout(
    color.dim(
      'If the dispatcher\'s journal repeats "Another workflow dispatcher already owns this database"',
    ),
  );
  io.stdout(color.dim("and no dispatcher process matches this session, it is a dead holder:"));
  io.stdout(color.dim("  eveland-ctl dispatcher-lock --terminate"));
}

function timestamp(at: Date): string {
  return at
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/u, "Z");
}

function parseArgs(args: string[]): Options {
  const options: Options = { terminate: false, assumeYes: false };
  for (const arg of args) {
    switch (arg) {
      case "--terminate":
        options.terminate = true;
        break;
      case "--yes":
      case "-y":
        options.assumeYes = true;
        break;
      default:
        throw new Error(
          `Unknown option ${arg}. Usage: eveland-ctl dispatcher-lock [--terminate [--yes]]`,
        );
    }
  }
  if (options.assumeYes && !options.terminate) {
    throw new Error("--yes only applies with --terminate.");
  }
  return options;
}
