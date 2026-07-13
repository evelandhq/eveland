import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareReleaseTree } from "./prepare-release.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("copies source into a prepared release and injects observers without modifying the import", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-release-"));
  roots.push(root);
  const sourcePath = path.join(root, "source");
  const buildDir = path.join(root, "build");
  await mkdir(path.join(sourcePath, "agent", "subagents", "child"), { recursive: true });
  await writeFile(path.join(sourcePath, "agent", "instructions.md"), "root");
  await writeFile(path.join(sourcePath, "agent", "subagents", "child", "agent.ts"), "export default {}");

  const result = await prepareReleaseTree({ sourcePath, buildDir });

  expect(result.injectedFiles).toEqual([
    "agent/hooks/eveland-observer.js",
    "agent/subagents/child/hooks/eveland-observer.js",
  ]);
  await expect(readFile(path.join(buildDir, result.injectedFiles[0]!), "utf8")).resolves.toContain("defineHook");
  await expect(readFile(path.join(sourcePath, "agent/hooks/__eveland_observer.js"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
