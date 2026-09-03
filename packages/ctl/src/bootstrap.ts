import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultBootstrapInputs,
  renderPlatformEnv,
  type BootstrapInputs,
} from "./config-render.ts";
import { parseEnvFile, upsertEnvFileValue, type PlatformEnvFile } from "./env-file.ts";
import { describeDatabaseAddress, type PgReady } from "./pg-probe.ts";
import { deriveReleaseIdentity } from "./release-identity.ts";
import {
  databaseMode,
  readInstallMetadata,
  type ApplianceLayout,
  type DatabaseMode,
  type InstallMetadata,
} from "./home.ts";
import type { ExecCommand, LifecycleIo, StreamCommand } from "./io.ts";
import type { Prompter } from "./prompt.ts";
import type { TcpProbe } from "./net-probe.ts";

/**
 * First-boot bootstrap, run inside `eveland-ctl start` when the appliance has
 * no completed installation. Every step is idempotent — an interrupted
 * bootstrap resumes by re-running start: an existing etc/eveland.env is
 * reused verbatim (never re-rendered, secrets are minted exactly once), and
 * migrations/build steps are safe to repeat.
 */

export type { StreamCommand } from "./io.ts";

export function defaultStreamCommand(print: (line: string) => void): StreamCommand {
  return (argv, options) =>
    new Promise((resolve) => {
      const [command, ...rest] = argv;
      const child = spawn(command!, rest, {
        cwd: options.cwd,
        env: options.env,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      if (options.input !== undefined) child.stdin!.end(options.input);
      let buffer = "";
      const emit = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) print(`  ${line}`);
      };
      child.stdout!.on("data", emit);
      child.stderr!.on("data", emit);
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        if (buffer) print(`  ${buffer}`);
        resolve(code);
      });
    });
}

export type BootstrapDeps = {
  io: LifecycleIo;
  layout: ApplianceLayout;
  repoRootDir: string;
  platform: "darwin" | "linux";
  prompter: Prompter;
  streamCommand: StreamCommand;
  execCommand: ExecCommand;
  tcpProbe: TcpProbe;
  sleep: (ms: number) => Promise<void>;
  fileExists: (filePath: string) => Promise<boolean>;
  /** A real connection + query against a DSN; a port probe is a false ready signal. */
  pgReady: PgReady;
  random?: (size: number) => Buffer;
};

export async function gatherBootstrapInputs(deps: BootstrapDeps): Promise<BootstrapInputs> {
  const defaults = defaultBootstrapInputs(deps.io.env);
  const { prompter } = deps;

  const originAnswer = await prompter.ask(
    "Public origin (the URL this platform will be reached at)",
    defaults.publicOrigin,
  );
  let publicOrigin: string;
  try {
    publicOrigin = new URL(originAnswer.trim()).origin;
  } catch {
    throw new Error(
      `Invalid public origin '${originAnswer}': expected a URL like https://eveland.example.com`,
    );
  }

  const adminEmail = (await prompter.ask("Admin email", defaults.adminEmail)).trim().toLowerCase();
  // Never prompted: a typed answer would be echoed into the install log the
  // installer tees. The password is always generated (or taken from an
  // EVELAND_ADMIN_PASSWORD already in the environment) and lives only in the
  // 0600 etc/eveland.env.
  const adminPassword = defaults.adminPassword;
  if (adminPassword.length < 12) {
    throw new Error("The admin password must be at least 12 characters.");
  }

  const databaseUrl = await chooseDatabase(deps, defaults);

  let anthropicApiKey = defaults.anthropicApiKey;
  if (anthropicApiKey) {
    const use = await prompter.confirm(
      "Found ANTHROPIC_API_KEY in your shell — use it for the built-in agent?",
      true,
    );
    if (!use) anthropicApiKey = undefined;
  } else if (prompter.interactive) {
    anthropicApiKey =
      (await prompter.ask("Anthropic API key for the built-in agent (blank to skip)", "")).trim() ||
      undefined;
  }
  let openaiApiKey = defaults.openaiApiKey;
  if (openaiApiKey) {
    const use = await prompter.confirm(
      "Found OPENAI_API_KEY in your shell — use it for the built-in agent?",
      true,
    );
    if (!use) openaiApiKey = undefined;
  }

  return { publicOrigin, adminEmail, adminPassword, databaseUrl, anthropicApiKey, openaiApiKey };
}

/**
 * Bundled or external Postgres — asked once, at first boot, and answered by
 * the operator rather than guessed.
 *
 * Deliberately not "probe the usual port and use whatever answers": an
 * automatic fallback to the bundled database is how an installation ends up
 * with a second cluster nobody knows about, holding half the data. If an
 * operator names a server, it has to be reachable now, or the install stops
 * here instead of failing later inside a migration.
 */
async function chooseDatabase(
  deps: BootstrapDeps,
  defaults: BootstrapInputs,
): Promise<string | undefined> {
  const { io, prompter } = deps;
  // macOS is not asked. There, deployed Agents are Docker containers that
  // reach Postgres through host.docker.internal while the platform's own
  // processes use loopback -- an external server would reintroduce exactly
  // the two-addresses-for-one-database split the Linux form just removed.
  if (deps.platform !== "linux") return undefined;
  let databaseUrl = defaults.databaseUrl;
  if (databaseUrl) {
    const use = await prompter.confirm(
      `Found DATABASE_URL in your shell (${describeDatabaseAddress(databaseUrl) ?? "unparseable"}) — use it?`,
      true,
    );
    if (!use) databaseUrl = undefined;
  } else if (prompter.interactive) {
    const external = await prompter.confirm(
      "Use an existing PostgreSQL server? (answering no runs one alongside eveland in Docker)",
      false,
    );
    if (external) {
      databaseUrl =
        (
          await prompter.ask(
            "PostgreSQL connection URL (postgres://user:password@host:port/db)",
            "",
          )
        ).trim() || undefined;
    }
  }
  if (!databaseUrl) return undefined;

  const address = describeDatabaseAddress(databaseUrl);
  if (!address) {
    throw new Error(
      "That is not a PostgreSQL connection URL. Expected postgres://user:password@host:port/database.",
    );
  }
  io.stdout(`Checking the database at ${address}...`);
  if (!(await deps.pgReady(databaseUrl))) {
    throw new Error(
      `No PostgreSQL answered at ${address}. Check that it is running, that it accepts ` +
        "connections from this host (listen_addresses and pg_hba.conf), and that the role, " +
        "password and database in the URL exist.",
    );
  }
  io.stdout(`  connected to ${address}`);
  return databaseUrl;
}

export async function writeInstallMetadata(
  layout: ApplianceLayout,
  metadata: InstallMetadata,
): Promise<void> {
  await mkdir(layout.etcDir, { recursive: true });
  await writeFile(layout.installJsonPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export type BootstrapConfig = {
  envFile: PlatformEnvFile;
  /** Recorded in install.json: every later command branches on it. */
  database: DatabaseMode;
};

/** Directory scaffolding + configuration rendering. Returns the env file to run with. */
export async function runBootstrapConfig(deps: BootstrapDeps): Promise<BootstrapConfig> {
  const { io, layout } = deps;
  for (const dir of [
    layout.etcDir,
    layout.dataDir,
    layout.logsDir,
    layout.runDir,
    layout.backupsDir,
  ]) {
    await mkdir(dir, { recursive: true });
  }

  // The installer may pre-seed etc/eveland.env with machine facts (its
  // pinned EVELAND_NODE) before first boot. A *rendered* configuration is
  // recognized by its generated APP_SECRET_KEY: with one present the file is
  // reused verbatim (secrets are minted once); without one the render runs
  // and every pre-seeded key is preserved.
  let preSeeded: Record<string, string> = {};
  if (await deps.fileExists(layout.envFilePath)) {
    const existing = parseEnvFile(await readFile(layout.envFilePath, "utf8"));
    if (existing.APP_SECRET_KEY) {
      io.stdout(
        `Reusing existing configuration at ${layout.envFilePath} (secrets are minted once).`,
      );
      return {
        envFile: { path: layout.envFilePath, values: existing },
        // A resumed bootstrap already answered the question; an installation
        // from before it existed runs the bundled database.
        database: databaseMode(await readInstallMetadata(layout)),
      };
    }
    preSeeded = existing;
  }

  io.stdout("");
  io.stdout("First boot: this machine has no eveland configuration yet.");
  const inputs = await gatherBootstrapInputs(deps);
  const rendered = renderPlatformEnv({
    platform: deps.platform,
    applianceRoot: layout.root,
    inputs,
    random: deps.random,
  });
  const preservedKeys = Object.keys(preSeeded).filter((key) => !(key in rendered.values));
  if (preservedKeys.length > 0) {
    rendered.content += `\n# Preserved from the installer\n${preservedKeys
      .map((key) => `${key}=${preSeeded[key]}`)
      .join("\n")}\n`;
    for (const key of preservedKeys) rendered.values[key] = preSeeded[key]!;
  }
  await writeFile(layout.envFilePath, rendered.content, { mode: 0o600 });
  await chmod(layout.envFilePath, 0o600);
  io.stdout(`Wrote ${layout.envFilePath} (0600; all secrets freshly generated).`);
  io.stdout("");
  // The password itself never crosses stdout: this output is teed into the
  // install log by the installer, and a log must not hold credentials.
  io.stdout(`Dashboard admin login: ${inputs.adminEmail}`);
  io.stdout("  The generated password is recorded only in that file — read it with:");
  io.stdout(`  grep EVELAND_ADMIN_PASSWORD ${layout.envFilePath}`);
  io.stdout("");
  return {
    envFile: { path: layout.envFilePath, values: rendered.values },
    database: inputs.databaseUrl ? "external" : "bundled",
  };
}

/** Writes the checkout's channel + revision into the env file (and the in-memory values). */
export async function pinReleaseIdentity(
  execCommand: ExecCommand,
  repoRootDir: string,
  envFile: PlatformEnvFile,
): Promise<void> {
  const identity = await deriveReleaseIdentity(execCommand, repoRootDir);
  if (!identity) return;
  await upsertEnvFileValue(envFile.path, "EVELAND_RELEASE_CHANNEL", identity.channel);
  await upsertEnvFileValue(envFile.path, "EVELAND_REVISION", identity.revision);
  envFile.values.EVELAND_RELEASE_CHANNEL = identity.channel;
  envFile.values.EVELAND_REVISION = identity.revision;
}

/** Build + database preparation. Idempotent; safe to re-run after a failure. */
export async function runBootstrapPrepare(
  deps: BootstrapDeps,
  envFile: PlatformEnvFile,
  options: { buildWeb: boolean },
): Promise<void> {
  const { io } = deps;

  // Release identity: the exact short SHA, and a channel that is `stable`
  // only on an exact vX.Y.Z tag. Refreshed again by update.
  await pinReleaseIdentity(deps.execCommand, deps.repoRootDir, envFile);

  const childEnv = { ...io.env, ...envFile.values };

  if (
    options.buildWeb &&
    !(await deps.fileExists(path.join(deps.repoRootDir, "apps/web/.next/BUILD_ID")))
  ) {
    io.stdout("Building the Dashboard (first boot only; a few minutes)...");
    const code = await deps.streamCommand(["pnpm", "--filter", "@evelandhq/web", "build"], {
      cwd: deps.repoRootDir,
      env: childEnv,
    });
    if (code !== 0) throw new Error("The Dashboard build failed; see the output above.");
  }

  // Through the DSN the platform itself will use, not a port: Docker's port
  // proxy accepts connections before the postgres inside it finishes
  // starting, and the migration then dies on "the database system is starting
  // up". The same probe serves a bundled container and an operator's own
  // server, which is the point -- one gate, one truth.
  const databaseUrl = envFile.values.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set in the platform configuration.");
  const address = describeDatabaseAddress(databaseUrl) ?? "the configured address";
  io.stdout(`Waiting for Postgres at ${address}...`);
  const deadlineMs = 120_000;
  let up = false;
  for (let waited = 0; waited < deadlineMs; waited += 2_000) {
    if (await deps.pgReady(databaseUrl)) {
      up = true;
      break;
    }
    await deps.sleep(2_000);
  }
  if (!up) {
    throw new Error(
      `Postgres did not become ready at ${address} within ${deadlineMs / 1_000}s. ` +
        "For the bundled database check `docker compose ps` and `docker compose logs postgres`; " +
        "for your own server check that it is running and accepts connections from this host.",
    );
  }

  io.stdout("Applying database migrations...");
  let migrate: number | null = 1;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    migrate = await deps.streamCommand(["pnpm", "--filter", "@evelandhq/api", "db:migrate"], {
      cwd: deps.repoRootDir,
      env: childEnv,
    });
    if (migrate === 0) break;
    if (attempt < 3) {
      io.stdout(
        "Migration attempt failed; retrying in 3s (fresh Postgres may still be settling)...",
      );
      await deps.sleep(3_000);
    }
  }
  if (migrate !== 0) throw new Error("Database migration failed; see the output above.");
}
