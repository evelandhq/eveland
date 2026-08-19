/**
 * The cutover CLI's flag grammar, closed over the flags the commands actually
 * read. Closed on purpose: a mistyped flag must refuse loudly, not vanish —
 * during the maintenance window a silently dropped `--run-families` would
 * re-hold the saga and read as a cutover problem instead of a typo.
 *
 * Value flags consume the next token VERBATIM, so a `--backup-command` whose
 * command itself starts with `--` stays its value instead of being read as
 * the next flag (the `--name=value` form works too). The two operator
 * attestations are boolean flags: bare means `true`, and an explicit
 * `true`/`false` after them is consumed as the value.
 */
export class CutoverUsageError extends Error {}

const VALUE_FLAGS = new Set([
  "operation-id",
  "corrupted-runs",
  "run-families",
  "no-family",
  "backup-command",
  "deployments",
]);

const BOOLEAN_FLAGS = new Set(["quiescence-verified", "continuity-verified"]);

export function parseCutoverFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    // A bare `--` is a pass-through separator some runners leave in argv.
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      throw new CutoverUsageError(
        `Unexpected argument "${arg}": every option is --flag <value> (or --flag=value).`,
      );
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
      throw new CutoverUsageError(
        `Unknown flag --${name}. Known flags: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS]
          .map((known) => `--${known}`)
          .join(", ")}.`,
      );
    }
    if (equals !== -1) {
      flags[name] = arg.slice(equals + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      const next = args[index + 1];
      if (next === "true" || next === "false") {
        flags[name] = next;
        index += 1;
      } else {
        flags[name] = "true";
      }
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new CutoverUsageError(`--${name} requires a value.`);
    }
    flags[name] = value;
    index += 1;
  }
  return flags;
}
