import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import type { Prompter } from "./prompt.ts";

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
  platform?: "darwin" | "linux";
  prompter?: Prompter;
  env?: NodeJS.ProcessEnv;
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
    platform: options.platform ?? "linux",
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
        false, // no existing PostgreSQL: run the bundled one
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

  test("an EVELAND_ADMIN_PASSWORD already in the environment wins over generation", async () => {
    const { deps } = await makeDeps({ env: { EVELAND_ADMIN_PASSWORD: "operator-chosen-pw" } });
    expect((await gatherBootstrapInputs(deps)).adminPassword).toBe("operator-chosen-pw");
  });

  test("a shell ANTHROPIC_API_KEY is offered and can be declined", async () => {
    const accepted = await makeDeps({
      env: { ANTHROPIC_API_KEY: "sk-ant-shell" },
      prompter: scriptedPrompter(["", "", false, true]),
    });
    expect((await gatherBootstrapInputs(accepted.deps)).anthropicApiKey).toBe("sk-ant-shell");

    const declined = await makeDeps({
      env: { ANTHROPIC_API_KEY: "sk-ant-shell" },
      prompter: scriptedPrompter(["", "", false, false]),
    });
    expect((await gatherBootstrapInputs(declined.deps)).anthropicApiKey).toBeUndefined();
  });

  test("macOS is never asked: its Deployments need the bundled database's two views", async () => {
    const { deps } = await makeDeps({
      platform: "darwin",
      env: { DATABASE_URL: "postgres://ops:pw@db.internal:5432/eveland" },
      prompter: scriptedPrompter(["", "", "sk-ant-typed"]),
    });
    const inputs = await gatherBootstrapInputs(deps);
    expect(inputs.databaseUrl).toBeUndefined();
    // And the queue was not consumed by a question that never ran.
    expect(inputs.anthropicApiKey).toBe("sk-ant-typed");
  });

  test("the bundled database is the default, and needs no connection check", async () => {
    const probed: string[] = [];
    const { deps } = await makeDeps({});
    deps.pgReady = async (url) => {
      probed.push(url);
      return true;
    };
    expect((await gatherBootstrapInputs(deps)).databaseUrl).toBeUndefined();
    // Nothing exists to connect to yet: the bundled container starts later.
    expect(probed).toEqual([]);
  });

  test("an operator's own PostgreSQL is taken, and proved reachable before anything is written", async () => {
    const dsn = "postgres://ops:s3cr3t@db.internal:5432/eveland";
    const probed: string[] = [];
    const { deps, out } = await makeDeps({
      prompter: scriptedPrompter(["", "", true, dsn, false]),
    });
    deps.pgReady = async (url) => {
      probed.push(url);
      return true;
    };

    expect((await gatherBootstrapInputs(deps)).databaseUrl).toBe(dsn);
    expect(probed).toEqual([dsn]);
    // The address, never the DSN: this output is teed into the install log.
    expect(out.join("\n")).toContain("db.internal:5432");
    expect(out.join("\n")).not.toContain("s3cr3t");
  });

  test("a named server that does not answer stops the install rather than falling back", async () => {
    // An automatic fall back to the bundled database is how an installation
    // ends up with a second cluster holding half its data.
    const { deps } = await makeDeps({
      prompter: scriptedPrompter(["", "", true, "postgres://ops@db.internal:5432/eveland"]),
      postgresUp: false,
    });
    await expect(gatherBootstrapInputs(deps)).rejects.toThrow(/No PostgreSQL answered/);
  });

  test("a DATABASE_URL already in the shell is offered, and can be declined", async () => {
    const dsn = "postgres://ops:pw@db.internal:5432/eveland";
    const accepted = await makeDeps({ env: { DATABASE_URL: dsn } });
    expect((await gatherBootstrapInputs(accepted.deps)).databaseUrl).toBe(dsn);

    const declined = await makeDeps({
      env: { DATABASE_URL: dsn },
      prompter: scriptedPrompter(["", "", false]),
    });
    expect((await gatherBootstrapInputs(declined.deps)).databaseUrl).toBeUndefined();
  });

  test("what is not a connection URL is refused, not written into the configuration", async () => {
    const { deps } = await makeDeps({
      prompter: scriptedPrompter(["", "", true, "localhost:5432"]),
    });
    await expect(gatherBootstrapInputs(deps)).rejects.toThrow(/connection URL/);
  });

  test("a too-short environment-provided admin password is rejected before anything is written", async () => {
    const { deps } = await makeDeps({ env: { EVELAND_ADMIN_PASSWORD: "short" } });
    await expect(gatherBootstrapInputs(deps)).rejects.toThrow(/at least 12 characters/);
  });
});

describe("runBootstrapConfig", () => {
  test("renders etc/eveland.env once (0600); the password never crosses stdout", async () => {
    const { deps, out, layout } = await makeDeps({});
    const { envFile } = await runBootstrapConfig(deps);
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
    const { envFile: again } = await runBootstrapConfig(deps);
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

  test("the external-database answer is recorded before the configuration it describes", async () => {
    // The two writes are not atomic. A crash between them used to leave a
    // rendered eveland.env with no record, and the resume defaulted to
    // "bundled" — starting a second cluster beside the operator's own and
    // pointing every later `update` backup at the empty one.
    const dsn = "postgres://user:pw@db.example.com:5432/eveland";
    const { deps, layout } = await makeDeps({
      prompter: scriptedPrompter(["", "", true, dsn]),
    });
    const { database } = await runBootstrapConfig(deps);
    expect(database).toBe("external");
    expect((await readInstallMetadata(layout))?.database).toBe("external");

    // And the resume reads it back rather than guessing.
    expect((await runBootstrapConfig(deps)).database).toBe("external");
  });

  test("a rendered configuration whose answer was never recorded refuses to guess", async () => {
    const { deps, layout } = await makeDeps({});
    await runBootstrapConfig(deps);
    // Exactly the crash window as it looks on a machine bootstrapped by the
    // older code: configuration on disk, no record of which database it uses.
    await rm(layout.installJsonPath);
    await expect(runBootstrapConfig(deps)).rejects.toThrow(/did not finish/);
  });

  test("a completed install from before the question existed still means bundled", async () => {
    const { deps, layout } = await makeDeps({});
    await runBootstrapConfig(deps);
    const metadata = await readInstallMetadata(layout);
    await writeInstallMetadata(layout, {
      ...metadata!,
      bootstrapCompleted: true,
      database: undefined,
    });
    expect((await runBootstrapConfig(deps)).database).toBe("bundled");
  });
});

describe("runBootstrapConfig with an installer-pre-seeded file", () => {
  test("a file holding only machine facts (EVELAND_NODE) still gets a full render, preserving them", async () => {
    const { deps, layout } = await makeDeps({});
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(layout.etcDir, { recursive: true });
    await writeFile(layout.envFilePath, "EVELAND_NODE=/opt/eveland/node/bin/node\n", "utf8");

    const { envFile } = await runBootstrapConfig(deps);
    // The render happened (a pre-seeded file has no APP_SECRET_KEY)...
    expect(envFile.values.APP_SECRET_KEY).toBeTruthy();
    expect(envFile.values.NODE_ENV).toBe("production");
    // ...and the installer's pin survived, in memory and on disk.
    expect(envFile.values.EVELAND_NODE).toBe("/opt/eveland/node/bin/node");
    const onDisk = parseEnvFile(await readFile(layout.envFilePath, "utf8"));
    expect(onDisk.EVELAND_NODE).toBe("/opt/eveland/node/bin/node");
    expect(onDisk.APP_SECRET_KEY).toBe(envFile.values.APP_SECRET_KEY);

    // A third run now sees a rendered config and reuses it verbatim.
    const { envFile: again } = await runBootstrapConfig(deps);
    expect(again.values.APP_SECRET_KEY).toBe(envFile.values.APP_SECRET_KEY);
    expect(again.values.EVELAND_NODE).toBe("/opt/eveland/node/bin/node");
  });
});

describe("runBootstrapPrepare", () => {
  test("builds the Dashboard when missing and applies migrations with the rendered env", async () => {
    const { deps, commands } = await makeDeps({ webBuildExists: false });
    const { envFile } = await runBootstrapConfig(deps);
    await runBootstrapPrepare(deps, envFile, { buildWeb: true });
    expect(commands).toEqual([
      ["pnpm", "--filter", "@evelandhq/web", "build"],
      ["pnpm", "--filter", "@evelandhq/api", "db:migrate"],
    ]);
  });

  test("skips the Dashboard build when one exists", async () => {
    const { deps, commands } = await makeDeps({ webBuildExists: true });
    const { envFile } = await runBootstrapConfig(deps);
    await runBootstrapPrepare(deps, envFile, { buildWeb: true });
    expect(commands).toEqual([["pnpm", "--filter", "@evelandhq/api", "db:migrate"]]);
  });

  test("pins release identity: exact short SHA, and stable only on an exact release tag", async () => {
    const { deps, layout } = await makeDeps({ webBuildExists: true });
    const { envFile } = await runBootstrapConfig(deps);
    await runBootstrapPrepare(deps, envFile, { buildWeb: true });
    expect(envFile.values.EVELAND_REVISION).toBe("abc1234");
    expect(envFile.values.EVELAND_RELEASE_CHANNEL).toBe("stable");
    const onDisk = parseEnvFile(await readFile(layout.envFilePath, "utf8"));
    expect(onDisk.EVELAND_REVISION).toBe("abc1234");
    // The upsert touched exactly one key: secrets survived byte-for-byte.
    expect(onDisk.APP_SECRET_KEY).toBe(envFile.values.APP_SECRET_KEY);
  });

  test("an unreachable Postgres fails with a repair hint instead of a migrate stack trace", async () => {
    const { deps } = await makeDeps({ webBuildExists: true, postgresUp: false });
    const { envFile } = await runBootstrapConfig(deps);
    await expect(runBootstrapPrepare(deps, envFile, { buildWeb: true })).rejects.toThrow(
      /did not become ready/,
    );
  });

  test("a failing migration is a clear error", async () => {
    const { deps } = await makeDeps({ webBuildExists: true, commandExit: 1 });
    const { envFile } = await runBootstrapConfig(deps);
    await expect(runBootstrapPrepare(deps, envFile, { buildWeb: true })).rejects.toThrow(
      /migration failed/,
    );
  });
});

describe("runBootstrapPrepare on a non-release checkout", () => {
  test("a bare SHA / branch checkout is `edge`, never impersonating a stable release", async () => {
    const { deps } = await makeDeps({ webBuildExists: true, onTag: false });
    const { envFile } = await runBootstrapConfig(deps);
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
    await writeInstallMetadata(layout, { ...metadata, bootstrapCompleted: true });
    expect((await readInstallMetadata(layout))?.bootstrapCompleted).toBe(true);
  });
});
