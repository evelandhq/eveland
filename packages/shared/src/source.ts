import path from "node:path";
import { parseMarkdownSchedule, type DiscoveredSchedule } from "./schedules.js";

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

export type EveProjectInspection = {
  valid: boolean;
  layout: EveProjectLayout;
  projectName: string | null;
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

    if (isUnder(file.path, `${root}skills/`) && /\.(md|mdx|ts|tsx)$/.test(file.path)) {
      summary.skills.push(file.path);
    }

    if (isUnder(file.path, `${root}connections/`) && /\.(ts|tsx)$/.test(file.path)) {
      summary.connections.push(file.path);
    }

    if (isUnder(file.path, `${root}sandbox/`) || file.path === `${root}sandbox.ts`) {
      summary.sandbox.push(file.path);
    }

    if (isUnder(file.path, `${root}schedules/`) && /\.(md|mdx|ts|tsx)$/.test(file.path)) {
      summary.schedules.push(file.path);
      try {
        schedules.push(parseMarkdownSchedule(file.path, file.content));
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

  return {
    valid: errors.length === 0,
    layout,
    projectName: readProjectName(normalized),
    summary,
    envVars: [...envVars].sort(),
    schedules,
    errors,
  };
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

function getSubagentId(filePath: string, root: string): string | null {
  const prefix = `${root}subagents/`;
  if (!filePath.startsWith(prefix)) {
    return null;
  }
  const [id] = filePath.slice(prefix.length).split("/");
  return id ? `${prefix}${id}` : null;
}

function collectEnvVars(filePath: string, content: string, envVars: Set<string>): void {
  if (path.posix.basename(filePath).startsWith(".env")) {
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

function dedupeSummary(summary: EveProjectSummary): void {
  for (const key of Object.keys(summary) as Array<keyof EveProjectSummary>) {
    summary[key] = [...new Set(summary[key])].sort();
  }
}

function normalizeSourcePath(input: string): string {
  return input.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
}
