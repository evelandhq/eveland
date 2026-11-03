import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MODEL_GATEWAY_ENV, MODEL_GATEWAY_KINDS } from "@evelandhq/core/model-gateway";
import { describe, expect, test } from "vitest";

import {
  MODEL_GATEWAY_INSTRUMENTATION_FILE,
  MODEL_GATEWAY_RUNTIME_FILE,
  bundleModelGatewayRuntime,
  injectModelGateway,
} from "./model-gateway-injection.js";

async function releaseWithAgentDir(): Promise<string> {
  const releaseDir = await mkdtemp(path.join(tmpdir(), "eveland-model-gateway-"));
  await mkdir(path.join(releaseDir, "agent"), { recursive: true });
  await writeFile(path.join(releaseDir, "agent", "instructions.md"), "Be brief.\n");
  return releaseDir;
}

describe("injectModelGateway", () => {
  test("writes the instrumentation shim and the bundled runtime into an eve 1.0 release", async () => {
    const releaseDir = await releaseWithAgentDir();

    const result = await injectModelGateway({ releaseDir, eveVersion: "1.0.0-rc.2" });

    expect(result).toEqual({
      status: "injected",
      injectedFiles: [`agent/instrumentation/${MODEL_GATEWAY_INSTRUMENTATION_FILE}`],
      runtimeFile: MODEL_GATEWAY_RUNTIME_FILE,
    });
    const shim = await readFile(
      path.join(releaseDir, "agent", "instrumentation", MODEL_GATEWAY_INSTRUMENTATION_FILE),
      "utf8",
    );
    expect(shim).toContain('import { defineInstrumentation } from "eve/instrumentation";');
    expect(shim).toContain('from "../../.eveland/model-gateway/runtime.mjs"');
    expect(shim).toContain("setup()");
    await expect(
      readFile(path.join(releaseDir, MODEL_GATEWAY_RUNTIME_FILE), "utf8"),
    ).resolves.toContain("installModelGateway");
  });

  test("uses the release root as the agent root when there is no agent/ directory", async () => {
    const releaseDir = await mkdtemp(path.join(tmpdir(), "eveland-model-gateway-root-"));
    await writeFile(path.join(releaseDir, "instructions.md"), "Be brief.\n");

    const result = await injectModelGateway({ releaseDir, eveVersion: "1.0.0" });

    expect(result).toMatchObject({
      status: "injected",
      injectedFiles: [`instrumentation/${MODEL_GATEWAY_INSTRUMENTATION_FILE}`],
    });
    const shim = await readFile(
      path.join(releaseDir, "instrumentation", MODEL_GATEWAY_INSTRUMENTATION_FILE),
      "utf8",
    );
    expect(shim).toContain('from "../.eveland/model-gateway/runtime.mjs"');
  });

  test("skips an eve 0.83 release, whose model calls stay as authored", async () => {
    const releaseDir = await releaseWithAgentDir();

    const result = await injectModelGateway({ releaseDir, eveVersion: "0.83.3" });

    expect(result).toEqual({ status: "skipped", reason: "eve-version" });
    await expect(
      readFile(path.join(releaseDir, MODEL_GATEWAY_RUNTIME_FILE), "utf8"),
    ).rejects.toThrow();
  });

  test("skips a release whose eve version could not be read, without claiming it is too old", async () => {
    const releaseDir = await releaseWithAgentDir();

    await expect(injectModelGateway({ releaseDir, eveVersion: "" })).resolves.toEqual({
      status: "skipped",
      reason: "eve-unknown",
    });
  });

  test.each(["eveland-model-gateway.ts", "eveland-model-gateway.js", "eveland-model-gateway.mts"])(
    "refuses to overwrite an authored instrumentation file named %s",
    async (authored) => {
      const releaseDir = await releaseWithAgentDir();
      await mkdir(path.join(releaseDir, "agent", "instrumentation"));
      await writeFile(path.join(releaseDir, "agent", "instrumentation", authored), "export {};\n");

      await expect(injectModelGateway({ releaseDir, eveVersion: "1.0.0-rc.2" })).rejects.toThrow(
        /Reserved instrumentation file .*eveland-model-gateway.* already exists/,
      );
    },
  );
});

describe("bundled Model Gateway runtime", () => {
  test("is self-contained: no bare imports left for the release to resolve", async () => {
    const bundle = await bundleModelGatewayRuntime();
    const bareImports = [
      ...bundle.matchAll(/(?:^|[\s;])import\s*(?:[^"';]*?from\s*)?["']([^"']+)["']/g),
    ]
      .map((match) => match[1]!)
      .filter((specifier) => !specifier.startsWith("node:"));
    expect(bareImports).toEqual([]);
  });

  // The Worker writes these variable names and the runtime reads them; this is
  // the one place both sides meet, so a rename on either side fails here.
  test.each(MODEL_GATEWAY_KINDS)(
    "installs a %s provider from the reserved variables the Worker delivers",
    async (kind) => {
      const releaseDir = await releaseWithAgentDir();
      await injectModelGateway({ releaseDir, eveVersion: "1.0.0-rc.2" });
      const runtime = (await import(
        pathToFileURL(path.join(releaseDir, MODEL_GATEWAY_RUNTIME_FILE)).href
      )) as {
        installModelGateway(options: { env: Record<string, string>; target: object }): unknown;
      };

      const target: Record<string, unknown> = {};
      const env = {
        [MODEL_GATEWAY_ENV.kind]: kind,
        [MODEL_GATEWAY_ENV.url]: "https://gateway.example/v1",
        [MODEL_GATEWAY_ENV.key]: "sk-project",
      };
      expect(runtime.installModelGateway({ env, target })).toEqual({ status: "installed", kind });
      expect(target.AI_SDK_DEFAULT_PROVIDER).toBeDefined();
    },
  );
});
