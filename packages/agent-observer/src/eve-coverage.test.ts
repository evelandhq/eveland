import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const compatibilityMatrix = [
  { version: "0.25.3", fixtureName: "eve-0.25-hooks", packageName: "eve-0-25" },
  { version: "0.26.2", fixtureName: "eve-0.25-hooks", packageName: "eve-0-26" },
  { version: "0.27.12", fixtureName: "eve-0.25-hooks", packageName: "eve" },
] as const;

describe("Eve observer hook compatibility matrix", () => {
  test("pins the two previous Eve minors for the compatibility matrix", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };

    expect(packageJson.devDependencies["eve-0-25"]).toBe("npm:eve@0.25.3");
    expect(packageJson.devDependencies["eve-0-26"]).toBe("npm:eve@0.26.2");
    expect(packageJson.devDependencies.eve).toBe("0.27.12");
  });

  test.each(compatibilityMatrix)("runs observer coverage against Eve $version", async ({ packageName, version }) => {
    const { stdout } = await execFileAsync(process.execPath, [eveBin(packageName), "--version"]);

    expect(stdout.trim()).toBe(version);
  });

  test.each(compatibilityMatrix)(
    "Eve $version discovers packaged skills and exposes directory-form hook slots",
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
          skills: Array<{ name: string; logicalPath: string; sourceKind: string }>;
          subagents: Array<{
            subagentId: string;
            manifest: { hooks: Array<{ logicalPath: string }> };
          }>;
        };

        expect(manifest.hooks.map((hook) => hook.logicalPath)).toContain("hooks/root-observer.ts");
        expect(manifest.skills).toContainEqual(
          expect.objectContaining({
            name: "compatibility",
            logicalPath: "skills/compatibility/SKILL.md",
            sourceKind: "skill-package",
          }),
        );
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

        const compileDir = path.join(path.dirname(info.artifacts.discoveryManifest), "../compile");
        const compiledManifest = JSON.parse(
          await readFile(path.join(compileDir, "compiled-agent-manifest.json"), "utf8"),
        ) as {
          remoteAgents: Array<{ name: string; url: string; path: string }>;
          skills: Array<{ name: string; sourceKind: string }>;
          workspaceResourceRoot: { logicalPath: string };
        };
        expect(compiledManifest.remoteAgents).toContainEqual(
          expect.objectContaining({ name: "remote-child", url: "https://remote.example.com", path: "/eve/v1/session" }),
        );
        expect(compiledManifest.skills).toContainEqual(
          expect.objectContaining({ name: "compatibility", sourceKind: "skill-package" }),
        );
        const skillRoot = path.join(
          compileDir,
          compiledManifest.workspaceResourceRoot.logicalPath,
          "skills",
          "compatibility",
        );
        await expect(readFile(path.join(skillRoot, "SKILL.md"), "utf8")).resolves.toContain(
          "Follow the packaged compatibility checklist",
        );
        await expect(readFile(path.join(skillRoot, "references/checklist.md"), "utf8")).resolves.toContain(
          "Confirm the packaged reference",
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
  const version = compatibilityMatrix.find((entry) => entry.packageName === packageName)?.version;
  if (version === undefined) throw new Error(`Unknown Eve fixture package ${packageName}.`);
  await writeFile(
    path.join(fixtureDir, "package.json"),
    `${JSON.stringify({ name: "eveland-eve-hooks-fixture", private: true, type: "module", dependencies: { eve: version } }, null, 2)}\n`,
  );
  await mkdir(path.join(fixtureDir, "node_modules"));
  await symlink(evePackage(packageName), path.join(fixtureDir, "node_modules/eve"), "dir");
  return fixtureDir;
}
