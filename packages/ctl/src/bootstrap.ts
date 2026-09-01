import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { POSTGRES_HOST_PORT } from "@evelandhq/core/ports";
import {
  defaultBootstrapInputs,
  renderPlatformEnv,
  type BootstrapInputs,
} from "./config-render.ts";
import { parseEnvFile, upsertEnvFileValue, type PlatformEnvFile } from "./env-file.ts";
import type { ApplianceLayout, InstallMetadata } from "./home.ts";
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
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      const emit = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) print(`  ${line}`);
      };
      child.stdout.on("data", emit);
      child.stderr.on("data", emit);
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

  return { publicOrigin, adminEmail, adminPassword, anthropicApiKey, openaiApiKey };
}

export async function writeInstallMetadata(
  layout: ApplianceLayout,
  metadata: InstallMetadata,
): Promise<void> {
  await mkdir(layout.etcDir, { recursive: true });
  await writeFile(layout.installJsonPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

/** Directory scaffolding + configuration rendering. Returns the env file to run with. */
export async function runBootstrapConfig(deps: BootstrapDeps): Promise<PlatformEnvFile> {
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
      return { path: layout.envFilePath, values: existing };
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
  return { path: layout.envFilePath, values: rendered.values };
}

/** Build + database preparation. Idempotent; safe to re-run after a failure. */
export async function runBootstrapPrepare(
  deps: BootstrapDeps,
  envFile: PlatformEnvFile,
  options: {
    buildWeb: boolean;
    /** Full argv whose exit 0 means Postgres actually accepts connections. */
    pgReadyCommand: string[];
  },
): Promise<void> {
  const { io } = deps;

  // Release identity: pin the actual checkout revision so the About page
  // reports something better than "unknown". Refreshed again by update.
  const describe = await deps.execCommand(["git", "describe", "--tags", "--always"], {
    cwd: deps.repoRootDir,
  });
  if (describe.code === 0 && describe.output.trim() !== "") {
    const revision = describe.output.trim().split("\n")[0]!;
    await upsertEnvFileValue(envFile.path, "EVELAND_REVISION", revision);
    envFile.values.EVELAND_REVISION = revision;
  }

  const childEnv = { ...io.env, ...envFile.values };

  // The systemd production form builds the Dashboard inside its own
  // container; only the ctl-supervised form needs a host build.
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

  // A bare TCP probe is a FALSE ready signal here: Docker's port proxy
  // accepts connections before postgres inside finishes starting, and the
  // migration then dies on "the database system is starting up". Ask
  // postgres itself.
  io.stdout("Waiting for Postgres...");
  const deadlineMs = 120_000;
  let up = false;
  for (let waited = 0; waited < deadlineMs; waited += 2_000) {
    const ready = await deps.execCommand(options.pgReadyCommand, { cwd: deps.repoRootDir });
    if (ready.code === 0) {
      up = true;
      break;
    }
    await deps.sleep(2_000);
  }
  if (!up) {
    throw new Error(
      `Postgres did not become ready on 127.0.0.1:${POSTGRES_HOST_PORT}. Check \`docker compose ps\` and \`docker compose logs postgres\` in ${deps.repoRootDir}.`,
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
