import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { generatedObserverModule, injectObserverHooks } from "./injector.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("injectObserverHooks", () => {
  test("supported Eve minors give root and directory-form subagents hooks while file-form coverage is reported", async () => {
    const releaseDir = await createRelease();
    await write("agent/subagents/directory-child/agent.ts", "export default {}", releaseDir);
    await write("agent/subagents/file-child.ts", "export default {}", releaseDir);
    await write("agent/subagents/remote-child.ts", "export default {}", releaseDir);

    const result = await injectObserverHooks({ releaseDir });

    expect(result.injectedFiles).toEqual([
      "agent/hooks/eveland-observer.js",
      "agent/subagents/directory-child/hooks/eveland-observer.js",
    ]);
    expect(result.coverageGaps.map((gap) => path.basename(gap.path))).toEqual(["file-child.ts", "remote-child.ts"]);
    await expect(readFile(path.join(releaseDir, result.injectedFiles[0]!), "utf8")).resolves.toContain("defineHook");
  });

  test("fails instead of overwriting an authored reserved observer hook", async () => {
    const releaseDir = await createRelease();
    await write("agent/hooks/eveland-observer.js", "authored", releaseDir);

    await expect(injectObserverHooks({ releaseDir })).rejects.toThrow(/Reserved observer hook already exists/);
    await expect(readFile(path.join(releaseDir, "agent/hooks/eveland-observer.js"), "utf8")).resolves.toBe("authored");
  });

  test("generated observer catches outbox failures so Eve event handling stays available", async () => {
    const releaseDir = await createRelease();
    const result = await injectObserverHooks({ releaseDir });
    const observerPath = path.join(releaseDir, result.injectedFiles[0]!);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const originalOutbox = process.env.EVELAND_OBSERVER_OUTBOX_DIR;
    const originalDeployment = process.env.EVELAND_DEPLOYMENT_ID;
    delete process.env.EVELAND_OBSERVER_OUTBOX_DIR;
    delete process.env.EVELAND_DEPLOYMENT_ID;

    try {
      const observer = (await import(`${observerPath}?test=${Date.now()}`)) as {
        default: { events: { "*": (event: unknown, context: unknown) => Promise<void> } };
      };
      await expect(
        observer.default.events["*"](
          { type: "session.started", meta: { at: "2026-07-13T00:00:00.000Z" } },
          { session: { id: "eve_1" }, agent: { name: "root" }, channel: { kind: "http" } },
        ),
      ).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      restoreEnv("EVELAND_OBSERVER_OUTBOX_DIR", originalOutbox);
      restoreEnv("EVELAND_DEPLOYMENT_ID", originalDeployment);
      warning.mockRestore();
    }
  });

  test("generated observer is self-contained and has no Eveland runtime dependency", () => {
    expect(generatedObserverModule).toContain('from "eve/hooks"');
    expect(generatedObserverModule).not.toContain("@eveland/");
  });

  test("collects Eve 0.27.0 turn.cancelled events while still filtering deltas", async () => {
    const releaseDir = await createRelease();
    const outboxDir = await mkdtemp(path.join(packageRoot, ".observer-outbox-test-"));
    temporaryDirectories.push(outboxDir);
    const result = await injectObserverHooks({ releaseDir });
    const observerPath = path.join(releaseDir, result.injectedFiles[0]!);
    const originalOutbox = process.env.EVELAND_OBSERVER_OUTBOX_DIR;
    const originalDeployment = process.env.EVELAND_DEPLOYMENT_ID;
    process.env.EVELAND_OBSERVER_OUTBOX_DIR = outboxDir;
    process.env.EVELAND_DEPLOYMENT_ID = "dep_1";

    try {
      const observer = (await import(`${observerPath}?cancelled=${Date.now()}`)) as {
        default: { events: { "*": (event: unknown, context: unknown) => Promise<void> } };
      };
      const context = { session: { id: "eve_1" }, agent: { name: "root" }, channel: { kind: "http" } };
      await observer.default.events["*"]({ type: "turn.cancelled", data: { sequence: 3, turnId: "turn_1" } }, context);
      await observer.default.events["*"]({ type: "message.appended", data: { turnId: "turn_1" } }, context);

      const sessionDirectories = await readdir(path.join(outboxDir, "sessions"));
      const files = await readdir(path.join(outboxDir, "sessions", sessionDirectories[0]!));
      const envelopes = await Promise.all(
        files
          .filter((file) => file.endsWith(".ready.json"))
          .map(async (file) => JSON.parse(await readFile(path.join(outboxDir, "sessions", sessionDirectories[0]!, file), "utf8"))),
      );
      expect(envelopes.map((envelope) => envelope.event.type)).toEqual(["turn.cancelled"]);
    } finally {
      restoreEnv("EVELAND_OBSERVER_OUTBOX_DIR", originalOutbox);
      restoreEnv("EVELAND_DEPLOYMENT_ID", originalDeployment);
    }
  });

  test("carries subagent parent lineage from session.started into later envelopes", async () => {
    const releaseDir = await createRelease();
    const outboxDir = await mkdtemp(path.join(packageRoot, ".observer-outbox-test-"));
    temporaryDirectories.push(outboxDir);
    const result = await injectObserverHooks({ releaseDir });
    const observerPath = path.join(releaseDir, result.injectedFiles[0]!);
    const originalOutbox = process.env.EVELAND_OBSERVER_OUTBOX_DIR;
    const originalDeployment = process.env.EVELAND_DEPLOYMENT_ID;
    process.env.EVELAND_OBSERVER_OUTBOX_DIR = outboxDir;
    process.env.EVELAND_DEPLOYMENT_ID = "dep_1";

    try {
      const observer = (await import(`${observerPath}?lineage=${Date.now()}`)) as {
        default: { events: { "*": (event: unknown, context: unknown) => Promise<void> } };
      };
      const context = {
        session: { id: "eve_child", parent: { sessionId: "eve_parent", callId: "call_1" } },
        agent: { name: "child" },
        channel: { kind: "subagent" },
      };
      await observer.default.events["*"](
        { type: "session.started", data: {} },
        context,
      );
      await observer.default.events["*"]({ type: "step.completed", data: { turnId: "turn_1", stepIndex: 0 } }, context);

      const sessionDirectories = await readdir(path.join(outboxDir, "sessions"));
      const files = await readdir(path.join(outboxDir, "sessions", sessionDirectories[0]!));
      const envelopes = await Promise.all(
        files
          .filter((file) => file.endsWith(".ready.json"))
          .sort()
          .map(async (file) => JSON.parse(await readFile(path.join(outboxDir, "sessions", sessionDirectories[0]!, file), "utf8"))),
      );
      expect(envelopes).toHaveLength(2);
      expect(envelopes.map((envelope) => envelope.parentEveSessionId)).toEqual(["eve_parent", "eve_parent"]);
    } finally {
      restoreEnv("EVELAND_OBSERVER_OUTBOX_DIR", originalOutbox);
      restoreEnv("EVELAND_DEPLOYMENT_ID", originalDeployment);
    }
  });
});

async function createRelease(): Promise<string> {
  const releaseDir = await mkdtemp(path.join(packageRoot, ".observer-test-"));
  temporaryDirectories.push(releaseDir);
  await write("agent/instructions.md", "fixture", releaseDir);
  return releaseDir;
}

async function write(relativePath: string, content: string, root: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
