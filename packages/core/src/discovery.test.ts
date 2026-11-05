import { describe, expect, test } from "vitest";
import { projectDiscoveryManifest } from "./discovery.js";

// Field-faithful copy of a manifest eve 0.24+ generates (fixture .eve/ artifacts
// are gitignored, so the shape is inlined here). The drift guard against what
// eve actually writes is the agent-observer compatibility matrix, which runs
// this projection on manifests generated live by each pinned eve binary.
const nestedManifest = {
  kind: "eve-agent-discovery-manifest",
  version: 15,
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

/**
 * The same agent as `nestedManifest`, as eve 1.0.0-rc.3 and later write it
 * (v16): every authored source in one `sources` list, in slot order, whose
 * kind is the first segment of its logical path.
 */
function toV16<T extends Record<string, unknown>>(manifest: T) {
  const { channels, connections, hooks, instructions, sandbox, schedules, skills, tools, ...rest } =
    manifest as Record<string, unknown>;
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  return {
    ...rest,
    version: 16,
    sources: [
      ...list(channels),
      ...list(connections),
      ...list(hooks),
      ...(sandbox ? [sandbox] : []),
      ...list(tools),
      ...list(instructions),
      ...list(schedules),
      ...list(skills),
    ],
  };
}

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

  test("projects role-bearing instruction modules (schema shape unchanged since 0.35)", () => {
    const projection = projectDiscoveryManifest({
      ...nestedManifest,
      version: 15,
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
      manifestVersion: 15,
      instructions: ["agent/instructions/context.ts"],
    });
  });

  test("rejects the v14 manifest now that the 0.45 line has left the window", () => {
    // v14 (eve 0.45.0 only) differed from v15 by lacking `memories`; every
    // supported line now emits v15, so v14 fails closed like v13 before it.
    expect(
      projectDiscoveryManifest({
        ...nestedManifest,
        version: 14,
        instrumentation: {
          sourceKind: "module",
          logicalPath: "instrumentation.ts",
          sourceId: "instrumentation.ts",
        },
      }),
    ).toBeNull();
  });

  test("projects the v15 manifest (0.45.1+, every supported line), ignoring the added memories list", () => {
    // v15 adds `memories` (memory-provider modules, ModuleSourceRef + slot)
    // for the new eve/memory feature; every entity list the projection
    // consumes is unchanged from v14.
    const projection = projectDiscoveryManifest({
      ...nestedManifest,
      version: 15,
      memories: [
        {
          sourceKind: "module",
          logicalPath: "memory/recall.ts",
          sourceId: "memory/recall.ts",
          slot: "recall",
        },
      ],
    });

    expect(projection).toMatchObject({
      manifestVersion: 15,
      instructions: ["agent/instructions.md"],
      hooks: ["agent/hooks/root-observer.ts"],
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
    expect(projectDiscoveryManifest({ kind: "something-else", version: 13 })).toBeNull();
    expect(projectDiscoveryManifest({ kind: "eve-agent-discovery-manifest" })).toBeNull();
    expect(projectDiscoveryManifest([])).toBeNull();
  });

  test("fails closed on an unknown schema version instead of becoming authoritative emptiness", () => {
    expect(projectDiscoveryManifest({ ...nestedManifest, version: 99 })).toBeNull();
    // v12 (eve <= 0.34) left the whitelist when the window floor moved to 0.38,
    // v13 (eve 0.44) when it moved to 0.45, and v14 (eve 0.45.0) when it
    // moved to 0.47.
    expect(projectDiscoveryManifest({ ...nestedManifest, version: 12 })).toBeNull();
    expect(projectDiscoveryManifest({ ...nestedManifest, version: 13 })).toBeNull();
    expect(projectDiscoveryManifest({ ...nestedManifest, version: 14 })).toBeNull();
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
      version: 15,
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
        version: 15,
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
  test("projects a v16 manifest (eve 1.0.0-rc.3+) from its single sources list", () => {
    const v16 = toV16({
      ...nestedManifest,
      connections: [{ sourceKind: "module", logicalPath: "connections/warehouse.ts" }],
      sandbox: { sourceKind: "module", logicalPath: "sandbox.ts" },
      tools: [{ sourceKind: "module", logicalPath: "tools/lookup.ts" }],
      schedules: [{ sourceKind: "markdown", logicalPath: "schedules/daily.md" }],
      skills: [{ sourceKind: "skill-package", logicalPath: "skills/research/SKILL.md" }],
      channels: [{ sourceKind: "module", logicalPath: "channels/slack.ts" }],
    });
    const memory = { sourceKind: "module", logicalPath: "memory/notes.ts", slot: "notes" };

    expect(projectDiscoveryManifest({ ...v16, sources: [...v16.sources, memory] })).toMatchObject({
      manifestVersion: 16,
      instructions: ["agent/instructions.md"],
      hooks: ["agent/hooks/root-observer.ts"],
      connections: ["agent/connections/warehouse.ts"],
      sandbox: ["agent/sandbox.ts"],
      tools: ["agent/tools/lookup.ts"],
      schedules: ["agent/schedules/daily.md"],
      skills: ["agent/skills/research/SKILL.md"],
      channels: ["agent/channels/slack.ts"],
      subagentIds: ["directory-child", "file-child", "remote-child"],
    });
  });

  test("projects v16 Extension schedules from each mount's sources", () => {
    const extensionManifest = toV16({
      ...nestedManifest,
      agentRoot: "/srv/app/node_modules/@acme/crm/dist/extension",
      appRoot: "/srv/app/node_modules/@acme/crm",
      hooks: [],
      instructions: [],
      schedules: [{ logicalPath: "schedules/sync.mjs" }, { logicalPath: "schedules/report.md" }],
      tools: [{ logicalPath: "tools/lookup.ts" }],
      subagents: [],
    });
    const overrideManifest = toV16({
      ...nestedManifest,
      agentRoot: "/srv/app/agent/extensions/crm",
      hooks: [],
      instructions: [],
      schedules: [{ logicalPath: "schedules/sync.ts" }],
      subagents: [],
    });

    expect(
      projectDiscoveryManifest({
        ...toV16(nestedManifest),
        extensions: [{ logicalPath: "extensions/crm/extension.ts" }],
        resolvedExtensions: [
          { namespace: "crm", manifest: extensionManifest, overrides: overrideManifest },
        ],
      }),
    ).toMatchObject({
      schedules: [
        "agent/extensions/crm/schedules/sync.ts",
        "agent/extensions/crm/schedules/report.md",
      ],
    });
  });

  test("fails closed on a v16 manifest without its sources list or with an unplaceable source", () => {
    const v16 = toV16(nestedManifest);
    const { sources: _sources, ...withoutSources } = v16;
    expect(projectDiscoveryManifest(withoutSources)).toBeNull();
    // The per-kind lists are v15's shape; a v16 manifest carrying only them is unrecognized.
    expect(projectDiscoveryManifest({ ...nestedManifest, version: 16 })).toBeNull();
    expect(
      projectDiscoveryManifest({
        ...v16,
        sources: [...v16.sources, { logicalPath: "lib/util.ts" }],
      }),
    ).toBeNull();
    expect(projectDiscoveryManifest({ ...v16, sources: [{ path: "tools/lookup.ts" }] })).toBeNull();
    expect(
      projectDiscoveryManifest({
        ...v16,
        sources: [{ logicalPath: "sandbox.ts" }, { logicalPath: "sandbox/sandbox.ts" }],
      }),
    ).toBeNull();
  });
});
