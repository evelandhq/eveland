import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { injectModelGatewayRuntime } from "./injector.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRelease(layout: "nested" | "flat"): Promise<string> {
  const releaseDir = await mkdtemp(path.join(tmpdir(), "mg-inject-"));
  roots.push(releaseDir);
  const agentRoot = layout === "nested" ? path.join(releaseDir, "agent") : releaseDir;
  await mkdir(agentRoot, { recursive: true });
  await writeFile(path.join(agentRoot, "agent.ts"), "export default {};\n", "utf8");
  return releaseDir;
}

test("injects a hook shim and a baked runtime into a nested-agent release", async () => {
  const releaseDir = await makeRelease("nested");
  const result = await injectModelGatewayRuntime({ releaseDir });

  expect(result.injectedFiles).toEqual(["agent/hooks/eveland-model-gateway.js"]);
  expect(result.runtimeFile).toBe(".eveland/model-gateway/runtime.mjs");

  const shim = await readFile(
    path.join(releaseDir, "agent/hooks/eveland-model-gateway.js"),
    "utf8",
  );
  expect(shim).toContain('import { defineHook } from "eve/hooks"');
  expect(shim).toContain("../../.eveland/model-gateway/runtime.mjs");
});

test("injects at the release root when there is no nested agent directory", async () => {
  const releaseDir = await makeRelease("flat");
  const result = await injectModelGatewayRuntime({ releaseDir });
  expect(result.injectedFiles).toEqual(["hooks/eveland-model-gateway.js"]);
});

test("skips injection when the release has no agent root", async () => {
  const releaseDir = await mkdtemp(path.join(tmpdir(), "mg-inject-"));
  roots.push(releaseDir);
  await writeFile(path.join(releaseDir, "README.md"), "not an agent", "utf8");
  const result = await injectModelGatewayRuntime({ releaseDir });
  expect(result).toEqual({ injectedFiles: [] });
});

test("refuses to overwrite an authored hook with the reserved name", async () => {
  const releaseDir = await makeRelease("nested");
  await mkdir(path.join(releaseDir, "agent/hooks"), { recursive: true });
  await writeFile(
    path.join(releaseDir, "agent/hooks/eveland-model-gateway.js"),
    "authored",
    "utf8",
  );
  await expect(injectModelGatewayRuntime({ releaseDir })).rejects.toThrow(/Reserved/);
});

test("the baked runtime is self-contained and installs the default provider on import", async () => {
  const releaseDir = await makeRelease("nested");
  await injectModelGatewayRuntime({ releaseDir });
  const runtimePath = path.join(releaseDir, ".eveland/model-gateway/runtime.mjs");
  const runtime = await readFile(runtimePath, "utf8");
  expect(runtime).not.toMatch(/from\s*["']@ai-sdk\//);
  expect(runtime).not.toMatch(/from\s*["']eve["']/);

  vi.stubEnv("EVELAND_MODEL_GATEWAY_URL", "http://127.0.0.1:59999");
  vi.stubEnv("AI_GATEWAY_API_KEY", "emg_test_token");
  const module = (await import(pathToFileURL(runtimePath).href)) as {
    default: { events: Record<string, unknown> };
  };

  expect(module.default).toHaveProperty("events");
  const provider = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER as
    | { languageModel: (id: string) => { modelId: string } }
    | undefined;
  expect(provider).toBeDefined();
  expect(provider!.languageModel("zai/glm-5.3-flash").modelId).toBe("zai/glm-5.3-flash");
});
