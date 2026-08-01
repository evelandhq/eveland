import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { projectDiscoveryManifest } from "./discovery.js";

const fixtureManifest = new URL(
  "../../agent-observer/fixtures/eve-0.24-hooks/.eve/discovery/agent-discovery-manifest.json",
  import.meta.url,
);

describe("projectDiscoveryManifest", () => {
  test("projects a real eve discovery manifest onto the platform summary shape", async () => {
    const manifest = JSON.parse(await readFile(fixtureManifest, "utf8")) as unknown;

    const projection = projectDiscoveryManifest(manifest);

    expect(projection).toMatchObject({
      summarySource: "build-manifest",
      agentId: "eveland-observer-coverage-fixture",
      layout: "nested",
      diagnostics: { errors: 0, warnings: 0 },
      instructions: ["agent/instructions.md"],
      hooks: ["agent/hooks/root-observer.ts"],
    });
    expect(projection?.manifestVersion).toBeGreaterThan(0);
    expect(projection?.subagents).toContain("agent/subagents/directory-child");
    expect(projection?.subagents).toContain("agent/subagents/file-child.ts");
    expect(projection?.subagentIds).toEqual(
      expect.arrayContaining(["directory-child", "file-child", "remote-child"]),
    );
    // The projection never claims fields only the static scan can know.
    expect(projection).not.toHaveProperty("agents");
    expect(projection).not.toHaveProperty("capabilities");
  });

  test("projects a flat-layout manifest without a path prefix", () => {
    const projection = projectDiscoveryManifest({
      kind: "eve-agent-discovery-manifest",
      version: 12,
      agentId: "flat-fixture",
      agentRoot: "/srv/app",
      appRoot: "/srv/app",
      instructions: [{ logicalPath: "instructions.md" }],
      tools: [{ logicalPath: "tools/get_weather.ts" }],
      schedules: [{ logicalPath: "schedules/cleanup.ts" }],
      sandbox: { logicalPath: "sandbox.ts" },
      subagents: [],
      diagnosticsSummary: { errors: 0, warnings: 1 },
    });

    expect(projection).toMatchObject({
      layout: "flat",
      instructions: ["instructions.md"],
      tools: ["tools/get_weather.ts"],
      schedules: ["schedules/cleanup.ts"],
      sandbox: ["sandbox.ts"],
      diagnostics: { errors: 0, warnings: 1 },
    });
  });

  test("returns null for anything that is not a discovery manifest", () => {
    expect(projectDiscoveryManifest(null)).toBeNull();
    expect(projectDiscoveryManifest({ kind: "something-else", version: 12 })).toBeNull();
    expect(projectDiscoveryManifest({ kind: "eve-agent-discovery-manifest" })).toBeNull();
    expect(projectDiscoveryManifest([])).toBeNull();
  });

  test("tolerates missing entity arrays instead of failing the projection", () => {
    const projection = projectDiscoveryManifest({
      kind: "eve-agent-discovery-manifest",
      version: 99,
      agentRoot: "/srv/app/agent",
      appRoot: "/srv/app",
    });

    expect(projection).toMatchObject({
      manifestVersion: 99,
      layout: "nested",
      agentId: null,
      diagnostics: null,
      instructions: [],
      tools: [],
      subagents: [],
      channels: [],
    });
  });
});
