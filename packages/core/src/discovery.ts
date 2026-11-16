/**
 * Projection of `eve info --json`, the documented JSON form of what eve
 * discovered in a built agent, onto the Release's build summary.
 *
 * Once a Release has been built, this output -- not Eveland's pre-install
 * static file scan -- is the authority on what the agent contains: the worker
 * runs it after `eve build` on the same installed tree. The summary is
 * informational. eve documents names here, not source paths, and the output
 * has no hooks, connections, or sandbox entries, so the summary has none
 * either.
 *
 * Fail closed to null: output whose documented fields are missing or of the
 * wrong type must not become "authoritative emptiness". The caller records
 * the Release without a build summary instead.
 */
export type EveInfoSummary = {
  summarySource: "eve-info";
  /** eve's compile status, such as `ready` or `failed`; `unavailable` when nothing compiled. */
  status: string;
  layout: string | null;
  diagnostics: { errors: number; warnings: number } | null;
  /** Root agent model id. */
  model: string | null;
  /** Static instruction files with their roles, as eve prints them. */
  instructions: string | null;
  skills: string[];
  tools: string[];
  subagents: string[];
  schedules: string[];
  /** Distinct channel names, in eve's route order. */
  channels: string[];
};

export function projectEveInfo(info: unknown): EveInfoSummary | null {
  if (!isRecord(info) || typeof info.status !== "string") return null;
  const layout = nullableString(info.layout);
  const model = nullableString(info.model);
  const instructions = nullableString(info.instructions);
  const diagnostics = readDiagnostics(info.diagnostics);
  const skills = stringList(info.skills);
  const tools = stringList(info.tools);
  const subagents = stringList(info.subagents);
  const schedules = stringList(info.schedules);
  const channels = channelNames(info.channels);
  if (
    layout === undefined ||
    model === undefined ||
    instructions === undefined ||
    diagnostics === undefined ||
    !skills ||
    !tools ||
    !subagents ||
    !schedules ||
    !channels
  ) {
    return null;
  }
  return {
    summarySource: "eve-info",
    status: info.status,
    layout,
    diagnostics,
    model,
    instructions,
    skills,
    tools,
    subagents,
    schedules,
    channels,
  };
}

/** The value, null, or undefined when it is neither a string nor null. */
function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

function channelNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const route of value) {
    if (!isRecord(route) || typeof route.name !== "string") return undefined;
    if (!names.includes(route.name)) names.push(route.name);
  }
  return names;
}

function readDiagnostics(value: unknown): EveInfoSummary["diagnostics"] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.errors !== "number" || typeof value.warnings !== "number") {
    return undefined;
  }
  return { errors: value.errors, warnings: value.warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
