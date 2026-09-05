import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";
import { createPalette, type Palette } from "./color.ts";
import {
  defaultDeadLetterStore,
  type DeadLetterGroup,
  type DeadLetterSelector,
} from "./dead-letter-store.ts";
import { loadPlatformEnvFile } from "./env-file.ts";
import { resolveLifecycle, type LifecycleIo } from "./lifecycle.ts";

/**
 * `eveland-ctl dead-letters`: the operator half of dispatch quarantine.
 *
 * A dead letter is a dispatch this installation dropped, kept verbatim so it
 * can be replayed once the cause is fixed, and holding its run out of boot
 * recovery until someone decides. The Dashboard has always counted them and
 * said they "await operator resolution" — this is the surface where that
 * resolution happens.
 *
 * Report first, act only when asked. Resolving is not a cleanup: it hands the
 * quarantined runs back to the next dispatcher boot, so the count of runs that
 * changes meaning is printed as loudly as the count of rows.
 */

type Options = {
  resolve: boolean;
  selector: DeadLetterSelector | null;
  assumeYes: boolean;
  /** Rows of the per-deployment table to print; 0 prints all of them. */
  limit: number;
};

/**
 * Enough to see the shape of the problem on a machine whose letters come from
 * a handful of dead Deployments, which is what this looks like every time.
 * `--limit 0` is there for the installation where it does not.
 */
const DEFAULT_LIMIT = 15;

export async function runDeadLetters(args: string[], io: LifecycleIo): Promise<number> {
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
    io.stdout("No shared workflow world is configured, so there are no dispatch dead letters.");
    io.stdout(
      color.dim("  (EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL / EVELAND_WORKFLOW_WORLD_URL are unset.)"),
    );
    return 0;
  }

  const store = io.deadLetters ?? defaultDeadLetterStore();
  if (options.resolve) {
    return await resolveLetters(io, color, store, worldUrl, options);
  }

  const groups = await store.summarize(worldUrl);
  report(io, color, groups, options.limit);
  return groups.length > 0 ? 1 : 0;
}

function report(io: LifecycleIo, color: Palette, groups: DeadLetterGroup[], limit: number): void {
  if (groups.length === 0) {
    io.stdout(`${color.green("✓")} No unresolved workflow dispatch dead letters.`);
    return;
  }
  const letters = total(groups, (group) => group.letters);
  const activeRuns = total(groups, (group) => group.activeRuns);
  const runlessLetters = total(groups, (group) => group.runlessLetters);
  const oldest = groups
    .map((group) => group.oldestAt)
    .reduce((earliest, at) => (at < earliest ? at : earliest));

  io.stdout(color.bold("Workflow dispatch dead letters"));
  io.stdout("");
  io.stdout(`  ${plural(letters, "unresolved letter")}, oldest ${timestamp(oldest)}`);
  // The number that decides whether this is an incident or a record of one.
  io.stdout(
    activeRuns > 0
      ? `  ${color.yellow(plural(activeRuns, "run"))} still quarantined — pending or running, and no dispatcher will touch them`
      : `  ${color.dim("no run is still quarantined; every one of these has already settled")}`,
  );
  if (runlessLetters > 0) {
    io.stdout(`  ${plural(runlessLetters, "letter")} name no run at all`);
  }
  io.stdout("");

  const shown = limit > 0 ? groups.slice(0, limit) : groups;
  const width = Math.max(...shown.map((group) => label(group).length));
  for (const group of shown) {
    const stuck =
      group.activeRuns > 0
        ? color.yellow(`${String(group.activeRuns)} stuck`)
        : color.dim("none stuck");
    io.stdout(
      `  ${label(group).padEnd(width)}  ${String(group.letters).padStart(5)}  ${stuck}  ${color.dim(
        truncate(group.latestReason, 60),
      )}`,
    );
  }
  const hidden = groups.slice(shown.length);
  if (hidden.length > 0) {
    io.stdout(
      color.dim(
        `  … ${plural(hidden.length, "more deployment")} holding ${plural(
          total(hidden, (group) => group.letters),
          "letter",
        )} (--limit 0 for all)`,
      ),
    );
  }

  io.stdout("");
  io.stdout(color.dim("Resolving hands a quarantined run back to the next dispatcher boot."));
  io.stdout(color.dim("  eveland-ctl dead-letters --resolve --deployment <id>"));
  io.stdout(color.dim("  eveland-ctl dead-letters --resolve --run <id>"));
  io.stdout(color.dim("  eveland-ctl dead-letters --resolve --all"));
}

async function resolveLetters(
  io: LifecycleIo,
  color: Palette,
  store: NonNullable<LifecycleIo["deadLetters"]>,
  worldUrl: string,
  options: Options,
): Promise<number> {
  const selector = options.selector;
  if (!selector) {
    io.stderr(
      "dead-letters --resolve needs a target: --run <id>, --deployment <id>, or --all. There is no implicit everything.",
    );
    return 1;
  }
  if (selector.kind === "all" && !options.assumeYes) {
    const prompter = io.prompter;
    const proceed = prompter?.interactive
      ? await prompter.confirm(
          "Resolve every unresolved dead letter, replaying each quarantined run at the next dispatcher boot?",
          false,
        )
      : false;
    if (!proceed) {
      io.stderr(
        prompter?.interactive
          ? "Cancelled."
          : "Refusing to resolve everything without confirmation. Re-run with --yes.",
      );
      return 1;
    }
  }

  const result = await store.resolve(worldUrl, selector);
  if (result.letters === 0) {
    io.stdout("Nothing to resolve: no unresolved dead letters matched.");
    return 0;
  }
  io.stdout(`Resolved ${plural(result.letters, "dead letter")}.`);
  if (result.replayableRuns > 0) {
    io.stdout(
      color.yellow(
        `${plural(result.replayableRuns, "quarantined run")} will be replayed at the next dispatcher boot.`,
      ),
    );
    io.stdout(color.dim("  Restart the workflow dispatcher to replay them now."));
  }
  return 0;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    resolve: false,
    selector: null,
    assumeYes: false,
    limit: DEFAULT_LIMIT,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value.`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--resolve":
        options.resolve = true;
        break;
      case "--all":
        options.selector = setSelector(options.selector, { kind: "all" });
        break;
      case "--run":
        options.selector = setSelector(options.selector, { kind: "run", runId: value() });
        break;
      case "--deployment":
        options.selector = setSelector(options.selector, {
          kind: "deployment",
          deploymentId: value(),
        });
        break;
      case "--limit": {
        const raw = value();
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`--limit needs a whole number of rows, not '${raw}'.`);
        }
        options.limit = parsed;
        break;
      }
      case "--yes":
      case "-y":
        options.assumeYes = true;
        break;
      default:
        throw new Error(
          `Unknown option '${arg}'. Usage: eveland-ctl dead-letters [--limit <n>] [--resolve --run <id> | --deployment <id> | --all [--yes]]`,
        );
    }
  }
  return options;
}

/** Two selectors would read as "and" and mean "or"; refusing is the honest answer. */
function setSelector(
  current: DeadLetterSelector | null,
  next: DeadLetterSelector,
): DeadLetterSelector {
  if (current) throw new Error("Give exactly one of --run, --deployment, or --all.");
  return next;
}

function label(group: DeadLetterGroup): string {
  return `${group.deploymentId ?? "(no deployment)"} ${group.projectId}`;
}

function total(groups: DeadLetterGroup[], of: (group: DeadLetterGroup) => number): number {
  return groups.reduce((sum, group) => sum + of(group), 0);
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function truncate(text: string, width: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/** Local time to the minute: this is read by a person sitting at the machine. */
function timestamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
