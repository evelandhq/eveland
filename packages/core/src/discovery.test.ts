import { describe, expect, test } from "vitest";
import { projectDiscoveryManifest } from "./discovery.js";

// Field-faithful copy of a manifest eve 0.24+ generates (fixture .eve/ artifacts
// are gitignored, so the shape is inlined here). The drift guard against what
// eve actually writes is the agent-observer compatibility matrix, which runs
// this projection on manifests generated live by each pinned eve binary.
const nestedManifest = {
  kind: "eve-agent-discovery-manifest",
  version: 12,
  agentId: "eveland-observer-coverage-fixture",
  agentRoot: "/srv/app/agent",
  appRoot: "/srv/app",
  channels: [],
  connections: [],
  diagnosticsSummary: { errors: 0, warnings: 0 },
  hooks: [{ sourceKind: "module", logicalPath: "hooks/root-observer.ts", sourceId: "hooks/root-observer.ts" }],
  instructions: [{ sourceKind: "markdown", logicalPath: "instructions.md", sourceId: "instructions.md" }],
  sandbox: null,
  schedules: [],
  skills: [],
  tools: [],
  subagents: [
    { logicalPath: "subagents/directory-child", subagentId: "directory-child", manifest: {} },
    { logicalPath: "subagents/file-child.ts", subagentId: "file-child", manifest: {} },
    { logicalPath: "subagents/remote-child.ts", subagentId: "remote-child", manifest: {} },
  ],
};

describe("projectDiscoveryManifest", () => {
  test("projects a nested-layout eve discovery manifest onto the platform summary shape", () => {
    const projection = projectDiscoveryManifest(nestedManifest);

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
