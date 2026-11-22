import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { unsupportedEveVersionMessage } from "@evelandhq/core/eve-compatibility";
import { readReleaseDiscovery, readReleaseSchedulerDefinitions } from "./discovery-artifacts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRelease(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-discovery-"));
  roots.push(root);
  return root;
}

async function installEve(releaseDir: string, version: string): Promise<void> {
  await mkdir(path.join(releaseDir, "node_modules", "eve"), { recursive: true });
  await writeFile(
    path.join(releaseDir, "node_modules", "eve", "package.json"),
    JSON.stringify({ name: "eve", version }),
  );
}

test("reads the saved eve info output and the installed eve version from a built release", async () => {
  const releaseDir = await makeRelease();
  await mkdir(path.join(releaseDir, ".eveland"), { recursive: true });
  // eve prints one JSON object; a CLI line may come before it.
  await writeFile(
    path.join(releaseDir, ".eveland", "eve-info.json"),
    'eve: compiling\n{"status":"ready","tools":["bash"]}\n',
  );
  await installEve(releaseDir, "1.0.0");

  await expect(readReleaseDiscovery(releaseDir)).resolves.toEqual({
    eveInfo: { status: "ready", tools: ["bash"] },
    resolvedEveVersion: "1.0.0",
  });
});

test("absent or unparseable eve info records no summary but still reports the installed eve", async () => {
  const bare = await makeRelease();
  await installEve(bare, "1.0.0");
  await expect(readReleaseDiscovery(bare)).resolves.toEqual({
    eveInfo: null,
    resolvedEveVersion: "1.0.0",
  });

  const corrupt = await makeRelease();
  await installEve(corrupt, "1.0.0");
  await mkdir(path.join(corrupt, ".eveland"), { recursive: true });
  await writeFile(path.join(corrupt, ".eveland", "eve-info.json"), "{not json");
  await expect(readReleaseDiscovery(corrupt)).resolves.toMatchObject({ eveInfo: null });
});

test("refuses a build whose installed eve is outside the hosted window, or unreadable", async () => {
  // `^1.0.0` is a valid declaration, but it may install a minor nobody verified.
  const newer = await makeRelease();
  await installEve(newer, "1.4.0");
  await expect(readReleaseDiscovery(newer)).rejects.toThrow(unsupportedEveVersionMessage("1.4.0"));

  const candidate = await makeRelease();
  await installEve(candidate, "1.0.0-rc.2");
  await expect(readReleaseDiscovery(candidate)).rejects.toThrow(/1\.0\.0-rc\.2/);

  const missing = await makeRelease();
  await expect(readReleaseDiscovery(missing)).rejects.toThrow(unsupportedEveVersionMessage(null));
});

test("reads the post-integration scheduler definitions from the built release", async () => {
  const releaseDir = await makeRelease();
  const definitions = [
    {
      key: "crm__sync",
      kind: "handler",
      cron: "0 2 * * *",
      timezone: "UTC",
      sourcePath: "agent/extensions/crm/schedules/sync.mjs",
      definitionHash: "a".repeat(64),
      modulePath: "node_modules/@acme/crm/dist/extension/schedules/sync.mjs",
    },
  ];
  await mkdir(path.join(releaseDir, ".eveland", "scheduler"), { recursive: true });
  await writeFile(
    path.join(releaseDir, ".eveland", "scheduler", "definitions.json"),
    JSON.stringify(definitions),
  );

  await expect(readReleaseSchedulerDefinitions(releaseDir)).resolves.toEqual(definitions);
});

test("fails the build when scheduler definitions are malformed", async () => {
  const releaseDir = await makeRelease();
  await mkdir(path.join(releaseDir, ".eveland", "scheduler"), { recursive: true });
  await writeFile(
    path.join(releaseDir, ".eveland", "scheduler", "definitions.json"),
    JSON.stringify([{ key: "crm__sync", cron: "not a complete definition" }]),
  );

  await expect(readReleaseSchedulerDefinitions(releaseDir)).rejects.toThrow(
    /invalid scheduler definitions/i,
  );
});

test("fails the build when post-integration scheduler definitions are missing", async () => {
  const releaseDir = await makeRelease();

  await expect(readReleaseSchedulerDefinitions(releaseDir)).rejects.toThrow(
    /required scheduler definitions/i,
  );
});
