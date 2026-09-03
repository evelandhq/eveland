import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ApiError, apiRequest, type FetchLike } from "./api-client.ts";
import { removeCredential, resolveToken, saveCredential } from "./credentials.ts";
import { runDeploy } from "./deploy.ts";
import { runDeviceFlow } from "./device-flow.ts";
import { listEnv, removeEnv, setEnv } from "./env.ts";
import { initProject } from "./init.ts";
import { runLogs } from "./logs.ts";
import { resolveOrigin } from "./origin.ts";
import { resolveProject } from "./project.ts";

/**
 * The eveland CLI: platform-relationship verbs only (auth, deploy, logs,
 * env). Framework verbs (build/test/dev) belong to the eve toolchain, and
 * platform operations (start/stop/doctor/update) to eveland-ctl.
 */

export type CliIo = {
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetchImpl?: FetchLike;
  openUrl?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** logs --follow stops when this reports true; unset means run until killed. */
  stopped?: () => boolean;
  /** `env set KEY --stdin` reads the value here; unset means process.stdin. */
  readStdin?: () => Promise<string>;
};

async function readAllStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

type Command = {
  description: string;
  run: (args: string[], io: CliIo) => Promise<number>;
};

type MemberResponse = {
  member: { email: string; name: string | null; role: string; tokenScopes?: string[] };
};

// eveland-ctl's verbs, for the cross-bin hint. Only verbs that will never be
// eveland commands belong here (`logs` is an eveland command).
const CTL_COMMANDS = new Set(["start", "stop", "restart", "status", "doctor", "update", "install"]);

function parseOriginFlag(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { origin: { type: "string" } },
    allowPositionals: true,
  });
  return { origin: parsed.values.origin, positionals: parsed.positionals };
}

async function requireToken(origin: string, io: CliIo): Promise<string> {
  const resolved = await resolveToken(origin, io.env);
  if (!resolved) {
    throw new Error(`Not logged in to ${origin}. Run \`eveland login --origin ${origin}\`.`);
  }
  return resolved.token;
}

const commands: Record<string, Command> = {
  init: {
    description: "Scaffold a new agent project from the starter template (no login needed)",
    run: async (args, io) => {
      const { positionals } = parseOriginFlag(args);
      const targetDir = positionals[0];
      if (!targetDir) {
        io.stderr("Usage: eveland init <directory>");
        return 1;
      }
      const { projectName, files } = await initProject({ targetDir });
      io.stdout(`Created ${projectName} (${files.length} files):`);
      for (const file of files) io.stdout(`  ${file}`);
      io.stdout("");
      io.stdout("Next steps:");
      io.stdout(`  eveland login --origin <url>    authenticate against your instance`);
      io.stdout(`  cd ${targetDir} && eveland deploy    build and promote it`);
      return 0;
    },
  },
  login: {
    description: "Authenticate this machine against an eveland instance (device flow)",
    run: async (args, io) => {
      const { origin: originFlag } = parseOriginFlag(args);
      const origin = await resolveOrigin(originFlag, io.env);
      const result = await runDeviceFlow(origin, {
        fetchImpl: io.fetchImpl,
        print: io.stdout,
        openUrl: io.openUrl,
        sleep: io.sleep,
      });
      await saveCredential(
        origin,
        {
          accessToken: result.accessToken,
          tokenType: result.tokenType,
          scopes: result.scopes,
          obtainedAt: result.obtainedAt,
          expiresAt: result.expiresAt,
        },
        io.env,
      );
      const whoami = await apiRequest<MemberResponse>({
        origin,
        path: "/api/members/me",
        token: result.accessToken,
        fetchImpl: io.fetchImpl,
      });
      io.stdout(`Logged in to ${origin} as ${whoami.member.email}.`);
      return 0;
    },
  },
  deploy: {
    description: "Upload this directory, build it on the platform, and promote it",
    run: async (args, io) => {
      const parsed = parseArgs({
        args,
        options: {
          origin: { type: "string" },
          name: { type: "string" },
          "no-promote": { type: "boolean" },
        },
        allowPositionals: true,
      });
      const origin = await resolveOrigin(parsed.values.origin, io.env);
      const token = await requireToken(origin, io);
      const result = await runDeploy({
        origin,
        token,
        dir: parsed.positionals[0] ?? ".",
        name: parsed.values.name,
        promote: !parsed.values["no-promote"],
        io: { fetchImpl: io.fetchImpl, print: io.stdout, sleep: io.sleep },
      });
      io.stdout("");
      io.stdout(`Deployed ${result.slug}${result.promoted ? "" : " (preview only)"}.`);
      if (result.stableUrl) io.stdout(`Stable:  ${result.stableUrl}`);
      for (const preview of result.previewUrls) io.stdout(`Preview: ${preview}`);
      return 0;
    },
  },
  logs: {
    description: "Print a project's logs (default: runtime; --follow to keep watching)",
    run: async (args, io) => {
      const parsed = parseArgs({
        args,
        options: {
          origin: { type: "string" },
          name: { type: "string" },
          type: { type: "string" },
          follow: { type: "boolean", short: "f" },
          tail: { type: "string" },
        },
        allowPositionals: true,
      });
      const type = parsed.values.type ?? "runtime";
      if (type !== "build" && type !== "deploy" && type !== "runtime") {
        io.stderr("--type must be build, deploy, or runtime.");
        return 1;
      }
      const origin = await resolveOrigin(parsed.values.origin, io.env);
      const token = await requireToken(origin, io);
      const project = await resolveProject({
        origin,
        token,
        name: parsed.values.name,
        dir: parsed.positionals[0],
        fetchImpl: io.fetchImpl,
      });
      await runLogs({
        origin,
        token,
        projectId: project.id,
        type,
        tail: Number(parsed.values.tail ?? 100) || 100,
        follow: Boolean(parsed.values.follow),
        io: { fetchImpl: io.fetchImpl, print: io.stdout, sleep: io.sleep, stopped: io.stopped },
      });
      return 0;
    },
  },
  env: {
    description: "Project environment: env list | env set KEY=value [--variable] | env rm KEY",
    run: async (args, io) => {
      const parsed = parseArgs({
        args,
        options: {
          origin: { type: "string" },
          name: { type: "string" },
          variable: { type: "boolean" },
          stdin: { type: "boolean" },
        },
        allowPositionals: true,
      });
      const [action, argument] = parsed.positionals;
      if (action !== "list" && action !== "set" && action !== "rm") {
        io.stderr("Usage: eveland env <list|set KEY=value|set KEY --stdin|rm KEY> [--name <slug>]");
        return 1;
      }
      // `--stdin` keeps the value out of argv: command lines are readable by
      // every local user through ps/proc while the request runs.
      let assignment = argument;
      if (action === "set" && parsed.values.stdin) {
        if (!argument || argument.includes("=")) {
          io.stderr("Usage: eveland env set KEY --stdin  (the value is read from stdin)");
          return 1;
        }
        const value = (await (io.readStdin ?? readAllStdin)()).replace(/\r?\n$/, "");
        if (value === "") {
          io.stderr("eveland env set --stdin: no value was read from stdin.");
          return 1;
        }
        assignment = `${argument}=${value}`;
      }
      const origin = await resolveOrigin(parsed.values.origin, io.env);
      const token = await requireToken(origin, io);
      const project = await resolveProject({
        origin,
        token,
        name: parsed.values.name,
        fetchImpl: io.fetchImpl,
      });
      const envIo = { fetchImpl: io.fetchImpl, print: io.stdout };
      const target = { origin, token, projectId: project.id, io: envIo };
      if (action === "list") {
        await listEnv(target);
        return 0;
      }
      if (!assignment) {
        io.stderr(
          action === "set"
            ? "Usage: eveland env set KEY=value  |  eveland env set KEY --stdin"
            : "Usage: eveland env rm KEY",
        );
        return 1;
      }
      if (action === "set") {
        await setEnv({
          ...target,
          assignment,
          kind: parsed.values.variable ? "variable" : "secret",
        });
        return 0;
      }
      return (await removeEnv({ ...target, key: assignment })) ? 0 : 1;
    },
  },
  logout: {
    description: "Forget the stored credential for an origin",
    run: async (args, io) => {
      const { origin: originFlag } = parseOriginFlag(args);
      const origin = await resolveOrigin(originFlag, io.env);
      const removed = await removeCredential(origin, io.env);
      io.stdout(removed ? `Logged out of ${origin}.` : `No stored credential for ${origin}.`);
      if (io.env.EVELAND_TOKEN?.trim()) {
        io.stdout("Note: EVELAND_TOKEN is set and still authenticates requests.");
      }
      return 0;
    },
  },
  whoami: {
    description: "Show the authenticated user, origin, and token scopes",
    run: async (args, io) => {
      const { origin: originFlag } = parseOriginFlag(args);
      const origin = await resolveOrigin(originFlag, io.env);
      const resolved = await resolveToken(origin, io.env);
      if (!resolved) {
        io.stderr(`Not logged in to ${origin}. Run \`eveland login --origin ${origin}\`.`);
        return 1;
      }
      const whoami = await apiRequest<MemberResponse>({
        origin,
        path: "/api/members/me",
        token: resolved.token,
        fetchImpl: io.fetchImpl,
      });
      const { member } = whoami;
      io.stdout(`Origin: ${origin}`);
      io.stdout(`User:   ${member.name ?? member.email} <${member.email}> (${member.role})`);
      io.stdout(`Scopes: ${member.tokenScopes?.join(", ") || "(none reported)"}`);
      io.stdout(`Token:  ${resolved.source === "env" ? "EVELAND_TOKEN" : "stored credential"}`);
      return 0;
    },
  },
};

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    printHelp(io);
    return name ? 0 : 1;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    io.stdout(`eveland ${await cliVersion()}`);
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
    if (error instanceof ApiError && error.status === 401) {
      io.stderr("Authentication failed: the token is invalid or expired. Run `eveland login`.");
      return 1;
    }
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function unknownCommandMessage(name: string): string {
  if (CTL_COMMANDS.has(name)) {
    return `'${name}' manages the platform itself — try \`eveland-ctl ${name}\`.`;
  }
  const nearest = [...Object.keys(commands), ...CTL_COMMANDS]
    .map((candidate) => ({ candidate, distance: levenshtein(name, candidate) }))
    .filter(({ candidate, distance }) => distance <= Math.max(1, Math.floor(candidate.length / 3)))
    .sort((a, b) => a.distance - b.distance)[0];
  const hint = nearest
    ? CTL_COMMANDS.has(nearest.candidate)
      ? ` Did you mean \`eveland-ctl ${nearest.candidate}\`?`
      : ` Did you mean \`eveland ${nearest.candidate}\`?`
    : "";
  return `Unknown command '${name}'.${hint} Run \`eveland help\` for the command list.`;
}

function printHelp(io: CliIo): void {
  io.stdout("Usage: eveland <command> [--origin <url>]");
  io.stdout("");
  io.stdout("Commands:");
  for (const [name, command] of Object.entries(commands)) {
    io.stdout(`  ${name.padEnd(8)} ${command.description}`);
  }
  io.stdout("");
  io.stdout("Origin resolution: --origin, else a local install's EVELAND_HOME.");
  io.stdout("Headless auth: set EVELAND_TOKEN to skip the stored credential.");
}

async function cliVersion(): Promise<string> {
  // Its own package's version, which is the number a user can act on: it is
  // what their lockfile pins and what `npm view eveland` resolves. This used
  // to read the repository root manifest, back when the CLI was a private
  // 0.0.0 workspace package that would have identified nothing; that path
  // does not exist at all in the published tarball.
  //
  // Two levels up on purpose: the same hop reaches the manifest from
  // src/cli/ when running from source and from dist/cli/ when running from
  // the package as published.
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
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
