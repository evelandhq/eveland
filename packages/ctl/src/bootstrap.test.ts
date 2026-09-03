import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  gatherBootstrapInputs,
  runBootstrapConfig,
  runBootstrapPrepare,
  writeInstallMetadata,
  type BootstrapDeps,
} from "./bootstrap.ts";
import { parseEnvFile } from "./env-file.ts";
import { applianceLayout, readInstallMetadata } from "./home.ts";
import type { DatabaseForm } from "./config-render.ts";
import type { Prompter } from "./prompt.ts";

const PLATFORM_DB = "postgres://eveland:secret@db.internal:5432/eveland";
const WORLD_DB = "postgres://eveland:secret@db.internal:5432/eveland_workflow";

function scriptedPrompter(answers: Array<string | boolean>): Prompter {
  const queue = [...answers];
  return {
    interactive: true,
    ask: async (_question, defaultValue) => {
      const next = queue.shift();
      // Mirrors the real prompter: an empty answer takes the default.
      return typeof next === "string" && next !== "" ? next : defaultValue;
    },
    confirm: async (_question, defaultValue) => {
      const next = queue.shift();
      return typeof next === "boolean" ? next : defaultValue;
    },
  };
}

async function makeDeps(options: {
  prompter?: Prompter;
  env?: NodeJS.ProcessEnv;
  platform?: "darwin" | "linux";
  databaseForm?: DatabaseForm;
  webBuildExists?: boolean;
  postgresUp?: boolean;
  commandExit?: number | null;
  onTag?: boolean;
}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-bootstrap-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-bootstraprepo-"));
  const layout = applianceLayout(home);
  const out: string[] = [];
  const commands: string[][] = [];
  const deps: BootstrapDeps = {
    io: {
      env: options.env ?? {},
      stdout: (line) => out.push(line),
      stderr: (line) => out.push(line),
    },
    layout,
    repoRootDir: repo,
    platform: options.platform ?? "darwin",
    // What lifecycle decides for these platforms by default: Linux first boot
    // lands on the production form, macOS on the ctl supervisor.
    databaseForm:
      options.databaseForm ?? ((options.platform ?? "darwin") === "linux" ? "external" : "compose"),
    prompter: options.prompter ?? scriptedPrompter([]),
    streamCommand: async (argv) => {
      commands.push(argv);
      return options.commandExit ?? 0;
    },
    execCommand: async (argv) => {
      if (argv[0] === "git" && argv[1] === "rev-parse") return { code: 0, output: "abc1234\n" };
      if (argv[0] === "git" && argv[1] === "describe") {
        return options.onTag === false
          ? { code: 128, output: "fatal: no tag exactly matches" }
          : { code: 0, output: "v0.48.0\n" };
      }
      return { code: 0, output: "" };
    },
    tcpProbe: async () => options.postgresUp ?? true,
    pgReady: async () => options.postgresUp ?? true,
    sleep: async () => {},
    fileExists: async (filePath) => {
      if (filePath.endsWith("BUILD_ID")) return options.webBuildExists ?? false;
      try {
        await stat(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };
  return { deps, out, commands, layout, home, repo };
}

describe("gatherBootstrapInputs", () => {
  test("non-interactive runs take every default and generate a password", async () => {
    const { deps } = await makeDeps({});
    const inputs = await gatherBootstrapInputs(deps);
    expect(inputs.publicOrigin).toBe("http://localhost:17300");
    expect(inputs.adminEmail).toBe("admin@example.com");
    expect(inputs.adminPassword.length).toBeGreaterThanOrEqual(12);
    expect(inputs.anthropicApiKey).toBeUndefined();
  });

  test("prompted answers win and the origin is normalized; the password is never a prompt", async () => {
    const { deps } = await makeDeps({
      prompter: scriptedPrompter([
        "https://eveland.example.com/", // origin (trailing slash normalized away)
        "Ops@Example.com ", // email (lowercased, trimmed)
        "sk-ant-typed", // anthropic key (interactive ask)
      ]),
    });
    const inputs = await gatherBootstrapInputs(deps);
    expect(inputs.publicOrigin).toBe("https://eveland.example.com");
    expect(inputs.adminEmail).toBe("ops@example.com");
    // A prompted password would be echoed into the teed install log; it is
    // always generated (or taken from the environment) instead.
    expect(inputs.adminPassword.length).toBeGreaterThanOrEqual(12);
    expect(inputs.anthropicApiKey).toBe("sk-ant-typed");
  });

  test("the Compose form is never asked about a database it does not choose", async () => {
    // ctl supervises that Postgres and owns both of its addresses. Accepting an
    // answer here pointed the platform at one cluster while ctl kept starting
    // another -- and on macOS the Agents' view was silently replaced by the
    // platform's, splitting the World across two databases.
    const asked: string[] = [];
    const { deps } = await makeDeps({
      prompter: {
        interactive: true,
        ask: async (question, defaultValue) => {
          asked.push(question);
          return defaultValue;
        },
        confirm: async (_question, defaultValue) => defaultValue,
      },
    });
    const inputs = await gatherBootstrapInputs(deps);
    expect(asked.some((question) => /database/i.test(question))).toBe(false);
    expect(inputs.databaseUrl).toBe("postgres://eveland:eveland@127.0.0.1:17310/eveland");
    expect(inputs.workflowWorldUrl).toBe(
      "postgres://eveland:eveland@host.docker.internal:17310/eveland",
    );
  });

  test("the external form asks, and never echoes the address it already has", async () => {
    // The prompt writes to stderr and the installer tees stderr into
    // logs/install.log, so a DSN offered as a default would persist its
    // password there. Only host and port are shown; a blank answer keeps it.
    const asked: string[] = [];
    const { deps } = await makeDeps({
      platform: "linux",
      env: { DATABASE_URL: PLATFORM_DB, EVELAND_WORKFLOW_WORLD_URL: WORLD_DB },
      prompter: {
        interactive: true,
        ask: async (question, defaultValue) => {
          asked.push(question);
          // Blank only where the point is that a blank answer keeps what the
          // installation already has.
          return /database/i.test(question) ? "" : defaultValue;
        },
        confirm: async (_question, defaultValue) => defaultValue,
      },
    });
    const inputs = await gatherBootstrapInputs(deps);
    expect(inputs.databaseUrl).toBe(PLATFORM_DB);
    expect(inputs.workflowWorldUrl).toBe(WORLD_DB);
    const databaseQuestions = asked.filter((question) => /database/i.test(question));
    expect(databaseQuestions.length).toBe(2);
    for (const question of databaseQuestions) {
      expect(question).toContain("db.internal:5432");
      expect(question).not.toContain("secret");
    }
  });

  test("a typed address wins over the exported one", async () => {
    const typed = "postgres://eveland:other@elsewhere.internal:5432/eveland";
    const { deps } = await makeDeps({
      platform: "linux",
      env: { DATABASE_URL: PLATFORM_DB, EVELAND_WORKFLOW_WORLD_URL: WORLD_DB },
      prompter: scriptedPrompter([
        "http://localhost:17300", // origin
        typed, // platform database
        "", // shared world: blank keeps the exported one
        "admin@example.com",
      ]),
    });
    const inputs = await gatherBootstrapInputs(deps);
    expect(inputs.databaseUrl).toBe(typed);
    expect(inputs.workflowWorldUrl).toBe(WORLD_DB);
  });

  test("an EVELAND_ADMIN_PASSWORD already in the environment wins over generation", async () => {
    const { deps } = await makeDeps({
      env: { EVELAND_ADMIN_PASSWORD: "operator-chosen-pw" },
    });
    expect((await gatherBootstrapInputs(deps)).adminPassword).toBe("operator-chosen-pw");
  });

  test("a shell ANTHROPIC_API_KEY is offered and can be declined", async () => {
    const accepted = await makeDeps({
      env: { ANTHROPIC_API_KEY: "sk-ant-shell" },
      prompter: scriptedPrompter(["", "", true]),
    });
    expect((await gatherBootstrapInputs(accepted.deps)).anthropicApiKey).toBe("sk-ant-shell");

    const declined = await makeDeps({
      env: { ANTHROPIC_API_KEY: "sk-ant-shell" },
      prompter: scriptedPrompter(["", "", false]),
    });
    expect((await gatherBootstrapInputs(declined.deps)).anthropicApiKey).toBeUndefined();
  });

  test("a too-short environment-provided admin password is rejected before anything is written", async () => {
    const { deps } = await makeDeps({
      env: { EVELAND_ADMIN_PASSWORD: "short" },
    });
    await expect(gatherBootstrapInputs(deps)).rejects.toThrow(/at least 12 characters/);
  });

  test("Linux with no database in the environment names the variable to export", async () => {
    // The form has no database of its own to default to, and a non-interactive
    // install answers the question by exporting the variable — so the error
    // has to be the variable name, not "answer the prompt".
    const { deps } = await makeDeps({ platform: "linux" });
    await expect(gatherBootstrapInputs(deps)).rejects.toThrow(
      /DATABASE_URL must be a Postgres connection URL[^]*set DATABASE_URL in the environment/,
    );
  });

  test("Linux adopts the addresses a non-interactive install exported", async () => {
    const { deps } = await makeDeps({
      platform: "linux",
      env: {
        DATABASE_URL: "postgres://eveland:secret@db.internal:5432/eveland",
        EVELAND_WORKFLOW_WORLD_URL: "postgres://eveland:secret@db.internal:5432/eveland_workflow",
      },
    });
    const inputs = await gatherBootstrapInputs(deps);
    expect(inputs.databaseUrl).toBe("postgres://eveland:secret@db.internal:5432/eveland");
    expect(inputs.workflowWorldUrl).toBe(
      "postgres://eveland:secret@db.internal:5432/eveland_workflow",
    );
  });

  test("an answer that is not a Postgres URL is refused, naming its variable", async () => {
    const { deps } = await makeDeps({
      platform: "linux",
      env: {
        DATABASE_URL: "postgres://eveland:secret@db.internal:5432/eveland",
        EVELAND_WORKFLOW_WORLD_URL: "db.internal:5432/eveland_workflow",
      },
    });
    await expect(gatherBootstrapInputs(deps)).rejects.toThrow(
      /EVELAND_WORKFLOW_WORLD_URL must be a Postgres connection URL/,
    );
  });
});

describe("runBootstrapConfig", () => {
  test("renders etc/eveland.env once (0600); the password never crosses stdout", async () => {
    const { deps, out, layout } = await makeDeps({});
    const envFile = await runBootstrapConfig(deps);
    expect(envFile.path).toBe(layout.envFilePath);
    const mode = (await stat(layout.envFilePath)).mode & 0o777;
    expect(mode).toBe(0o600);
    const onDisk = parseEnvFile(await readFile(layout.envFilePath, "utf8"));
    expect(onDisk).toEqual(envFile.values);
    // Output is teed into the install log by the installer: the password
    // value must not appear in it — only the pointer to the 0600 file.
    expect(out.join("\n")).not.toContain(envFile.values.EVELAND_ADMIN_PASSWORD);
    expect(out.join("\n")).toContain("grep EVELAND_ADMIN_PASSWORD");

    // Second run reuses the file verbatim: secrets are minted exactly once.
    const again = await runBootstrapConfig(deps);
    expect(again.values.APP_SECRET_KEY).toBe(envFile.values.APP_SECRET_KEY);
    expect(out.join("\n")).toContain("Reusing existing configuration");
  });

  test("scaffolds the appliance directories", async () => {
    const { deps, layout } = await makeDeps({});
    await runBootstrapConfig(deps);
    for (const dir of [layout.dataDir, layout.logsDir, layout.runDir, layout.backupsDir]) {
      await expect(stat(dir)).resolves.toBeDefined();
    }
  });
});

describe("runBootstrapConfig with an installer-pre-seeded file", () => {
  test("a file holding only machine facts (EVELAND_NODE) still gets a full render, preserving them", async () => {
    const { deps, layout } = await makeDeps({});
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(layout.etcDir, { recursive: true });
    await writeFile(layout.envFilePath, "EVELAND_NODE=/opt/eveland/node/bin/node\n", "utf8");

    const envFile = await runBootstrapConfig(deps);
    // The render happened (a pre-seeded file has no APP_SECRET_KEY)...
    expect(envFile.values.APP_SECRET_KEY).toBeTruthy();
    expect(envFile.values.NODE_ENV).toBe("production");
    // ...and the installer's pin survived, in memory and on disk.
    expect(envFile.values.EVELAND_NODE).toBe("/opt/eveland/node/bin/node");
    const onDisk = parseEnvFile(await readFile(layout.envFilePath, "utf8"));
    expect(onDisk.EVELAND_NODE).toBe("/opt/eveland/node/bin/node");
    expect(onDisk.APP_SECRET_KEY).toBe(envFile.values.APP_SECRET_KEY);

    // A third run now sees a rendered config and reuses it verbatim.
    const again = await runBootstrapConfig(deps);
    expect(again.values.APP_SECRET_KEY).toBe(envFile.values.APP_SECRET_KEY);
    expect(again.values.EVELAND_NODE).toBe("/opt/eveland/node/bin/node");
  });
});

describe("runBootstrapPrepare", () => {
  test("builds the Dashboard when missing and applies migrations with the rendered env", async () => {
    const { deps, commands } = await makeDeps({ webBuildExists: false });
    const envFile = await runBootstrapConfig(deps);
    await runBootstrapPrepare(deps, envFile, { buildWeb: true });
    expect(commands).toEqual([
      ["pnpm", "--filter", "@evelandhq/web", "build"],
      ["pnpm", "--filter", "@evelandhq/api", "db:migrate"],
    ]);
  });

  test("skips the Dashboard build when one exists", async () => {
    const { deps, commands } = await makeDeps({ webBuildExists: true });
    const envFile = await runBootstrapConfig(deps);
    await runBootstrapPrepare(deps, envFile, { buildWeb: true });
    expect(commands).toEqual([["pnpm", "--filter", "@evelandhq/api", "db:migrate"]]);
  });

  test("pins release identity: exact short SHA, and stable only on an exact release tag", async () => {
    const { deps, layout } = await makeDeps({ webBuildExists: true });
    const envFile = await runBootstrapConfig(deps);
    await runBootstrapPrepare(deps, envFile, { buildWeb: true });
    expect(envFile.values.EVELAND_REVISION).toBe("abc1234");
    expect(envFile.values.EVELAND_RELEASE_CHANNEL).toBe("stable");
    const onDisk = parseEnvFile(await readFile(layout.envFilePath, "utf8"));
    expect(onDisk.EVELAND_REVISION).toBe("abc1234");
    // The upsert touched exactly one key: secrets survived byte-for-byte.
    expect(onDisk.APP_SECRET_KEY).toBe(envFile.values.APP_SECRET_KEY);
  });

  test("an unreachable Postgres names the address and DATABASE_URL, not a migrate stack trace", async () => {
    const { deps, layout } = await makeDeps({
      webBuildExists: true,
      postgresUp: false,
    });
    const envFile = await runBootstrapConfig(deps);
    await expect(runBootstrapPrepare(deps, envFile, { buildWeb: true })).rejects.toThrow(
      new RegExp(`did not accept connections[^]*DATABASE_URL in ${layout.envFilePath}`),
    );
  });

  test("a failing migration is a clear error", async () => {
    const { deps } = await makeDeps({ webBuildExists: true, commandExit: 1 });
    const envFile = await runBootstrapConfig(deps);
    await expect(runBootstrapPrepare(deps, envFile, { buildWeb: true })).rejects.toThrow(
      /migration failed/,
    );
  });
});

describe("runBootstrapPrepare on a non-release checkout", () => {
  test("a bare SHA / branch checkout is `edge`, never impersonating a stable release", async () => {
    const { deps } = await makeDeps({ webBuildExists: true, onTag: false });
    const envFile = await runBootstrapConfig(deps);
    await runBootstrapPrepare(deps, envFile, { buildWeb: true });
    expect(envFile.values.EVELAND_RELEASE_CHANNEL).toBe("edge");
    expect(envFile.values.EVELAND_REVISION).toBe("abc1234");
  });
});

describe("install metadata", () => {
  test("round-trips through write and read", async () => {
    const { layout } = await makeDeps({});
    const metadata = {
      version: 1,
      installedAt: "2026-09-01T00:00:00.000Z",
      method: "manual" as const,
      osMode: "darwin" as const,
      bootstrapCompleted: false,
    };
    await writeInstallMetadata(layout, metadata);
    expect(await readInstallMetadata(layout)).toEqual(metadata);
    await writeInstallMetadata(layout, {
      ...metadata,
      bootstrapCompleted: true,
    });
    expect((await readInstallMetadata(layout))?.bootstrapCompleted).toBe(true);
  });
});
