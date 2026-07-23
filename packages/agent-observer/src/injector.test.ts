import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { injectObserverHooks } from "./injector.js";

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
    expect(result.runtimeFile).toBe(
      ".eveland/observability/runtime.mjs",
    );
    expect(result.coverageGaps.map((gap) => path.basename(gap.path))).toEqual(["file-child.ts", "remote-child.ts"]);
    await expect(
      readFile(path.join(releaseDir, result.injectedFiles[0]!), "utf8"),
    ).resolves.toContain("../../.eveland/observability/runtime.mjs");
    await expect(
      readFile(path.join(releaseDir, result.injectedFiles[1]!), "utf8"),
    ).resolves.toContain(
      "../../../../.eveland/observability/runtime.mjs",
    );
  });

  test("fails instead of overwriting an authored reserved observer hook", async () => {
    const releaseDir = await createRelease();
    await write("agent/hooks/eveland-observer.js", "authored", releaseDir);

    await expect(injectObserverHooks({ releaseDir })).rejects.toThrow(/Reserved observer hook already exists/);
    await expect(readFile(path.join(releaseDir, "agent/hooks/eveland-observer.js"), "utf8")).resolves.toBe("authored");
  });

  test("does not modify user instrumentation or authored hooks", async () => {
    const releaseDir = await createRelease();
    const instrumentation = [
      'import { NodeSDK } from "@opentelemetry/sdk-node";',
      "const sdk = new NodeSDK();",
      "sdk.start();",
      "",
    ].join("\n");
    const authoredHook = 'export default { events: { "*": () => undefined } };\n';
    await write("instrumentation.ts", instrumentation, releaseDir);
    await write("agent/hooks/user-observer.ts", authoredHook, releaseDir);

    await injectObserverHooks({ releaseDir });

    await expect(readFile(path.join(releaseDir, "instrumentation.ts"), "utf8")).resolves.toBe(instrumentation);
    await expect(readFile(path.join(releaseDir, "agent/hooks/user-observer.ts"), "utf8")).resolves.toBe(authoredHook);
  });

  test("bundles a self-contained private OTel runtime and does not use the legacy outbox protocol", async () => {
    const releaseDir = await createRelease();
    const result = await injectObserverHooks({ releaseDir });
    const runtime = await readFile(
      path.join(releaseDir, result.runtimeFile!),
      "utf8",
    );

    expect(runtime).toContain("OTLPTraceExporter");
    expect(runtime).toContain(
      "/run/eveland/observability/agent-policy.json",
    );
    expect(runtime).toContain('from "eve/hooks"');
    expect(runtime).not.toContain("EVELAND_OBSERVER_OUTBOX_DIR");
    expect(runtime).not.toContain("EVELAND_TELEMETRY_ENABLED");
    expect(runtime).not.toContain('from "@eveland/');
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
