import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const compatibilityMatrix = [
  { version: "0.24.6", fixtureName: "eve-0.24-hooks", packageName: "eve-0-24" },
  { version: "0.25.1", fixtureName: "eve-0.25-hooks", packageName: "eve" },
] as const;

describe("Eve observer hook compatibility matrix", () => {
  test("pins the previous Eve minor for the compatibility matrix", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };

    expect(packageJson.devDependencies["eve-0-24"]).toBe("npm:eve@0.24.6");
    expect(packageJson.devDependencies.eve).toBe("0.25.1");
  });

  test.each(compatibilityMatrix)("runs observer coverage against Eve $version", async ({ packageName, version }) => {
    const { stdout } = await execFileAsync(process.execPath, [eveBin(packageName), "--version"]);

    expect(stdout.trim()).toBe(version);
  });

  test.each(compatibilityMatrix)(
    "Eve $version exposes directory-form hook slots and reports the known file/remote gap",
    async ({ fixtureName, packageName }) => {
      const fixtureDir = await prepareFixture(fixtureName, packageName);
      try {
        const { stdout } = await execFileAsync(process.execPath, [eveBin(packageName), "info", "--json"], {
          cwd: fixtureDir,
        });
        const info = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
          artifacts: { discoveryManifest: string };
        };
        const manifest = JSON.parse(await readFile(info.artifacts.discoveryManifest, "utf8")) as {
          hooks: Array<{ logicalPath: string }>;
          subagents: Array<{
            subagentId: string;
            manifest: { hooks: Array<{ logicalPath: string }> };
          }>;
        };

        expect(manifest.hooks.map((hook) => hook.logicalPath)).toContain("hooks/root-observer.ts");
        expect(manifest.subagents.map((subagent) => subagent.subagentId)).toEqual([
          "directory-child",
          "file-child",
          "remote-child",
        ]);
        expect(
          manifest.subagents
            .find((subagent) => subagent.subagentId === "directory-child")
            ?.manifest.hooks.map((hook) => hook.logicalPath),
        ).toContain("hooks/child-observer.ts");
        expect(manifest.subagents.find((subagent) => subagent.subagentId === "file-child")?.manifest.hooks ?? []).toEqual([]);
        expect(manifest.subagents.find((subagent) => subagent.subagentId === "remote-child")?.manifest.hooks ?? []).toEqual([]);

        const compiledManifest = JSON.parse(
          await readFile(path.join(path.dirname(info.artifacts.discoveryManifest), "../compile/compiled-agent-manifest.json"), "utf8"),
        ) as { remoteAgents: Array<{ name: string; url: string; path: string }> };
        expect(compiledManifest.remoteAgents).toContainEqual(
          expect.objectContaining({ name: "remote-child", url: "https://remote.example.com", path: "/eve/v1/session" }),
        );
      } finally {
        await rm(fixtureDir, { recursive: true, force: true });
      }
    },
  );
});

function evePackage(packageName: string): string {
  return path.resolve(import.meta.dirname, `../node_modules/${packageName}`);
}

function eveBin(packageName: string): string {
  return path.join(evePackage(packageName), "bin/eve.js");
}

async function prepareFixture(fixtureName: string, packageName: string): Promise<string> {
  const sourceFixtureDir = path.resolve(import.meta.dirname, `../fixtures/${fixtureName}`);
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "eveland-eve-hooks-"));
  await cp(sourceFixtureDir, fixtureDir, {
    recursive: true,
    filter: (source) => {
      const topLevelEntry = path.relative(sourceFixtureDir, source).split(path.sep)[0] ?? "";
      return ![".eve", ".workflow-data", "node_modules"].includes(topLevelEntry);
    },
  });
  await mkdir(path.join(fixtureDir, "node_modules"));
  await symlink(evePackage(packageName), path.join(fixtureDir, "node_modules/eve"), "dir");
  return fixtureDir;
}
