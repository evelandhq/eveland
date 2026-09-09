import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runDispatcherLock } from "./dispatcher-lock.ts";
import type { DispatcherLockHolder, DispatcherLockStore } from "./dispatcher-lock-store.ts";
import type { LifecycleIo } from "./lifecycle.ts";
import { nonInteractivePrompter, type Prompter } from "./prompt.ts";

const WORLD_URL = "postgres://eveland:eveland@127.0.0.1:17310/eveland_workflow";

function holder(overrides: Partial<DispatcherLockHolder> = {}): DispatcherLockHolder {
  return {
    pid: 2621649,
    applicationName: "workflow-dispatcher-57daedf2",
    clientAddr: "172.60.10.81",
    backendStart: new Date("2026-09-09T02:47:44Z"),
    state: "idle",
    stateChange: new Date("2026-09-09T02:47:44Z"),
    ...overrides,
  };
}

async function harness(options: {
  holder?: DispatcherLockHolder | null;
  terminated?: boolean;
  world?: string | null;
  prompter?: Prompter;
}) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-dispatcherlock-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-dispatcherlockhome-"));
  const world = options.world === undefined ? WORLD_URL : options.world;
  await writeFile(
    path.join(repo, ".env"),
    world === null
      ? "DATABASE_URL=postgres://x@127.0.0.1:17310/eveland\n"
      : `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL=${world}\n`,
  );
  const out: string[] = [];
  const err: string[] = [];
  const terminateCalls: { worldUrl: string; pid: number }[] = [];
  const dispatcherLock: DispatcherLockStore = {
    holder: async () => options.holder ?? null,
    terminate: async (worldUrl, pid) => {
      terminateCalls.push({ worldUrl, pid });
      return options.terminated ?? true;
    },
  };
  const io: LifecycleIo = {
    env: { EVELAND_HOME: home, NO_COLOR: "1" },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    repoRootDir: repo,
    prompter: options.prompter ?? nonInteractivePrompter(),
    dispatcherLock,
  };
  return { io, out, err, terminateCalls };
}

describe("eveland-ctl dispatcher-lock", () => {
  test("a free lock is reported and exits 0", async () => {
    const h = await harness({ holder: null });
    expect(await runDispatcherLock([], h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("Not held");
  });

  test("a held lock names the session", async () => {
    const h = await harness({ holder: holder() });
    expect(await runDispatcherLock([], h.io)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("backend 2621649");
    expect(text).toContain("workflow-dispatcher-57daedf2");
    expect(text).toContain("172.60.10.81");
    expect(text).toContain("2026-09-09 02:47:44Z");
    expect(text).toContain("--terminate");
    expect(h.terminateCalls).toEqual([]);
  });

  test("--terminate with nothing held does nothing", async () => {
    const h = await harness({ holder: null });
    expect(await runDispatcherLock(["--terminate", "--yes"], h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("Nothing to terminate");
    expect(h.terminateCalls).toEqual([]);
  });

  test("--terminate needs a confirmation it cannot get non-interactively", async () => {
    const h = await harness({ holder: holder() });
    expect(await runDispatcherLock(["--terminate"], h.io)).toBe(1);
    expect(h.err.join("\n")).toContain("Re-run with --yes");
    expect(h.terminateCalls).toEqual([]);
  });

  test("--terminate --yes signals the holder and says what happens next", async () => {
    const h = await harness({ holder: holder() });
    expect(await runDispatcherLock(["--terminate", "--yes"], h.io)).toBe(0);
    expect(h.terminateCalls).toEqual([{ worldUrl: WORLD_URL, pid: 2621649 }]);
    expect(h.out.join("\n")).toContain("Terminated backend 2621649");
    expect(h.out.join("\n")).toContain("reset-failed");
  });

  test("--terminate is confirmed at a prompt when there is one", async () => {
    const questions: string[] = [];
    const prompter: Prompter = {
      interactive: true,
      ask: async (_question, value) => value,
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
    };
    const h = await harness({ holder: holder(), prompter });
    expect(await runDispatcherLock(["--terminate"], h.io)).toBe(0);
    expect(questions[0]).toContain("2621649");
    expect(h.terminateCalls).toHaveLength(1);
  });

  test("a holder the role cannot signal is reported as a failure", async () => {
    const h = await harness({ holder: holder(), terminated: false });
    expect(await runDispatcherLock(["--terminate", "--yes"], h.io)).toBe(1);
    expect(h.err.join("\n")).toContain("was not signalled");
  });

  test("--yes without --terminate is refused", async () => {
    const h = await harness({ holder: null });
    expect(await runDispatcherLock(["--yes"], h.io)).toBe(1);
    expect(h.err.join("\n")).toContain("--yes only applies");
  });

  test("an unconfigured world is reported, not treated as an error", async () => {
    const h = await harness({ world: null });
    expect(await runDispatcherLock([], h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("No shared workflow world is configured");
  });
});
