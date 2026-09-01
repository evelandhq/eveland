import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { projectDiscoveryManifest } from "@evelandhq/core/discovery";
import { EVE_COMPATIBILITY_POLICY } from "@evelandhq/core/eve-compatibility";
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
    "Eve $version leaves global AI SDK telemetry integrations reachable for model capture",
    async ({ packageName, version }) => {
      // model-capture.ts registers on globalThis.AI_SDK_TELEMETRY_INTEGRATIONS,
      // which the AI SDK consults only when a call passes no per-call
      // `integrations`: a per-call list REPLACES the global registrations
      // rather than adding to them. Two generations sit in the window. Through
      // 0.33 Eve passed a per-call list solely when authored instrumentation
      // defined AI SDK hooks, so every other call left `integrations` undefined
      // and the global registration was reached. From 0.34 Eve spreads the
      // global registrations into the per-call list itself, which additionally
      // closes the gap on the calls that did pass one. From 0.47.3 the
      // no-authored-integration arm forks again: when Eve must sanitize its
      // own integration's error content it passes the spread global list
      // explicitly, and otherwise falls back to `void 0` — the AI SDK global
      // path. 0.47.5 moved the expression wholesale from harness/tool-loop.js
      // into the new instrumentation/runtime.js (the harness/instrumentation
      // restructure that shipped alongside the code-mode workflow runtime):
      // same three arms, but the guard became a `bridgeIntegration` property
      // access and the spread became a local `integrations()` closure over
      // `getRegisteredTelemetryIntegrations({sanitizeEveOtelErrors})`. Every
      // arm keeps third-party global registrations reachable, and the sanitize
      // path substitutes only Eve's own integration by identity (the `map` in
      // ai-sdk-telemetry.js compares `e !== eveOtelIntegration`), so
      // model-capture's integration is never wrapped — re-verified 2026-09-01.
      // If either pinned expression changes shape in a new Eve line, re-verify
      // model-capture.ts against it before bumping the matrix. The minifier is
      // free to rename the locals (0.44.0 emitted `r`, 0.44.3 `i`), so the
      // pins capture identifiers instead of spelling them.
      const evePackageDir = await realpath(evePackage(packageName));
      const [, minorText, patchText] = version.split(".");
      const minor = Number(minorText);
      const patch = Number(patchText);
      const movedToInstrumentationRuntime = minor > 47 || (minor === 47 && patch >= 5);
      const integrationsSource = await readFile(
        path.join(
          evePackageDir,
          movedToInstrumentationRuntime
            ? "dist/src/instrumentation/runtime.js"
            : "dist/src/harness/tool-loop.js",
        ),
        "utf8",
      );
      expect(integrationsSource).toMatch(
        movedToInstrumentationRuntime
          ? /integrations:(\w+)\.(\w+)===void 0\?\w+\?\[\.\.\.(\w+)\(\)\]:void 0:\[\1\.\2,\.\.\.\3\(\)\]/
          : minor === 47 && patch >= 3
            ? /integrations:(\w+)===void 0\?\w+\?\[\.\.\.(\w+)\(\)\]:void 0:\[\1,\.\.\.\2\(\)\]/
            : minor >= 34
              ? /integrations:(\w+)===void 0\?void 0:\[\1,\.\.\.getRegisteredTelemetryIntegrations\(\)\]/
              : /integrations:(\w+)===void 0\?void 0:\w+===void 0\?\[\1\]:\[\1,createOtelIntegration\(\)\]/,
      );

      const aiDist = await readFile(path.join(evePackageDir, "../ai/dist/index.js"), "utf8");
      expect(aiDist).toContain("globalThis.AI_SDK_TELEMETRY_INTEGRATIONS");
      expect(aiDist).toMatch(
        /localIntegrations != null \? asArray\d*\(localIntegrations\) : getGlobalTelemetryIntegrations\(\)/,
      );
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
        // @evelandhq/core/discovery against eve's discovery output. The
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
