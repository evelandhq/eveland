import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { writeInstallMetadata } from "./bootstrap.ts";
import { applianceLayout } from "./home.ts";
import type { LifecycleIo } from "./io.ts";
import { PLATFORM_PROCESSES } from "./processes.ts";
import { writeSupervisorRecord, writeSupervisorState } from "./state-files.ts";
import { runUpdate, type PgDump } from "./update.ts";
import type { Prompter } from "./prompt.ts";

const CHANGELOG_AT_TARGET = `# Changelog

## [0.49.0](https://example.com) (2026-09-02)

### ⚠ BREAKING CHANGES

* **ctl:** the thing moved

### Features

* new stuff

## [0.48.0](https://example.com) (2026-08-31)

### Features

* old stuff
`;

type Harness = Awaited<ReturnType<typeof makeHarness>>;

async function makeHarness(
  options: {
    installed?: boolean;
    dirty?: boolean;
    breaking?: boolean;
    evePinAfter?: string;
    confirmAnswers?: boolean[];
  } = {},
) {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-update-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-updaterepo-"));
  const layout = applianceLayout(home);
  await mkdir(layout.etcDir, { recursive: true });
  await writeFile(
    layout.envFilePath,
    [
      "NODE_ENV=production",
      "APP_SECRET_KEY=k",
      "EVELAND_PUBLIC_ORIGIN=http://localhost:17300",
      "EVELAND_ADMIN_EMAIL=admin@example.com",
      "EVELAND_ADMIN_PASSWORD=long-enough-password",
      "DATABASE_URL=postgres://x",
    ].join("\n"),
    "utf8",
  );
  if (options.installed !== false) {
    await writeInstallMetadata(layout, {
      version: 1,
      installedAt: "2026-09-01T00:00:00.000Z",
      method: "install.sh",
      osMode: "darwin",
      bootstrapCompleted: true,
    });
  }
  // The "running" checkout: version 0.48.0, an eve pin, dependencies, web build.
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ version: "0.48.0" }), "utf8");
  await mkdir(path.join(repo, "templates/starter-agent"), { recursive: true });
  await writeFile(
    path.join(repo, "templates/starter-agent/package.json"),
    JSON.stringify({ dependencies: { eve: "0.47.6" } }),
    "utf8",
  );
  await mkdir(path.join(repo, "node_modules"), { recursive: true });
  await mkdir(path.join(repo, "apps/web/.next"), { recursive: true });
  await writeFile(path.join(repo, "apps/web/.next/BUILD_ID"), "x", "utf8");

  const out: string[] = [];
  const err: string[] = [];
  const gitCalls: string[][] = [];
  const streamed: string[][] = [];
  const pgDumps: string[] = [];
  const confirmQueue = [...(options.confirmAnswers ?? [])];
  const alivePids = new Set<number>();

  const prompter: Prompter = {
    interactive: true,
    ask: async (_q, d) => d,
    confirm: async (_q, d) => confirmQueue.shift() ?? d,
  };

  const io: LifecycleIo & { pgDump: PgDump } = {
    env: { EVELAND_HOME: home },
    platform: "darwin",
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    repoRootDir: repo,
    sleep: async () => {},
    prompter,
    isAlive: (pid) => alivePids.has(pid),
    processIdentity: async (pid) => (alivePids.has(pid) ? "id-" + pid : null),
    sendSignal: (pid) => alivePids.delete(pid),
    fetchImpl: async () => new Response("{}", { status: 200 }),
    tcpProbe: async () => true,
    spawnDaemon: async () => {
      await writeSupervisorRecord(layout, { pid: 4242, identity: "id-4242" });
      alivePids.add(4242);
      await writeSupervisorState(layout, {
        pid: 4242,
        startedAt: "2026-09-01T00:00:00.000Z",
        children: Object.fromEntries(
          PLATFORM_PROCESSES.map((spec) => [
            spec.key,
            { status: "running" as const, pid: 5000, restarts: 0, lastExit: null },
          ]),
        ),
      });
      alivePids.add(5000);
      return 4242;
    },
    streamCommand: async (argv) => {
      streamed.push(argv);
      return 0;
    },
    execCommand: async (argv) => {
      if (argv[0] === "git") {
        gitCalls.push(argv);
        const sub = argv[1];
        if (sub === "tag") return { code: 0, output: "v0.49.0\nv0.48.0\n" };
        if (sub === "show") {
          return options.breaking === false
            ? {
                code: 0,
                output:
                  "# Changelog\n\n## [0.49.0](x) (2026-09-02)\n\n### Features\n\n* only features\n",
              }
            : { code: 0, output: CHANGELOG_AT_TARGET };
        }
        if (sub === "describe") return { code: 0, output: "v0.49.0\n" };
        if (sub === "status") return { code: 0, output: options.dirty ? " M src/app.ts\n" : "" };
        if (sub === "checkout") {
          if (options.evePinAfter) {
            await writeFile(
              path.join(repo, "templates/starter-agent/package.json"),
              JSON.stringify({ dependencies: { eve: options.evePinAfter } }),
              "utf8",
            );
          }
          await writeFile(
            path.join(repo, "package.json"),
            JSON.stringify({ version: "0.49.0" }),
            "utf8",
          );
          return { code: 0, output: "" };
        }
        return { code: 0, output: "" };
      }
      // docker info / compose during restart
      return { code: 0, output: "ok" };
    },
    pgDump: async (backupPath) => {
      pgDumps.push(backupPath);
      await writeFile(backupPath, "-- dump", "utf8");
      return 0;
    },
  };
  return { io, out, err, gitCalls, streamed, pgDumps, layout, repo };
}

function gitSubcommands(harness: Harness): string[] {
  return harness.gitCalls.map((argv) => argv[1]!);
}

describe("runUpdate", () => {
  test("refuses a development checkout", async () => {
    const harness = await makeHarness({ installed: false });
    expect(await runUpdate([], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("git pull");
  });

  test("full pipeline: backup -> checkout -> install -> build -> migrate -> restart", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    expect(await runUpdate([], harness.io)).toBe(0);
    expect(harness.pgDumps).toHaveLength(1);
    expect(gitSubcommands(harness)).toContain("checkout");
    expect(harness.streamed).toEqual([
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "--filter", "@evelandhq/web", "build"],
      ["pnpm", "--filter", "@evelandhq/api", "db:migrate"],
    ]);
    expect(harness.out.join("\n")).toContain("Updated to v0.49.0.");
    // The backup landed in backups/ and names the version it protects.
    const backups = await readdir(harness.layout.backupsDir);
    expect(backups[0]).toContain("v0.48.0");
    // Release identity followed the checkout.
    const { readFile } = await import("node:fs/promises");
    const { parseEnvFile } = await import("./env-file.ts");
    const onDisk = parseEnvFile(await readFile(harness.layout.envFilePath, "utf8"));
    expect(onDisk.EVELAND_REVISION).toBe("v0.49.0");
    expect(onDisk.APP_SECRET_KEY).toBe("k");
  });

  test("breaking changes are shown and an unconfirmed update aborts before any backup or checkout", async () => {
    const harness = await makeHarness({ confirmAnswers: [false] });
    expect(await runUpdate([], harness.io)).toBe(1);
    expect(harness.out.join("\n")).toContain("BREAKING CHANGES");
    expect(harness.out.join("\n")).toContain("the thing moved");
    expect(harness.pgDumps).toHaveLength(0);
    expect(gitSubcommands(harness)).not.toContain("checkout");
  });

  test("--yes accepts breaking changes without a prompt", async () => {
    const harness = await makeHarness({ confirmAnswers: [] });
    expect(await runUpdate(["--yes"], harness.io)).toBe(0);
  });

  test("a clean upgrade path needs no confirmation at all", async () => {
    const harness = await makeHarness({ breaking: false, confirmAnswers: [] });
    expect(await runUpdate([], harness.io)).toBe(0);
  });

  test("already up to date is a calm no-op", async () => {
    const harness = await makeHarness({});
    expect(await runUpdate(["--version", "v0.48.0"], harness.io)).toBe(0);
    expect(harness.out.join("\n")).toContain("Already up to date");
    expect(harness.pgDumps).toHaveLength(0);
  });

  test("a failed pg_dump refuses to proceed", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    harness.io.pgDump = async () => 1;
    expect(await runUpdate([], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("refusing to update without a backup");
    expect(gitSubcommands(harness)).not.toContain("checkout");
  });

  test("a clean tree is never stashed", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    expect(await runUpdate([], harness.io)).toBe(0);
    expect(harness.gitCalls.some((argv) => argv[1] === "stash")).toBe(false);
  });

  test("a dirty tree is stashed by name and offered back afterwards", async () => {
    const dirty = await makeHarness({ dirty: true, confirmAnswers: [true, true] });
    expect(await runUpdate([], dirty.io)).toBe(0);
    const stashPush = dirty.gitCalls.find((argv) => argv[1] === "stash" && argv[2] === "push");
    expect(stashPush).toBeDefined();
    expect(stashPush!.join(" ")).toContain("eveland-ctl-update-");
    expect(dirty.gitCalls.some((argv) => argv[1] === "stash" && argv[2] === "pop")).toBe(true);
  });

  test("an eve-window move warns loudly about rebuild+promote", async () => {
    const harness = await makeHarness({ evePinAfter: "0.48.0", confirmAnswers: [true, false] });
    expect(await runUpdate([], harness.io)).toBe(0);
    expect(harness.out.join("\n")).toContain("eve window moved");
    expect(harness.out.join("\n")).toContain("redeploy and promote EVERY project");
  });

  test("no window move, no warning", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    expect(await runUpdate([], harness.io)).toBe(0);
    expect(harness.out.join("\n")).not.toContain("eve window moved");
  });
});
