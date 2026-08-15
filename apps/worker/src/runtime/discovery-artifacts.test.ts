import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { readReleaseDiscovery } from "./discovery-artifacts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRelease(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-discovery-"));
  roots.push(root);
  return root;
}

test("reads the discovery manifest and the installed eve version from a built release", async () => {
  const releaseDir = await makeRelease();
  await mkdir(path.join(releaseDir, ".eve", "discovery"), { recursive: true });
  await mkdir(path.join(releaseDir, "node_modules", "eve"), { recursive: true });
  await writeFile(
    path.join(releaseDir, ".eve", "discovery", "agent-discovery-manifest.json"),
    JSON.stringify({ kind: "eve-agent-discovery-manifest", version: 13 }),
  );
  await writeFile(
    path.join(releaseDir, "node_modules", "eve", "package.json"),
    JSON.stringify({ name: "eve", version: "0.38.3" }),
  );

  await expect(readReleaseDiscovery(releaseDir)).resolves.toEqual({
    manifest: { kind: "eve-agent-discovery-manifest", version: 13 },
    resolvedEveVersion: "0.38.3",
  });
});

test("returns undefined when the manifest is absent, and null version when eve is not installed", async () => {
  const bare = await makeRelease();
  await expect(readReleaseDiscovery(bare)).resolves.toBeUndefined();

  const manifestOnly = await makeRelease();
  await mkdir(path.join(manifestOnly, ".eve", "discovery"), { recursive: true });
  await writeFile(
    path.join(manifestOnly, ".eve", "discovery", "agent-discovery-manifest.json"),
    JSON.stringify({ kind: "eve-agent-discovery-manifest", version: 12 }),
  );
  await expect(readReleaseDiscovery(manifestOnly)).resolves.toEqual({
    manifest: { kind: "eve-agent-discovery-manifest", version: 12 },
    resolvedEveVersion: null,
  });
});

test("swallows a corrupt manifest instead of failing the build path", async () => {
  const releaseDir = await makeRelease();
  await mkdir(path.join(releaseDir, ".eve", "discovery"), { recursive: true });
  await writeFile(
    path.join(releaseDir, ".eve", "discovery", "agent-discovery-manifest.json"),
    "{not json",
  );

  await expect(readReleaseDiscovery(releaseDir)).resolves.toBeUndefined();
});
