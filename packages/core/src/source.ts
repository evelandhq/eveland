import { isSupportedEveDependency, unsupportedEveVersionMessage } from "./eve-compatibility.js";
import { parseScheduleSource, type DiscoveredSchedule } from "./schedules.js";

// Browser-safe module: pure string handling instead of node:path.
function posixBasename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

export {
  createEveVersionInfo,
  isSupportedEveDependency,
  isUnsupportedEveVersionMessage,
  SUPPORTED_EVE_VERSION_RANGE,
  SUPPORTED_EVE_VERSION_RANGES,
  unsupportedEveVersionMessage,
  type EveVersionInfo,
  type SupportedEveVersionRange,
} from "./eve-compatibility.js";

export type SourceFile = {
  path: string;
  content?: string;
};

export type EveProjectLayout = "nested" | "flat" | "unknown";

export type EveProjectSummary = {
  agents: string[];
  instructions: string[];
  tools: string[];
  skills: string[];
  subagents: string[];
  connections: string[];
  schedules: string[];
  sandbox: string[];
};

export type EveProjectCapabilities = {
  eveChat: boolean;
};

export type EveProjectInspection = {
  valid: boolean;
  layout: EveProjectLayout;
  projectName: string | null;
  eveVersion: string | null;
  capabilities: EveProjectCapabilities;
  summary: EveProjectSummary;
  envVars: string[];
  schedules: DiscoveredSchedule[];
  errors: string[];
};

const emptySummary = (): EveProjectSummary => ({
  agents: [],
  instructions: [],
  tools: [],
  skills: [],
  subagents: [],
  connections: [],
  schedules: [],
  sandbox: [],
});

export function inspectEveProject(files: SourceFile[]): EveProjectInspection {
  const normalized = files.map((file) => ({
    path: normalizeSourcePath(file.path),
    content: file.content ?? "",
  }));
  const paths = new Set(normalized.map((file) => file.path));
  const layout = detectLayout(paths);
  const root = layout === "nested" ? "agent/" : "";
  const summary = emptySummary();
  const schedules: DiscoveredSchedule[] = [];
  const envVars = new Set<string>();
  const errors: string[] = [];

  for (const file of normalized) {
    collectEnvVars(file.path, file.content, envVars);

    if (file.path === `${root}agent.ts`) {
      summary.agents.push(file.path);
    }

    if (isInstructionPath(file.path, root)) {
      summary.instructions.push(file.path);
    }

    if (isUnder(file.path, `${root}tools/`) && /\.(ts|tsx)$/.test(file.path)) {
      summary.tools.push(file.path);
    }

    if (isSkillPath(file.path, root)) {
      summary.skills.push(file.path);
    }

    if (isUnder(file.path, `${root}connections/`) && /\.(ts|tsx)$/.test(file.path)) {
      summary.connections.push(file.path);
    }

    if (isUnder(file.path, `${root}sandbox/`) || file.path === `${root}sandbox.ts`) {
      summary.sandbox.push(file.path);
    }

    if (
      root === "agent/" &&
      isUnder(file.path, `${root}schedules/`) &&
      /\.(md|[cm]?[jt]s)$/.test(file.path)
    ) {
      summary.schedules.push(file.path);
      try {
        schedules.push(parseScheduleSource(file.path, file.content));
      } catch {
        // Invalid schedule files are still shown in source summary; build validation reports detail later.
      }
    }

    const subagent = getSubagentId(file.path, root);
    if (subagent) {
      summary.subagents.push(subagent);
    }
  }

  dedupeSummary(summary);

  if (layout === "unknown" || summary.instructions.length === 0) {
    errors.push("Missing root instructions.md, instructions.ts, or instructions/.");
  }
  const eveVersion = readDeclaredEveVersion(normalized);
  if (!isSupportedEveDependency(eveVersion)) {
    errors.push(unsupportedEveVersionMessage(eveVersion));
  }

  return {
    valid: errors.length === 0,
    layout,
    projectName: readProjectName(normalized),
    eveVersion,
    capabilities: {
      eveChat: detectsEveChatCapability(normalized, root),
    },
    summary,
    envVars: [...envVars].sort(),
    schedules,
    errors,
  };
}

function detectsEveChatCapability(
  files: Array<{ path: string; content: string }>,
  root: string,
): boolean {
  const channel = files.find((file) =>
    new RegExp(`^${root}channels/eve\\.(?:[cm]?[jt]s)$`).test(file.path),
  );
  if (!channel) return false;
  return (
    /import\s*\{[^}]*\beveChannel\b[^}]*\}\s*from\s*["']eve\/channels\/eve["']/.test(
      channel.content,
    ) && /export\s+default\s+eveChannel\s*\(/.test(channel.content)
  );
}

function detectLayout(paths: Set<string>): EveProjectLayout {
  if ([...paths].some((filePath) => isInstructionPath(filePath, "agent/"))) {
    return "nested";
  }
  if ([...paths].some((filePath) => isInstructionPath(filePath, ""))) {
    return "flat";
  }
  return "unknown";
}

function isInstructionPath(filePath: string, root: string): boolean {
  return (
    filePath === `${root}instructions.md` ||
    filePath === `${root}instructions.ts` ||
    filePath.startsWith(`${root}instructions/`)
  );
}

function isUnder(filePath: string, directory: string): boolean {
  return directory ? filePath.startsWith(directory) : false;
}

function isSkillPath(filePath: string, root: string): boolean {
  const prefix = `${root}skills/`;
  if (!filePath.startsWith(prefix)) {
    return false;
  }

  const relativePath = filePath.slice(prefix.length);
  if (relativePath.includes("/")) {
    return /^[^/]+\/SKILL\.md$/.test(relativePath);
  }

  return !/\.d\.[cm]?ts$/.test(relativePath) && /\.(md|[cm]?[jt]s)$/.test(relativePath);
}

function getSubagentId(filePath: string, root: string): string | null {
  const prefix = `${root}subagents/`;
  if (!filePath.startsWith(prefix)) {
    return null;
  }
  const [id] = filePath.slice(prefix.length).split("/");
  return id ? `${prefix}${id}` : null;
}

function collectEnvVars(filePath: string, content: string, envVars: Set<string>): void {
  if (posixBasename(filePath).startsWith(".env")) {
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
      if (match?.[1]) {
        envVars.add(match[1]);
      }
    }
  }

  for (const match of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    if (match[1]) {
      envVars.add(match[1]);
    }
  }
}

function readProjectName(files: Array<{ path: string; content: string }>): string | null {
  const packageJson = files.find((file) => file.path === "package.json");
  if (!packageJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(packageJson.content) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null;
  }
}

export function readDeclaredEveVersion(
  files: Array<{ path: string; content: string }>,
): string | null {
  const packageJson = files.find((file) => file.path === "package.json");
  if (!packageJson) return null;

  try {
    const parsed = JSON.parse(packageJson.content) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const version = parsed.dependencies?.eve ?? parsed.devDependencies?.eve;
    return typeof version === "string" && version.trim().length > 0 ? version.trim() : null;
  } catch {
    return null;
  }
}

function dedupeSummary(summary: EveProjectSummary): void {
  for (const key of Object.keys(summary) as Array<keyof EveProjectSummary>) {
    summary[key] = [...new Set(summary[key])].sort();
  }
}

function normalizeSourcePath(input: string): string {
  return input.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
}
