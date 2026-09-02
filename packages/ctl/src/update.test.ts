import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { writeInstallMetadata } from "./bootstrap.ts";
import { parseEnvFile } from "./env-file.ts";
import { applianceLayout } from "./home.ts";
import type { LifecycleIo } from "./io.ts";
import { PLATFORM_PROCESSES } from "./processes.ts";
import type { Prompter } from "./prompt.ts";
import { writeSupervisorRecord, writeSupervisorState } from "./state-files.ts";
import { runStart } from "./lifecycle.ts";
import { acquireMutex } from "./state-files.ts";
import {
  defaultPgDump,
  isForwardMove,
  newestStableTag,
  pendingUpdatePath,
  readPendingUpdate,
  recoveryPlan,
  runFinishUpdate,
  runUpdate,
  updateMutexPath,
  type PgDump,
} from "./update.ts";

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
    supervision?: "ctl" | "systemd";
    dirty?: boolean;
    breaking?: boolean;
    evePinAfter?: string;
    confirmAnswers?: boolean[];
    /** What `git describe --tags --exact-match` answers after the checkout. */
    tagAfter?: string | null;
    /** `git rev-parse refs/stash` fails (the sha could not be recorded). */
    stashRefUnknown?: boolean;
  } = {},
) {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-update-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-updaterepo-"));
  const unitDir = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-updateunits-"));
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
      "EVELAND_RELEASE_CHANNEL=stable",
      "EVELAND_REVISION=0000000",
    ].join("\n"),
    "utf8",
  );
  if (options.installed !== false) {
    await writeInstallMetadata(layout, {
      version: 1,
      installedAt: "2026-09-01T00:00:00.000Z",
      method: "install.sh",
      osMode: options.supervision === "systemd" ? "linux" : "darwin",
      bootstrapCompleted: true,
      supervision: options.supervision ?? "ctl",
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
  const timeline: string[] = [];
  const written: Record<string, string> = {};
  const confirmQueue = [...(options.confirmAnswers ?? [])];
  const alivePids = new Set<number>();
  let checkedOut = false;
  let pushedStashName = "eveland-ctl-update-unknown";
  // The platform is RUNNING when an update begins.
  alivePids.add(4242);
  await writeSupervisorRecord(layout, { pid: 4242, identity: "id-4242" });

  const prompter: Prompter = {
    interactive: true,
    ask: async (_q, d) => d,
    confirm: async (_q, d) => confirmQueue.shift() ?? d,
  };

  const io: LifecycleIo & {
    pgDump: PgDump;
    systemdUnitDir: string;
    writeTextFile: (filePath: string, content: string) => Promise<void>;
  } = {
    env: { EVELAND_HOME: home },
    platform: options.supervision === "systemd" ? "linux" : "darwin",
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    repoRootDir: repo,
    sleep: async () => {},
    prompter,
    isAlive: (pid) => alivePids.has(pid),
    processIdentity: async (pid) => (alivePids.has(pid) ? "id-" + pid : null),
    sendSignal: (pid) => {
      timeline.push("stop-signal");
      alivePids.delete(pid);
    },
    fetchImpl: async () => new Response("{}", { status: 200 }),
    tcpProbe: async () => true,
    getuid: () => 0,
    systemdUnitDir: unitDir,
    writeTextFile: async (filePath, content) => {
      written[filePath] = content;
      await writeFile(filePath, content, "utf8");
    },
    spawnDaemon: async () => {
      timeline.push("start-daemon");
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
      if (argv.includes("_finish-update")) timeline.push("finish-update");
      return 0;
    },
    execCommand: async (argv) => {
      if (argv[0] === "git") {
        gitCalls.push(argv);
        const sub = argv[1];
        if (sub === "tag") return { code: 0, output: "v0.50.0-rc.1\nv0.49.0\nv0.48.0\nv0.47.0\n" };
        if (sub === "rev-parse" && argv[2] !== "refs/stash")
          return { code: 0, output: checkedOut ? "beef049\n" : "abc0480\n" };
        if (sub === "show") {
          return options.breaking === false
            ? {
                code: 0,
                output:
                  "# Changelog\n\n## [0.49.0](x) (2026-09-02)\n\n### Features\n\n* only features\n",
              }
            : { code: 0, output: CHANGELOG_AT_TARGET };
        }
        if (sub === "describe") {
          const tag = options.tagAfter === undefined ? "v0.49.0" : options.tagAfter;
          return tag ? { code: 0, output: `${tag}\n` } : { code: 128, output: "fatal: no tag" };
        }
        if (sub === "status") return { code: 0, output: options.dirty ? " M src/app.ts\n" : "" };
        if (sub === "rev-parse" && argv[2] === "refs/stash")
          return options.stashRefUnknown
            ? { code: 128, output: "fatal: ambiguous argument 'refs/stash'" }
            : { code: 0, output: "5745a5h\n" };
        if (sub === "stash" && argv[2] === "push") pushedStashName = argv[argv.length - 1]!;
        if (sub === "stash" && argv[2] === "apply") timeline.push("stash-apply");
        if (sub === "stash" && argv[2] === "list")
          return {
            code: 0,
            output:
              "0ther000 stash@{0} On main: the operator's own later stash\n" +
              `5745a5h stash@{1} On main: ${pushedStashName}\n`,
          };
        if (sub === "checkout") {
          timeline.push("checkout");
          checkedOut = true;
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
      if (argv[0] === "systemctl") {
        timeline.push(`systemctl ${argv[1]}`);
        if (argv[1] === "is-active") return { code: 0, output: "active\n" };
      }
      // docker info / compose during start
      return { code: 0, output: "ok" };
    },
    pgDump: async (backupPath) => {
      pgDumps.push(backupPath);
      await writeFile(backupPath, "-- dump", "utf8");
      return 0;
    },
  };
  return { io, out, err, gitCalls, streamed, pgDumps, timeline, written, layout, repo, unitDir };
}

function gitSubcommands(harness: Harness): string[] {
  return harness.gitCalls.map((argv) => argv[1]!);
}

function finishUpdateCall(harness: Harness): string[] | undefined {
  return harness.streamed.find((argv) => argv.includes("_finish-update"));
}

describe("isForwardMove", () => {
  test("only a strictly newer release tag counts as forward", () => {
    expect(isForwardMove("0.48.0", "v0.49.0")).toBe(true);
    expect(isForwardMove("0.48.0", "v1.0.0")).toBe(true);
    expect(isForwardMove("0.48.0", "v0.48.1")).toBe(true);
    expect(isForwardMove("0.48.0", "v0.48.0")).toBe(false);
    expect(isForwardMove("0.48.0", "v0.47.9")).toBe(false);
    expect(isForwardMove("0.48.0", "v0.9.9")).toBe(false);
  });

  test("a SHA, a branch, or a pre-release is never a release to move to", () => {
    expect(isForwardMove("0.48.0", "deadbeef")).toBe(false);
    expect(isForwardMove("0.48.0", "main")).toBe(false);
    expect(isForwardMove("0.48.0", "v0.49.0-rc.1")).toBe(false);
  });
});

describe("newestStableTag", () => {
  test("skips pre-releases that sort above the newest stable", () => {
    expect(newestStableTag("v0.50.0-rc.1\nv0.49.0\nv0.48.0\n")).toBe("v0.49.0");
    expect(newestStableTag("v0.50.0-rc.1\n")).toBeUndefined();
    expect(newestStableTag("")).toBeUndefined();
  });
});

describe("recoveryPlan", () => {
  test("never claims a source rollback is safe; points at the rollback notes and the backup", () => {
    const plan = recoveryPlan({
      failedStep: "Database migration failed",
      fromVersion: "0.48.0",
      backupPath: "/opt/eveland/backups/x.sql",
      repo: "/opt/eveland/source",
    });
    expect(plan).toContain("left STOPPED");
    expect(plan).toContain("NOT reversed automatically");
    expect(plan).toContain("Rollback boundary");
    expect(plan).toContain("Only if those notes say v0.48.0 is compatible");
    expect(plan).toContain("restore the database from /opt/eveland/backups/x.sql");
    expect(plan).not.toMatch(/forward-compatible/i);
  });
});

describe("runUpdate (phase 1, the old code)", () => {
  test("refuses a development checkout", async () => {
    const harness = await makeHarness({ installed: false });
    expect(await runUpdate([], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("git pull");
  });

  test("pipeline: backup -> stop -> checkout -> install -> hand over to the NEW checkout's ctl", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    expect(await runUpdate([], harness.io)).toBe(0);
    expect(harness.pgDumps).toHaveLength(1);
    expect(gitSubcommands(harness)).toContain("checkout");
    expect(harness.streamed.map((argv) => argv.slice(0, 2))).toEqual([
      ["pnpm", "install"],
      [process.execPath, path.join(harness.repo, "packages/ctl/src/bin.ts")],
    ]);
    // Phase 2 is the new checkout's bin, told where it came from and where
    // the backup is — the old code decides nothing past this point.
    const finish = finishUpdateCall(harness)!;
    expect(finish.slice(2)).toEqual([
      "_finish-update",
      "--from",
      "0.48.0",
      "--backup",
      harness.pgDumps[0],
    ]);
    expect(harness.out.join("\n")).toContain("Updated to v0.49.0.");
    const backups = await readdir(harness.layout.backupsDir);
    expect(backups[0]).toContain("v0.48.0");
  });

  test("the default target is the newest STABLE tag, not a pre-release that sorts above it", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    expect(await runUpdate([], harness.io)).toBe(0);
    expect(harness.out.join("\n")).toContain("Updating v0.48.0 -> v0.49.0");
    expect(harness.gitCalls.find((argv) => argv[1] === "checkout")).toEqual([
      "git",
      "checkout",
      "--quiet",
      "v0.49.0",
    ]);
  });

  test("a completed update leaves no pending record behind", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    expect(await runUpdate([], harness.io)).toBe(0);
    expect(await readPendingUpdate(harness.layout)).toBeNull();
  });

  test("an update that fails after the checkout is RESUMED by the next run, never 'already up to date'", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    let failInstall = true;
    harness.io.streamCommand = async (argv) => {
      harness.streamed.push(argv);
      if (argv.includes("_finish-update")) harness.timeline.push("finish-update");
      return failInstall && argv[1] === "install" ? 1 : 0;
    };
    expect(await runUpdate([], harness.io)).toBe(1);
    // package.json now says 0.49.0 while the platform is stopped...
    const pending = await readPendingUpdate(harness.layout);
    expect(pending).toMatchObject({
      from: "0.48.0",
      target: "v0.49.0",
      stashName: null,
      stashRef: null,
      evePinBefore: "0.47.6",
    });
    expect(pending!.backupPath).toBe(harness.pgDumps[0]);
    expect(harness.err.join("\n")).toContain("re-running `eveland-ctl update` resumes it");

    // ...and the re-run resumes from the record instead of declaring victory.
    failInstall = false;
    const before = {
      dumps: harness.pgDumps.length,
      checkouts: harness.timeline.filter((t) => t === "checkout").length,
    };
    expect(await runUpdate([], harness.io)).toBe(0);
    expect(harness.out.join("\n")).toContain("Resuming the interrupted update v0.48.0 -> v0.49.0");
    expect(harness.out.join("\n")).not.toContain("Already up to date");
    // No second backup (the first one still protects v0.48.0's data); the
    // idempotent steps re-run and phase 2 gets the ORIGINAL from/backup.
    expect(harness.pgDumps).toHaveLength(before.dumps);
    expect(harness.timeline.filter((t) => t === "checkout").length).toBe(before.checkouts + 1);
    expect(finishUpdateCall(harness)!.slice(2)).toEqual([
      "_finish-update",
      "--from",
      "0.48.0",
      "--backup",
      harness.pgDumps[0],
    ]);
    expect(await readPendingUpdate(harness.layout)).toBeNull();
    expect(harness.out.join("\n")).toContain("Updated to v0.49.0.");
  });

  test("a resume offers the stash recorded by the interrupted run back", async () => {
    const harness = await makeHarness({ dirty: true, confirmAnswers: [true, true] });
    harness.io.streamCommand = async (argv) => {
      harness.streamed.push(argv);
      return argv.includes("_finish-update") && !harness.timeline.includes("resumed") ? 1 : 0;
    };
    expect(await runUpdate([], harness.io)).toBe(1);
    const recorded = await readPendingUpdate(harness.layout);
    expect(recorded?.stashName).toMatch(/^eveland-ctl-update-/);
    expect(recorded?.stashRef).toBe("5745a5h");
    harness.timeline.push("resumed");
    expect(await runUpdate([], harness.io)).toBe(0);
    // The RECORDED stash commit is applied, not whatever is newest.
    expect(harness.gitCalls).toContainEqual(["git", "stash", "apply", "5745a5h"]);
    // The stash was pushed exactly once (by the interrupted run).
    expect(
      harness.gitCalls.filter((argv) => argv[1] === "stash" && argv[2] === "push"),
    ).toHaveLength(1);
  });

  test("an eve-window move is still reported when the update completes on a RESUME", async () => {
    // The first attempt moves the checkout (and the pin) and then fails; the
    // resumed run only ever sees the target tree, so the pin it compares
    // against must come from the record.
    const harness = await makeHarness({ evePinAfter: "0.48.0", confirmAnswers: [true, false] });
    let fail = true;
    harness.io.streamCommand = async (argv) => {
      harness.streamed.push(argv);
      return fail && argv.includes("_finish-update") ? 1 : 0;
    };
    expect(await runUpdate([], harness.io)).toBe(1);
    expect((await readPendingUpdate(harness.layout))?.evePinBefore).toBe("0.47.6");
    expect(harness.out.join("\n")).not.toContain("eve window moved");
    fail = false;
    expect(await runUpdate([], harness.io)).toBe(0);
    expect(harness.out.join("\n")).toContain("eve window moved");
    expect(harness.out.join("\n")).toContain("redeploy and promote EVERY project");
  });

  test("a second update while one is running is refused, and the lock is released afterwards", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    await mkdir(harness.layout.runDir, { recursive: true });
    // Another eveland-ctl update (pid 777, alive) holds the update lock.
    const held = await acquireMutex(updateMutexPath(harness.layout), 777, async (pid) =>
      pid === 777 ? "id-777" : null,
    );
    harness.io.processIdentity = async (pid) => (pid === 777 ? "id-777" : `id-${pid}`);
    expect(await runUpdate([], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("Another eveland-ctl update is running (pid 777)");
    expect(harness.pgDumps).toHaveLength(0);
    await held.release();
    // Lock gone: the update runs, and leaves no lock behind.
    harness.io.processIdentity = async (pid) => `id-${pid}`;
    expect(await runUpdate([], harness.io)).toBe(0);
    const { stat } = await import("node:fs/promises");
    await expect(stat(updateMutexPath(harness.layout))).rejects.toThrow();
  });

  test("start refuses a half-updated tree while an update is recorded; only the update's own phase 2 may start", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    harness.io.streamCommand = async (argv) => {
      harness.streamed.push(argv);
      return argv.includes("_finish-update") ? 1 : 0;
    };
    expect(await runUpdate([], harness.io)).toBe(1);
    expect(await readPendingUpdate(harness.layout)).not.toBeNull();
    harness.err.length = 0;
    expect(await runStart([], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("interrupted update is recorded");
    expect(harness.timeline).not.toContain("start-daemon");
    // Phase 2 (the new checkout's ctl) starts with the record still present.
    expect(await runFinishUpdate(["--from", "0.48.0"], harness.io)).toBe(0);
    expect(harness.timeline).toContain("start-daemon");
  });

  test("the stash goes back into the updated tree BEFORE phase 2 starts anything, and is not re-applied on a resume", async () => {
    const dirty = await makeHarness({ dirty: true, confirmAnswers: [true, true] });
    let failFinish = true;
    dirty.io.streamCommand = async (argv) => {
      dirty.streamed.push(argv);
      if (argv.includes("_finish-update")) dirty.timeline.push("finish-update");
      return failFinish && argv.includes("_finish-update") ? 1 : 0;
    };
    expect(await runUpdate([], dirty.io)).toBe(1);
    const applyIndex = dirty.timeline.indexOf("stash-apply");
    const finishIndex = dirty.timeline.indexOf("finish-update");
    expect(applyIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeLessThan(finishIndex);
    expect((await readPendingUpdate(dirty.layout))?.stashRestored).toBe(true);
    // Resume: no second apply, no "stash not found" noise, record cleared at the end.
    failFinish = false;
    expect(await runUpdate([], dirty.io)).toBe(0);
    expect(dirty.timeline.filter((t) => t === "stash-apply")).toHaveLength(1);
    expect(dirty.out.join("\n")).not.toContain("Stash restore failed");
    expect(await readPendingUpdate(dirty.layout)).toBeNull();
  });

  test("start is refused while an update HOLDS THE LOCK, even before the pending record exists", async () => {
    const harness = await makeHarness({});
    await mkdir(harness.layout.runDir, { recursive: true });
    const held = await acquireMutex(updateMutexPath(harness.layout), 777, async (pid) =>
      pid === 777 ? "id-777" : null,
    );
    harness.io.processIdentity = async (pid) => (pid === 777 ? "id-777" : null);
    harness.io.sendSignal!(4242, "SIGTERM"); // the update stopped the platform...
    expect(await runStart([], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("An update is running (eveland-ctl update, pid 777)");
    expect(harness.timeline).not.toContain("start-daemon");
    // ...but the update's own phase 2 may start it.
    expect(await runStart(["--from-update"], harness.io)).toBe(0);
    await held.release();
  });

  test("the pending record lives under run/, next to the supervisor files", async () => {
    const harness = await makeHarness({});
    expect(pendingUpdatePath(harness.layout)).toBe(
      path.join(harness.layout.runDir, "update-pending.json"),
    );
  });

  test("the old code never builds, migrates, pins identity, or starts on its own", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    expect(await runUpdate([], harness.io)).toBe(0);
    const flat = harness.streamed.map((argv) => argv.join(" "));
    expect(flat.some((line) => line.includes("db:migrate"))).toBe(false);
    expect(flat.some((line) => line.includes("@evelandhq/web build"))).toBe(false);
    expect(harness.timeline).not.toContain("start-daemon");
    const onDisk = parseEnvFile(await readFile(harness.layout.envFilePath, "utf8"));
    expect(onDisk.EVELAND_REVISION).toBe("0000000");
  });

  test("the platform stops BEFORE the working tree moves, and the handover comes after", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    expect(await runUpdate([], harness.io)).toBe(0);
    const stopIndex = harness.timeline.indexOf("stop-signal");
    const checkoutIndex = harness.timeline.indexOf("checkout");
    const finishIndex = harness.timeline.indexOf("finish-update");
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeLessThan(checkoutIndex);
    expect(checkoutIndex).toBeLessThan(finishIndex);
  });

  test("a failed pnpm install leaves the platform stopped with the safe recovery plan", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    harness.io.streamCommand = async (argv) => {
      harness.streamed.push(argv);
      return argv[1] === "install" ? 1 : 0;
    };
    expect(await runUpdate([], harness.io)).toBe(1);
    const stderr = harness.err.join("\n");
    expect(stderr).toContain("left STOPPED");
    expect(stderr).toContain("NOT reversed automatically");
    expect(stderr).toContain("Rollback boundary");
    expect(harness.timeline).toContain("stop-signal");
    expect(finishUpdateCall(harness)).toBeUndefined();
  });

  test("a failing phase 2 is reported without a second recovery plan (the new ctl printed its own)", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    harness.io.streamCommand = async (argv) => {
      harness.streamed.push(argv);
      return argv.includes("_finish-update") ? 1 : 0;
    };
    expect(await runUpdate([], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("could not finish the update");
    expect(harness.out.join("\n")).not.toContain("Updated to");
  });

  test("a downgrade is refused before anything moves", async () => {
    const harness = await makeHarness({});
    expect(await runUpdate(["--version", "v0.47.0"], harness.io)).toBe(1);
    expect(harness.err.join("\n")).toContain("only moves forward");
    expect(harness.err.join("\n")).toContain("rollback notes");
    expect(harness.pgDumps).toHaveLength(0);
    expect(harness.timeline).not.toContain("stop-signal");
    expect(gitSubcommands(harness)).not.toContain("checkout");
  });

  test("a bare revision or pre-release is not a release to update to", async () => {
    for (const target of ["deadbeef", "main", "v0.49.0-rc.1"]) {
      const harness = await makeHarness({});
      expect(await runUpdate(["--version", target], harness.io)).toBe(1);
      expect(harness.err.join("\n")).toContain("only moves forward");
      expect(gitSubcommands(harness)).not.toContain("checkout");
    }
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

  test("--skip-backup hands over without a --backup, and the plan says so", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    expect(await runUpdate(["--skip-backup"], harness.io)).toBe(0);
    expect(harness.pgDumps).toHaveLength(0);
    expect(finishUpdateCall(harness)!.slice(2)).toEqual(["_finish-update", "--from", "0.48.0"]);
    expect(
      recoveryPlan({ failedStep: "x", fromVersion: "0.48.0", backupPath: null, repo: "/r" }),
    ).toContain("this run skipped pg_dump");
  });

  test("a clean tree is never stashed", async () => {
    const harness = await makeHarness({ confirmAnswers: [true] });
    expect(await runUpdate([], harness.io)).toBe(0);
    expect(harness.gitCalls.some((argv) => argv[1] === "stash")).toBe(false);
  });

  test("a dirty tree is stashed by name and the EXACT stash commit is offered back afterwards", async () => {
    const dirty = await makeHarness({ dirty: true, confirmAnswers: [true, true] });
    expect(await runUpdate([], dirty.io)).toBe(0);
    const stashPush = dirty.gitCalls.find((argv) => argv[1] === "stash" && argv[2] === "push");
    expect(stashPush).toBeDefined();
    expect(stashPush!.join(" ")).toContain("eveland-ctl-update-");
    // Restored by sha and dropped by its current index — never a bare `pop`,
    // which would take whatever the operator stashed most recently.
    expect(dirty.gitCalls).toContainEqual(["git", "stash", "apply", "5745a5h"]);
    expect(dirty.gitCalls).toContainEqual(["git", "stash", "drop", "stash@{1}"]);
    expect(dirty.gitCalls.some((argv) => argv[1] === "stash" && argv[2] === "pop")).toBe(false);
  });

  test("when the stash sha could not be recorded, the stash is found by its NAME — never a bare pop", async () => {
    const dirty = await makeHarness({
      dirty: true,
      stashRefUnknown: true,
      confirmAnswers: [true, true],
    });
    expect(await runUpdate([], dirty.io)).toBe(0);
    expect(dirty.gitCalls).toContainEqual(["git", "stash", "apply", "5745a5h"]);
    expect(dirty.gitCalls).toContainEqual(["git", "stash", "drop", "stash@{1}"]);
    expect(dirty.gitCalls.some((argv) => argv[1] === "stash" && argv[2] === "pop")).toBe(false);
    expect(dirty.out.join("\n")).toContain("Stash restored.");
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

describe("runFinishUpdate (phase 2, the new checkout's ctl)", () => {
  const FROM = ["--from", "0.48.0", "--backup", "/b/x.sql"];

  test("ctl form: pins identity, builds, migrates, starts — in that order", async () => {
    const harness = await makeHarness({});
    // Phase 2 begins with the platform stopped.
    harness.io.sendSignal!(4242, "SIGTERM");
    expect(await runFinishUpdate(FROM, harness.io)).toBe(0);
    expect(harness.streamed).toEqual([
      ["pnpm", "--filter", "@evelandhq/web", "build"],
      ["pnpm", "--filter", "@evelandhq/api", "db:migrate"],
    ]);
    expect(harness.timeline).toContain("start-daemon");
    const onDisk = parseEnvFile(await readFile(harness.layout.envFilePath, "utf8"));
    expect(onDisk.EVELAND_REVISION).toBe("abc0480");
    expect(onDisk.EVELAND_RELEASE_CHANNEL).toBe("stable");
    expect(onDisk.APP_SECRET_KEY).toBe("k");
  });

  test("a checkout that is not an exact release tag is stamped edge, not stable", async () => {
    const harness = await makeHarness({ tagAfter: null });
    harness.io.sendSignal!(4242, "SIGTERM");
    expect(await runFinishUpdate(FROM, harness.io)).toBe(0);
    const onDisk = parseEnvFile(await readFile(harness.layout.envFilePath, "utf8"));
    expect(onDisk.EVELAND_RELEASE_CHANNEL).toBe("edge");
  });

  test("systemd form: regenerates units, env allowlists and overlay, then migrates and starts via systemd", async () => {
    const harness = await makeHarness({ supervision: "systemd" });
    expect(await runFinishUpdate(FROM, harness.io), harness.err.join("\n")).toBe(0);
    // The new version's artifacts, written by the new ctl.
    expect(Object.keys(harness.written)).toContain(
      path.join(harness.unitDir, "eveland-workflow-dispatcher.service"),
    );
    expect(Object.keys(harness.written)).toContain(
      path.join(harness.unitDir, "eveland-worker.service"),
    );
    const etc = await readdir(harness.layout.etcDir);
    expect(etc).toContain("compose.appliance.yml");
    expect(etc).toContain("eveland-gateway.env");
    expect(etc).toContain("eveland-web.env");
    expect(etc).toContain("eveland-workflow-dispatcher.env");
    expect(harness.timeline).toContain("systemctl daemon-reload");
    // No host-side Dashboard build (the web container builds its own), but
    // migrations still run, and the start goes through systemd.
    const flat = harness.streamed.map((argv) => argv.join(" "));
    expect(flat.some((line) => line.includes("@evelandhq/web build"))).toBe(false);
    expect(flat.some((line) => line.includes("db:migrate"))).toBe(true);
    expect(harness.timeline).toContain("systemctl start");
    expect(harness.timeline).not.toContain("start-daemon");
  });

  test("a failed migration leaves the platform stopped, with the safe recovery plan", async () => {
    const harness = await makeHarness({});
    harness.io.sendSignal!(4242, "SIGTERM");
    harness.io.streamCommand = async (argv) => {
      harness.streamed.push(argv);
      return argv.includes("db:migrate") ? 1 : 0;
    };
    expect(await runFinishUpdate(FROM, harness.io)).toBe(1);
    const stderr = harness.err.join("\n");
    expect(stderr).toContain("Database migration failed");
    expect(stderr).toContain("left STOPPED");
    expect(stderr).toContain("NOT reversed automatically");
    expect(stderr).toContain("restore the database from /b/x.sql");
    expect(harness.timeline).not.toContain("start-daemon");
  });

  test("a start that fails after a good migration lands in the same recovery plan", async () => {
    const harness = await makeHarness({});
    harness.io.sendSignal!(4242, "SIGTERM");
    harness.io.spawnDaemon = async () => {
      // The daemon "crashes": pidfile written but the pid is never alive.
      await writeSupervisorRecord(harness.layout, { pid: 9999, identity: "id-9999" });
      return 9999;
    };
    expect(await runFinishUpdate(FROM, harness.io)).toBe(1);
    const stderr = harness.err.join("\n");
    expect(stderr).toContain("Starting the updated platform failed");
    expect(stderr).toContain("left STOPPED");
    expect(stderr).toContain("Rollback boundary");
  });
});

describe("defaultPgDump", () => {
  test("a backup exists complete or not at all: partial file, fsync, rename, 0600", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-pgdump-"));
    const backupPath = path.join(dir, "eveland-v0.48.0.sql");
    const ok = defaultPgDump({ argv: ["sh", "-c", "printf -- '-- dump\\nSELECT 1;\\n'"] });
    expect(await ok(backupPath, { cwd: dir, envFilePath: "/dev/null" })).toBe(0);
    const { stat } = await import("node:fs/promises");
    expect(await readFile(backupPath, "utf8")).toContain("SELECT 1;");
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    await expect(stat(`${backupPath}.partial`)).rejects.toThrow();

    // A failing dump leaves nothing behind that could pass for a backup.
    const failing = defaultPgDump({ argv: ["sh", "-c", "printf 'half'; exit 3"] });
    const failedPath = path.join(dir, "failed.sql");
    expect(await failing(failedPath, { cwd: dir, envFilePath: "/dev/null" })).toBe(3);
    await expect(stat(failedPath)).rejects.toThrow();
    await expect(stat(`${failedPath}.partial`)).rejects.toThrow();

    // A "successful" dump with no output is not a backup either.
    const empty = defaultPgDump({ argv: ["true"] });
    const emptyPath = path.join(dir, "empty.sql");
    expect(await empty(emptyPath, { cwd: dir, envFilePath: "/dev/null" })).toBeNull();
    await expect(stat(emptyPath)).rejects.toThrow();
  });
});
