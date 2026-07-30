import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { bundleObserverRuntime, injectObserverHooks } from "./injector.js";

const execFileAsync = promisify(execFile);
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
    expect(result.observerContract).toBe(2);
    const rootShim = await readFile(
      path.join(releaseDir, result.injectedFiles[0]!),
      "utf8",
    );
    expect(rootShim).toContain(
      "file:///run/eveland/observability/runtime.mjs",
    );
    expect(rootShim).toContain("../../.eveland/observability/runtime.mjs");
    expect(rootShim).toContain('import { defineHook } from "eve/hooks"');
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

  test("bundles a self-contained private OTel runtime controlled only by its runtime policy", async () => {
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
    // The bundle must load from the observability mount, where the Agent's
    // node_modules is not resolvable: nothing but node builtins may survive.
    expect(runtime).not.toContain('from "eve/hooks"');
    expect(runtime).not.toContain("EVELAND_TELEMETRY_ENABLED");
    expect(runtime).not.toContain('from "@eveland/');
  });

  test("shim falls back to the baked runtime when no platform runtime is mounted", async () => {
    const releaseDir = await createRelease();
    const result = await injectObserverHooks({ releaseDir });

    // Import the shim in a plain Node process, as Eve would -- vitest's module
    // pipeline would paper over bundling defects like an unshimmed CJS
    // require. /run/eveland is absent here, so this exercises the
    // baked-bundle fallback end to end.
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      `const shim = await import(${JSON.stringify(
        path.join(releaseDir, result.injectedFiles[0]!),
      )}); console.log(typeof shim.default?.events?.["*"]);`,
    ]);

    expect(stdout.trim()).toBe("function");
  });

  test("bakes the identical bundle the Worker delivers into deployments", async () => {
    const releaseDir = await createRelease();
    const result = await injectObserverHooks({ releaseDir });
    const baked = await readFile(
      path.join(releaseDir, result.runtimeFile!),
      "utf8",
    );

    await expect(bundleObserverRuntime()).resolves.toBe(baked);
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
