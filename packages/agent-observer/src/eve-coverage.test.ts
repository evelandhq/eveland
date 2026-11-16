import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { projectEveInfo } from "@evelandhq/core/discovery";
import { VERIFIED_EVE_VERSION } from "@evelandhq/core/eve-compatibility";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const EVE_PACKAGE = path.resolve(import.meta.dirname, "../node_modules/eve");
const EVE_BIN = path.join(EVE_PACKAGE, "bin/eve.js");

describe("Eve observer hook compatibility", () => {
  test("runs observer coverage against the verified Eve", async () => {
    const { stdout } = await execFileAsync(process.execPath, [EVE_BIN, "--version"]);

    expect(stdout.trim()).toBe(VERIFIED_EVE_VERSION);
  });

  test("Eve discovers packaged skills and exposes directory-form hook slots", async () => {
    const fixtureDir = await prepareFixture();
    try {
      const { stdout } = await execFileAsync(process.execPath, [EVE_BIN, "info", "--json"], {
        cwd: fixtureDir,
      });
      const info = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        artifacts: { discoveryManifest: string };
      };
      // v16 lists every authored source in one `sources` array; a source's
      // slot is the first segment of its logical path.
      type Source = { logicalPath: string; [field: string]: unknown };
      const manifest = JSON.parse(await readFile(info.artifacts.discoveryManifest, "utf8")) as {
        version: number;
        sources: Source[];
        subagents: Array<{ subagentId: string; manifest: { sources: Source[] } }>;
      };
      expect(manifest.version).toBe(16);
      const inSlot = (sources: Source[] | undefined, slot: string) =>
        (sources ?? []).filter((source) => source.logicalPath.split("/", 1)[0] === slot);

      expect(inSlot(manifest.sources, "connections")).toContainEqual(
        expect.objectContaining({
          connectionName: "warehouse",
          logicalPath: "connections/warehouse.ts",
        }),
      );
      expect(inSlot(manifest.sources, "hooks").map((hook) => hook.logicalPath)).toContain(
        "hooks/root-observer.ts",
      );
      expect(inSlot(manifest.sources, "skills")).toContainEqual(
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
      const child = (id: string) =>
        manifest.subagents.find((subagent) => subagent.subagentId === id)?.manifest.sources;
      expect(inSlot(child("directory-child"), "hooks").map((hook) => hook.logicalPath)).toContain(
        "hooks/child-observer.ts",
      );
      expect(inSlot(child("directory-child"), "connections")).toContainEqual(
        expect.objectContaining({
          connectionName: "research",
          logicalPath: "connections/research.ts",
        }),
      );
      expect(inSlot(child("file-child"), "hooks")).toEqual([]);
      expect(inSlot(child("remote-child"), "hooks")).toEqual([]);

      // The platform's build summary reads `eve info --json`; this is the
      // drift guard for @evelandhq/core/discovery against what the pinned
      // eve prints. The projection fails closed on a missing or mistyped
      // documented field, so a non-null result proves the shapes still
      // match, and every projected field is asserted so a change in any of
      // them fails here, not in production.
      expect(projectEveInfo(info)).toEqual({
        summarySource: "eve-info",
        status: "ready",
        layout: "nested",
        diagnostics: { errors: 0, warnings: 0 },
        model: expect.any(String),
        instructions: expect.stringContaining("instructions.md"),
        skills: expect.arrayContaining(["compatibility"]),
        tools: expect.any(Array),
        // eve info names declared subagents; a remote agent is not one.
        subagents: ["directory-child", "file-child"],
        schedules: [],
        channels: expect.arrayContaining(["eve"]),
      });

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
  }, 120_000);
});

async function prepareFixture(): Promise<string> {
  const sourceFixtureDir = path.resolve(import.meta.dirname, "../fixtures/eve-hooks");
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "eveland-eve-hooks-"));
  await cp(sourceFixtureDir, fixtureDir, {
    recursive: true,
    filter: (source) => {
      const topLevelEntry = path.relative(sourceFixtureDir, source).split(path.sep)[0] ?? "";
      return ![".eve", ".workflow-data", "node_modules"].includes(topLevelEntry);
    },
  });
  await writeFile(
    path.join(fixtureDir, "package.json"),
    `${JSON.stringify({ name: "eveland-eve-hooks-fixture", private: true, type: "module", dependencies: { eve: VERIFIED_EVE_VERSION } }, null, 2)}\n`,
  );
  await mkdir(path.join(fixtureDir, "node_modules"));
  await symlink(EVE_PACKAGE, path.join(fixtureDir, "node_modules/eve"), "dir");
  return fixtureDir;
}
