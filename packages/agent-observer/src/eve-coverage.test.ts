import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { projectDiscoveryManifest } from "@eveland/core/discovery";
import { EVE_COMPATIBILITY_POLICY } from "@eveland/core/eve-compatibility";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const compatibilityMatrix = EVE_COMPATIBILITY_POLICY.supportedLines.map(
  ({ verifiedVersion, dependencyName }) => ({
    version: verifiedVersion,
    fixtureName: "matrix-hooks",
    packageName: dependencyName,
  }),
);

describe("Eve observer hook compatibility matrix", () => {
  test.each(compatibilityMatrix)(
    "runs observer coverage against Eve $version",
    async ({ packageName, version }) => {
      const { stdout } = await execFileAsync(process.execPath, [eveBin(packageName), "--version"]);

      expect(stdout.trim()).toBe(version);
    },
  );

  test.each(compatibilityMatrix)(
    "Eve $version discovers packaged skills and exposes directory-form hook slots",
    async ({ fixtureName, packageName }) => {
      const fixtureDir = await prepareFixture(fixtureName, packageName);
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [eveBin(packageName), "info", "--json"],
          {
            cwd: fixtureDir,
          },
        );
        const info = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
          artifacts: { discoveryManifest: string };
        };
        const manifest = JSON.parse(await readFile(info.artifacts.discoveryManifest, "utf8")) as {
          connections: Array<{ connectionName: string; logicalPath: string }>;
          hooks: Array<{ logicalPath: string }>;
          skills: Array<{ name: string; logicalPath: string; sourceKind: string }>;
          subagents: Array<{
            subagentId: string;
            manifest: {
              connections: Array<{ connectionName: string; logicalPath: string }>;
              hooks: Array<{ logicalPath: string }>;
            };
          }>;
        };

        expect(manifest.connections).toContainEqual(
          expect.objectContaining({
            connectionName: "warehouse",
            logicalPath: "connections/warehouse.ts",
          }),
        );
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
        expect(
          manifest.subagents.find((subagent) => subagent.subagentId === "directory-child")?.manifest
            .connections,
        ).toContainEqual(
          expect.objectContaining({
            connectionName: "research",
            logicalPath: "connections/research.ts",
          }),
        );
        expect(
          manifest.subagents.find((subagent) => subagent.subagentId === "file-child")?.manifest
            .hooks ?? [],
        ).toEqual([]);
        expect(
          manifest.subagents.find((subagent) => subagent.subagentId === "remote-child")?.manifest
            .hooks ?? [],
        ).toEqual([]);

        // The platform's build-time summary projection must understand every
        // matrix version's real manifest -- this is the drift guard for
        // @eveland/core/discovery against eve's discovery output. The
        // projection fails closed on unknown schema versions or missing entity
        // arrays, so a non-null result here also proves the version allowlist
        // and required-field expectations still match what eve writes; every
        // projected field is asserted so a shape change in any of them fails
        // the matrix, not production.
        const projection = projectDiscoveryManifest(manifest);
        expect(projection).toMatchObject({
          summarySource: "build-manifest",
          layout: "nested",
          agentId: expect.any(String),
          diagnostics: { errors: 0, warnings: 0 },
          instructions: ["agent/instructions.md"],
          hooks: ["agent/hooks/root-observer.ts"],
          tools: [],
          connections: ["agent/connections/warehouse.ts"],
          schedules: [],
          channels: [],
          sandbox: [],
        });
        expect(projection?.skills).toContain("agent/skills/compatibility/SKILL.md");
        expect(projection?.subagents).toEqual([
          "agent/subagents/directory-child",
          "agent/subagents/file-child.ts",
          "agent/subagents/remote-child.ts",
        ]);
        expect(projection?.subagentIds).toEqual(["directory-child", "file-child", "remote-child"]);

        const compileDir = path.join(path.dirname(info.artifacts.discoveryManifest), "../compile");
        const compiledManifest = JSON.parse(
          await readFile(path.join(compileDir, "compiled-agent-manifest.json"), "utf8"),
        ) as {
          remoteAgents: Array<{ name: string; url: string; path: string }>;
          skills: Array<{ name: string; sourceKind: string }>;
          workspaceResourceRoot: { logicalPath: string };
        };
        expect(compiledManifest.remoteAgents).toContainEqual(
          expect.objectContaining({
            name: "remote-child",
            url: "https://remote.example.com",
            path: "/eve/v1/session",
          }),
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
        await expect(
          readFile(path.join(skillRoot, "references/checklist.md"), "utf8"),
        ).resolves.toContain("Confirm the packaged reference");
      } finally {
        await rm(fixtureDir, { recursive: true, force: true });
      }
    },
    120_000,
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
