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
  prompter?: Prompter;
  env?: NodeJS.ProcessEnv;
  webBuildExists?: boolean;
  postgresUp?: boolean;
  commandExit?: number | null;
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
    platform: "darwin",
    prompter: options.prompter ?? scriptedPrompter([]),
    streamCommand: async (argv) => {
      commands.push(argv);
      return options.commandExit ?? 0;
    },
    tcpProbe: async () => options.postgresUp ?? true,
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

  test("prompted answers win and the origin is normalized", async () => {
    const { deps } = await makeDeps({
      prompter: scriptedPrompter([
        "https://eveland.example.com/", // origin (trailing slash normalized away)
        "Ops@Example.com ", // email (lowercased, trimmed)
        "chosen-password-123", // password
        "sk-ant-typed", // anthropic key (interactive ask)
      ]),
    });
    const inputs = await gatherBootstrapInputs(deps);
    expect(inputs.publicOrigin).toBe("https://eveland.example.com");
    expect(inputs.adminEmail).toBe("ops@example.com");
    expect(inputs.adminPassword).toBe("chosen-password-123");
    expect(inputs.anthropicApiKey).toBe("sk-ant-typed");
  });

  test("a shell ANTHROPIC_API_KEY is offered and can be declined", async () => {
    const accepted = await makeDeps({
      env: { ANTHROPIC_API_KEY: "sk-ant-shell" },
      prompter: scriptedPrompter(["", "", "", true]),
    });
    expect((await gatherBootstrapInputs(accepted.deps)).anthropicApiKey).toBe("sk-ant-shell");

    const declined = await makeDeps({
      env: { ANTHROPIC_API_KEY: "sk-ant-shell" },
      prompter: scriptedPrompter(["", "", "", false]),
    });
    expect((await gatherBootstrapInputs(declined.deps)).anthropicApiKey).toBeUndefined();
  });

  test("a too-short admin password is rejected before anything is written", async () => {
    const { deps } = await makeDeps({ prompter: scriptedPrompter(["", "", "short"]) });
    await expect(gatherBootstrapInputs(deps)).rejects.toThrow(/at least 12 characters/);
  });
});

describe("runBootstrapConfig", () => {
  test("renders etc/eveland.env once (0600) and prints the admin login", async () => {
    const { deps, out, layout } = await makeDeps({});
    const envFile = await runBootstrapConfig(deps);
    expect(envFile.path).toBe(layout.envFilePath);
    const mode = (await stat(layout.envFilePath)).mode & 0o777;
    expect(mode).toBe(0o600);
    const onDisk = parseEnvFile(await readFile(layout.envFilePath, "utf8"));
    expect(onDisk).toEqual(envFile.values);
    expect(out.join("\n")).toContain("Password:");

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

describe("runBootstrapPrepare", () => {
  test("builds the Dashboard when missing and applies migrations with the rendered env", async () => {
    const { deps, commands } = await makeDeps({ webBuildExists: false });
    const envFile = await runBootstrapConfig(deps);
    await runBootstrapPrepare(deps, envFile);
    expect(commands).toEqual([
      ["pnpm", "--filter", "@evelandhq/web", "build"],
      ["pnpm", "--filter", "@evelandhq/api", "db:migrate"],
    ]);
  });

  test("skips the Dashboard build when one exists", async () => {
    const { deps, commands } = await makeDeps({ webBuildExists: true });
    const envFile = await runBootstrapConfig(deps);
    await runBootstrapPrepare(deps, envFile);
    expect(commands).toEqual([["pnpm", "--filter", "@evelandhq/api", "db:migrate"]]);
  });

  test("an unreachable Postgres fails with a compose hint instead of a migrate stack trace", async () => {
    const { deps } = await makeDeps({ webBuildExists: true, postgresUp: false });
    const envFile = await runBootstrapConfig(deps);
    await expect(runBootstrapPrepare(deps, envFile)).rejects.toThrow(/docker compose ps/);
  });

  test("a failing migration is a clear error", async () => {
    const { deps } = await makeDeps({ webBuildExists: true, commandExit: 1 });
    const envFile = await runBootstrapConfig(deps);
    await expect(runBootstrapPrepare(deps, envFile)).rejects.toThrow(/migration failed/);
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
