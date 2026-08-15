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
  hooks: [
    {
      sourceKind: "module",
      logicalPath: "hooks/root-observer.ts",
      sourceId: "hooks/root-observer.ts",
    },
  ],
  instructions: [
    { sourceKind: "markdown", logicalPath: "instructions.md", sourceId: "instructions.md" },
  ],
  sandbox: null,
  schedules: [],
  skills: [],
  tools: [],
  subagents: [
    { logicalPath: "subagents/directory-child", subagentId: "directory-child", manifest: {} },
    { logicalPath: "subagents/file-child.ts", subagentId: "file-child", manifest: {} },
    { logicalPath: "subagents/remote-child.ts", subagentId: "remote-child", manifest: {} },
  ],
  extensions: [],
  resolvedExtensions: [],
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
      ...nestedManifest,
      agentId: "flat-fixture",
      agentRoot: "/srv/app",
      appRoot: "/srv/app",
      instructions: [{ logicalPath: "instructions.md" }],
      tools: [{ logicalPath: "tools/get_weather.ts" }],
      schedules: [{ logicalPath: "schedules/cleanup.ts" }],
      sandbox: { logicalPath: "sandbox.ts" },
      subagents: [],
      hooks: [],
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

  test("projects the Eve 0.35+ discovery manifest schema", () => {
    const projection = projectDiscoveryManifest({
      ...nestedManifest,
      version: 13,
      instructions: [
        {
          sourceKind: "module",
          logicalPath: "instructions/context.ts",
          sourceId: "instructions/context.ts",
          role: "user",
        },
      ],
    });

    expect(projection).toMatchObject({
      manifestVersion: 13,
      instructions: ["agent/instructions/context.ts"],
    });
  });

  test("projects effective Extension schedules and subagents under their mount namespace", () => {
    const extensionManifest = {
      ...nestedManifest,
      agentId: "crm-extension",
      agentRoot: "/srv/app/node_modules/@acme/crm/dist/extension",
      appRoot: "/srv/app/node_modules/@acme/crm",
      schedules: [{ logicalPath: "schedules/sync.mjs" }, { logicalPath: "schedules/report.md" }],
      subagents: [
        {
          logicalPath: "subagents/reviewer",
          subagentId: "reviewer",
          manifest: { ...nestedManifest, subagents: [] },
        },
      ],
    };
    const overrideManifest = {
      ...nestedManifest,
      agentId: "crm-overrides",
      agentRoot: "/srv/app/agent/extensions/crm",
      appRoot: "/srv/app",
      schedules: [{ logicalPath: "schedules/sync.ts" }],
      subagents: [
        {
          logicalPath: "subagents/reviewer",
          subagentId: "reviewer",
          manifest: { ...nestedManifest, subagents: [] },
        },
      ],
    };

    const projection = projectDiscoveryManifest({
      ...nestedManifest,
      extensions: [{ logicalPath: "extensions/crm/extension.ts" }],
      resolvedExtensions: [
        {
          namespace: "crm",
          specifier: "@acme/crm",
          packageName: "@acme/crm",
          packageRoot: "/srv/app/node_modules/@acme/crm",
          sourceRoot: extensionManifest.agentRoot,
          manifest: extensionManifest,
          overrides: overrideManifest,
        },
      ],
    });

    expect(projection).toMatchObject({
      schedules: [
        "agent/extensions/crm/schedules/sync.ts",
        "agent/extensions/crm/schedules/report.md",
      ],
      subagents: [
        "agent/subagents/directory-child",
        "agent/subagents/file-child.ts",
        "agent/subagents/remote-child.ts",
        "agent/extensions/crm/subagents/reviewer",
      ],
      subagentIds: ["directory-child", "file-child", "remote-child", "crm__reviewer"],
    });
  });

  test("returns null for anything that is not a discovery manifest", () => {
    expect(projectDiscoveryManifest(null)).toBeNull();
    expect(projectDiscoveryManifest({ kind: "something-else", version: 12 })).toBeNull();
    expect(projectDiscoveryManifest({ kind: "eve-agent-discovery-manifest" })).toBeNull();
    expect(projectDiscoveryManifest([])).toBeNull();
  });

  test("fails closed on an unknown schema version instead of becoming authoritative emptiness", () => {
    expect(projectDiscoveryManifest({ ...nestedManifest, version: 99 })).toBeNull();
  });

  test("fails closed on invalid Extension namespaces and unsupported schedule modules", () => {
    const extensionManifest = {
      ...nestedManifest,
      agentRoot: "/srv/app/node_modules/@acme/crm/dist/extension",
      subagents: [],
      schedules: [{ logicalPath: "schedules/report.mdx" }],
    };
    const withMount = (namespace: string, manifest = extensionManifest) => ({
      ...nestedManifest,
      version: 13,
      extensions: [{ logicalPath: "extensions/crm.ts" }],
      resolvedExtensions: [{ namespace, manifest }],
    });

    expect(projectDiscoveryManifest(withMount(""))).toBeNull();
    expect(projectDiscoveryManifest(withMount("crm"))).toBeNull();
  });

  test("fails closed when entity arrays or roots are missing", () => {
    // A bare kind+version envelope must not wipe the static summary's entity lists.
    expect(
      projectDiscoveryManifest({
        kind: "eve-agent-discovery-manifest",
        version: 12,
        agentRoot: "/srv/app/agent",
        appRoot: "/srv/app",
      }),
    ).toBeNull();
    const { tools: _tools, ...withoutTools } = nestedManifest;
    expect(projectDiscoveryManifest(withoutTools)).toBeNull();
    const { agentRoot: _agentRoot, ...withoutAgentRoot } = nestedManifest;
    expect(projectDiscoveryManifest(withoutAgentRoot)).toBeNull();
    expect(projectDiscoveryManifest({ ...nestedManifest, sandbox: "sandbox.ts" })).toBeNull();
  });

  test("fails closed on corrupt array elements instead of silently dropping them", () => {
    // A well-formed envelope with one malformed element must not project the
    // rest as an authoritative list.
    expect(
      projectDiscoveryManifest({ ...nestedManifest, tools: [{ path: "tool.ts" }] }),
    ).toBeNull();
    expect(
      projectDiscoveryManifest({
        ...nestedManifest,
        instructions: [{ logicalPath: "instructions.md" }, { logicalPath: 42 }],
      }),
    ).toBeNull();
    expect(
      projectDiscoveryManifest({ ...nestedManifest, hooks: ["hooks/observer.ts"] }),
    ).toBeNull();
  });
});
