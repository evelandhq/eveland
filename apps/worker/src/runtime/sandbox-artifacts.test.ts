import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertReleaseSandboxArtifacts,
  platformSandboxArtifactsProblem,
  SANDBOX_PREPARED_ARTIFACTS_RELEASE_PATH,
} from "./sandbox-artifacts.js";

const manifest = (...entries: Array<{ nodeId: string; providerName: string }>) => ({
  kind: "eve-sandbox-prepared-artifacts",
  version: 2,
  entries: entries.map((entry) => ({ ...entry, artifact: { version: 1, templatePath: "/t" } })),
});

describe("platformSandboxArtifactsProblem", () => {
  test("accepts a Release whose every prepared sandbox is on bwrap", () => {
    expect(
      platformSandboxArtifactsProblem(
        manifest(
          { nodeId: "__root__", providerName: "bwrap" },
          { nodeId: "researcher", providerName: "bwrap" },
        ),
      ),
    ).toBeNull();
  });

  test("names every sandbox prepared on another provider", () => {
    const problem = platformSandboxArtifactsProblem(
      manifest(
        { nodeId: "__root__", providerName: "bwrap" },
        { nodeId: "helper-built", providerName: "docker" },
        { nodeId: "extension:acme", providerName: "acme" },
      ),
    );

    expect(problem).toContain("helper-built (docker), extension:acme (acme)");
    expect(problem).toContain("eve/sandbox/provider");
  });

  test.each([null, {}, { entries: [] }, { entries: "nope" }])(
    "refuses a Release with no prepared sandbox at all (%j)",
    (value) => {
      expect(platformSandboxArtifactsProblem(value)).toMatch(/recorded no prepared sandbox/);
    },
  );
});

describe("assertReleaseSandboxArtifacts", () => {
  async function release(contents?: unknown): Promise<string> {
    const releaseDir = await mkdtemp(path.join(os.tmpdir(), "eveland-artifacts-"));
    if (contents !== undefined) {
      const file = path.join(releaseDir, SANDBOX_PREPARED_ARTIFACTS_RELEASE_PATH);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(contents));
    }
    return releaseDir;
  }

  test("reads the manifest eve bundled into the build output", async () => {
    await expect(
      assertReleaseSandboxArtifacts(
        await release(manifest({ nodeId: "__root__", providerName: "bwrap" })),
      ),
    ).resolves.toBeUndefined();
  });

  test("treats a missing manifest as no prepared sandbox", async () => {
    await expect(assertReleaseSandboxArtifacts(await release())).rejects.toThrow(
      /recorded no prepared sandbox/,
    );
  });

  test("refuses a foreign provider", async () => {
    await expect(
      assertReleaseSandboxArtifacts(
        await release(manifest({ nodeId: "__root__", providerName: "default" })),
      ),
    ).rejects.toThrow(/__root__ \(default\)/);
  });
});
