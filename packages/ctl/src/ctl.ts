import { readFile } from "node:fs/promises";
import { runDoctor } from "./doctor.ts";
import { runRestart, runStart, runStop, runSupervise, type LifecycleIo } from "./lifecycle.ts";
import { runCtlLogs } from "./logs.ts";
import { runStatus } from "./status.ts";

/**
 * eveland-ctl: the platform operator's tool. It manages THIS machine's
 * installation — processes, configuration, upgrades — and only ships with the
 * source tree. Talking to a platform as an agent author (login, deploy,
 * project logs) is the `eveland` CLI's job; the two binaries cross-reference
 * each other on unknown commands.
 */

export type CtlIo = LifecycleIo & {
  stopped?: () => boolean;
};

type Command = {
  description: string;
  hidden?: boolean;
  run: (args: string[], io: CtlIo) => Promise<number>;
};

// The `eveland` CLI's verbs, for the cross-bin hint. Hand-synced with
// packages/cli/src/cli.ts (the dependency direction forbids importing it).
const EVELAND_COMMANDS = new Set(["init", "login", "logout", "whoami", "deploy", "env"]);

const commands: Record<string, Command> = {
  start: {
    description: "Start the platform (infra containers + the five platform processes)",
    run: runStart,
  },
  stop: {
    description: "Stop the supervised platform processes",
    run: runStop,
  },
  restart: {
    description: "Stop, then start again",
    run: runRestart,
  },
  status: {
    description: "Supervisor process view plus live health probes",
    run: runStatus,
  },
  logs: {
    description: "Tail the platform processes' own logs (-f to follow)",
    run: runCtlLogs,
  },
  doctor: {
    description: "Check this machine against everything a healthy install needs",
    run: runDoctor,
  },
  _supervise: {
    description: "(internal) the daemonized supervisor behind `start`",
    hidden: true,
    run: runSupervise,
  },
};

// Reserved verbs that exist in the command surface but not in this build yet.
const PLANNED_COMMANDS = new Set(["update", "install"]);

export async function runCtl(argv: string[], io: CtlIo): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    printHelp(io);
    return name ? 0 : 1;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    io.stdout(`eveland-ctl ${await ctlVersion()}`);
    return 0;
  }
  const command = commands[name];
  if (!command) {
    io.stderr(unknownCommandMessage(name));
    return 1;
  }
  try {
    return await command.run(rest, io);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function unknownCommandMessage(name: string): string {
  if (PLANNED_COMMANDS.has(name)) {
    return `'${name}' is not available yet in this build of eveland-ctl.`;
  }
  if (EVELAND_COMMANDS.has(name)) {
    return `'${name}' talks to a platform as an agent author — try \`eveland ${name}\`.`;
  }
  const visible = Object.entries(commands)
    .filter(([, command]) => !command.hidden)
    .map(([candidate]) => candidate);
  const nearest = [...visible, ...EVELAND_COMMANDS]
    .map((candidate) => ({ candidate, distance: levenshtein(name, candidate) }))
    .filter(({ candidate, distance }) => distance <= Math.max(1, Math.floor(candidate.length / 3)))
    .sort((a, b) => a.distance - b.distance)[0];
  const hint = nearest
    ? EVELAND_COMMANDS.has(nearest.candidate)
      ? ` Did you mean \`eveland ${nearest.candidate}\`?`
      : ` Did you mean \`eveland-ctl ${nearest.candidate}\`?`
    : "";
  return `Unknown command '${name}'.${hint} Run \`eveland-ctl help\` for the command list.`;
}

function printHelp(io: CtlIo): void {
  io.stdout("Usage: eveland-ctl <command>");
  io.stdout("");
  io.stdout("Commands:");
  for (const [name, command] of Object.entries(commands)) {
    if (command.hidden) continue;
    io.stdout(`  ${name.padEnd(8)} ${command.description}`);
  }
  io.stdout("");
  io.stdout("The appliance root is EVELAND_HOME (default ~/.eveland on macOS,");
  io.stdout("/opt/eveland on Linux); a development checkout uses its own .env.");
}

async function ctlVersion(): Promise<string> {
  // Versions with the product via the release-please-maintained root
  // manifest, exactly like the eveland CLI (the workspace package itself is
  // pinned at 0.0.0 and would identify nothing).
  const packageJson = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return packageJson.version;
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distance = Array.from({ length: rows }, (_, i) => {
    const row = Array.from({ length: cols }, () => 0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) distance[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      distance[i]![j] = Math.min(
        distance[i - 1]![j]! + 1,
        distance[i]![j - 1]! + 1,
        distance[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return distance[rows - 1]![cols - 1]!;
}
