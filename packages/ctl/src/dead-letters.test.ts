import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runDeadLetters } from "./dead-letters.ts";
import type { DeadLetterGroup, DeadLetterSelector, DeadLetterStore } from "./dead-letter-store.ts";
import type { LifecycleIo } from "./lifecycle.ts";
import { nonInteractivePrompter, type Prompter } from "./prompt.ts";

const WORLD_URL = "postgres://eveland:eveland@127.0.0.1:17310/eveland_workflow";

function group(overrides: Partial<DeadLetterGroup> = {}): DeadLetterGroup {
  return {
    projectId: "proj_alpha",
    deploymentId: "dep_alpha",
    letters: 3,
    runs: 2,
    activeRuns: 0,
    runlessLetters: 0,
    oldestAt: new Date("2026-08-13T09:27:43Z"),
    latestReason: "Deployment dep_alpha is not activatable",
    ...overrides,
  };
}

async function harness(options: {
  groups?: DeadLetterGroup[];
  resolution?: { letters: number; replayableRuns: number };
  world?: string | null;
  prompter?: Prompter;
}) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-deadletters-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-deadlettershome-"));
  const world = options.world === undefined ? WORLD_URL : options.world;
  await writeFile(
    path.join(repo, ".env"),
    world === null
      ? "DATABASE_URL=postgres://x@127.0.0.1:17310/eveland\n"
      : `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL=${world}\n`,
  );
  const out: string[] = [];
  const err: string[] = [];
  const resolveCalls: { worldUrl: string; selector: DeadLetterSelector }[] = [];
  const summarizeCalls: string[] = [];
  const deadLetters: DeadLetterStore = {
    summarize: async (worldUrl) => {
      summarizeCalls.push(worldUrl);
      return options.groups ?? [];
    },
    resolve: async (worldUrl, selector) => {
      resolveCalls.push({ worldUrl, selector });
      return options.resolution ?? { letters: 0, replayableRuns: 0 };
    },
  };
  const io: LifecycleIo = {
    // EVELAND_HOME points at an empty directory so the repository .env is what
    // gets read, exactly as it would be in a development checkout.
    env: { EVELAND_HOME: home, NO_COLOR: "1" },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    repoRootDir: repo,
    prompter: options.prompter ?? nonInteractivePrompter(),
    deadLetters,
  };
  return { io, out, err, resolveCalls, summarizeCalls };
}

describe("eveland-ctl dead-letters", () => {
  test("a clean world reports nothing outstanding and exits 0", async () => {
    const { io, out } = await harness({ groups: [] });
    expect(await runDeadLetters([], io)).toBe(0);
    expect(out.join("\n")).toContain("No unresolved workflow dispatch dead letters.");
  });

  test("outstanding letters are grouped, counted, and exit non-zero", async () => {
    const { io, out, summarizeCalls } = await harness({
      groups: [
        group({ letters: 278, runs: 4, activeRuns: 0 }),
        group({
          projectId: "proj_beta",
          deploymentId: "dep_beta",
          letters: 9,
          runs: 3,
          activeRuns: 2,
          oldestAt: new Date("2026-09-01T00:00:00Z"),
          latestReason: "Retries exhausted. Last failure: connect ECONNREFUSED 127.0.0.1:17310",
        }),
      ],
    });
    expect(await runDeadLetters([], io)).toBe(1);
    const text = out.join("\n");
    expect(summarizeCalls).toEqual([WORLD_URL]);
    expect(text).toContain("287 unresolved letters");
    // The distinction the count alone hides: what is still stuck right now.
    expect(text).toContain("2 runs still quarantined");
    expect(text).toContain("dep_alpha proj_alpha");
    expect(text).toContain("dep_beta proj_beta");
    expect(text).toContain("eveland-ctl dead-letters --resolve --deployment <id>");
  });

  test("history with nothing stuck says so instead of raising an alarm", async () => {
    const { io, out } = await harness({ groups: [group({ activeRuns: 0 })] });
    await runDeadLetters([], io);
    expect(out.join("\n")).toContain("no run is still quarantined");
  });

  test("--resolve passes the selector through and reports the replay it just armed", async () => {
    const { io, out, resolveCalls } = await harness({
      resolution: { letters: 12, replayableRuns: 3 },
    });
    expect(await runDeadLetters(["--resolve", "--deployment", "dep_beta"], io)).toBe(0);
    expect(resolveCalls).toEqual([
      { worldUrl: WORLD_URL, selector: { kind: "deployment", deploymentId: "dep_beta" } },
    ]);
    const text = out.join("\n");
    expect(text).toContain("Resolved 12 dead letters.");
    expect(text).toContain("3 quarantined runs will be replayed at the next dispatcher boot.");
  });

  test("--resolve without a target refuses rather than resolving everything", async () => {
    const { io, err, resolveCalls } = await harness({});
    expect(await runDeadLetters(["--resolve"], io)).toBe(1);
    expect(resolveCalls).toEqual([]);
    expect(err.join("\n")).toContain("needs a target");
  });

  test("--resolve --all needs a confirmation it cannot get non-interactively", async () => {
    const { io, err, resolveCalls } = await harness({});
    expect(await runDeadLetters(["--resolve", "--all"], io)).toBe(1);
    expect(resolveCalls).toEqual([]);
    expect(err.join("\n")).toContain("--yes");
  });

  test("--resolve --all --yes is the scripted form", async () => {
    const { io, resolveCalls } = await harness({
      resolution: { letters: 1537, replayableRuns: 0 },
    });
    expect(await runDeadLetters(["--resolve", "--all", "--yes"], io)).toBe(0);
    expect(resolveCalls).toEqual([{ worldUrl: WORLD_URL, selector: { kind: "all" } }]);
  });

  test("--resolve --all is confirmed at a prompt when there is one", async () => {
    const asked: string[] = [];
    const { io, resolveCalls } = await harness({
      resolution: { letters: 2, replayableRuns: 2 },
      prompter: {
        interactive: true,
        ask: async (_question, defaultValue) => defaultValue,
        confirm: async (question) => {
          asked.push(question);
          return true;
        },
      },
    });
    expect(await runDeadLetters(["--resolve", "--all"], io)).toBe(0);
    expect(asked[0]).toContain("replaying each quarantined run");
    expect(resolveCalls).toHaveLength(1);
  });

  test("the deployment table is capped, and says what it left out", async () => {
    const { io, out } = await harness({
      groups: Array.from({ length: 20 }, (_, index) =>
        group({ deploymentId: `dep_${String(index)}`, letters: 20 - index }),
      ),
    });
    await runDeadLetters([], io);
    const text = out.join("\n");
    expect(text).toContain("dep_14");
    expect(text).not.toContain("dep_15");
    expect(text).toContain("5 more deployments holding 15 letters (--limit 0 for all)");
  });

  test("--limit 0 prints every deployment", async () => {
    const { io, out } = await harness({
      groups: Array.from({ length: 20 }, (_, index) =>
        group({ deploymentId: `dep_${String(index)}` }),
      ),
    });
    await runDeadLetters(["--limit", "0"], io);
    expect(out.join("\n")).toContain("dep_19");
    expect(out.join("\n")).not.toContain("more deployments");
  });

  test("two selectors are refused rather than silently ORed", async () => {
    const { io, err } = await harness({});
    expect(await runDeadLetters(["--resolve", "--all", "--run", "wrun_1"], io)).toBe(1);
    expect(err.join("\n")).toContain("exactly one of");
  });

  test("an unconfigured world is reported, not treated as an error", async () => {
    const { io, out, summarizeCalls } = await harness({ world: null });
    expect(await runDeadLetters([], io)).toBe(0);
    expect(summarizeCalls).toEqual([]);
    expect(out.join("\n")).toContain("No shared workflow world is configured");
  });

  test("the env file wins over a stray world URL in the operator's shell", async () => {
    const { io, summarizeCalls } = await harness({ groups: [] });
    io.env.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL = "postgres://someone@elsewhere/other";
    await runDeadLetters([], io);
    expect(summarizeCalls).toEqual([WORLD_URL]);
  });
});
