import type { EveProjectLayout, EveProjectSummary } from "./source.js";

/**
 * Projection of eve's own build artifact `.eve/discovery/agent-discovery-manifest.json`
 * onto the platform summary shape. Once a Release has been built, this manifest -- not
 * Eveland's pre-install static file scan -- is the authority on what the agent contains:
 * it is produced by the same discovery pass `eve build` compiles from, so it cannot
 * drift from eve's layout rules the way re-derived heuristics can.
 *
 * The projection is deliberately tolerant: the manifest is informational (the static
 * scan already gated the import), so an unrecognized manifest yields null and the
 * caller keeps the static summary rather than failing the build.
 */
export type DiscoverySummaryProjection = {
  summarySource: "build-manifest";
  manifestVersion: number;
  agentId: string | null;
  layout: EveProjectLayout;
  diagnostics: { errors: number; warnings: number } | null;
  hooks: string[];
  channels: string[];
  subagentIds: string[];
  // `agents` (the root agent config module) and `capabilities.eveChat` stay
  // owned by the static scan: the manifest neither lists the root config
  // module nor exposes what an authored channel module exports.
} & Omit<EveProjectSummary, "agents">;

const MANIFEST_KIND = "eve-agent-discovery-manifest";

export function projectDiscoveryManifest(manifest: unknown): DiscoverySummaryProjection | null {
  if (!isRecord(manifest) || manifest.kind !== MANIFEST_KIND) return null;
  const version = manifest.version;
  if (typeof version !== "number") return null;

  const agentRoot = typeof manifest.agentRoot === "string" ? manifest.agentRoot : null;
  const appRoot = typeof manifest.appRoot === "string" ? manifest.appRoot : null;
  const layout: EveProjectLayout =
    agentRoot && appRoot ? (agentRoot === appRoot ? "flat" : "nested") : "unknown";
  // Summary paths stay app-root-relative like the static scan's, so UI consumers
  // need no awareness of which producer wrote the summary.
  const root = layout === "nested" ? "agent/" : "";
  const prefix = (paths: string[]) => paths.map((entry) => `${root}${entry}`);

  const channels = logicalPaths(manifest.channels);
  const subagents = readEntries(manifest.subagents);

  return {
    summarySource: "build-manifest",
    manifestVersion: version,
    agentId: typeof manifest.agentId === "string" ? manifest.agentId : null,
    layout,
    diagnostics: readDiagnostics(manifest.diagnosticsSummary),
    instructions: prefix(logicalPaths(manifest.instructions)),
    tools: prefix(logicalPaths(manifest.tools)),
    skills: prefix(logicalPaths(manifest.skills)),
    subagents: prefix(subagents.map((entry) => entry.logicalPath)),
    connections: prefix(logicalPaths(manifest.connections)),
    schedules: prefix(logicalPaths(manifest.schedules)),
    sandbox: prefix(logicalPaths(manifest.sandbox === null ? [] : [manifest.sandbox])),
    hooks: prefix(logicalPaths(manifest.hooks)),
    channels: prefix(channels),
    subagentIds: subagents
      .map((entry) => entry.subagentId)
      .filter((value): value is string => typeof value === "string"),
  };
}

function readEntries(value: unknown): Array<{ logicalPath: string; subagentId?: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is { logicalPath: string; subagentId?: unknown } =>
      isRecord(entry) && typeof entry.logicalPath === "string",
  );
}

function logicalPaths(value: unknown): string[] {
  return readEntries(Array.isArray(value) ? value : [value]).map((entry) => entry.logicalPath);
}

function readDiagnostics(value: unknown): { errors: number; warnings: number } | null {
  if (!isRecord(value) || typeof value.errors !== "number" || typeof value.warnings !== "number") return null;
  return { errors: value.errors, warnings: value.warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
