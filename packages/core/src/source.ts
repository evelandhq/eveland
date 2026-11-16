import { isSupportedEveSpecifier, unsupportedEveSpecifierMessage } from "./eve-compatibility.js";

// Browser-safe module: pure string handling instead of node:path.
function posixBasename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

export type SourceFile = {
  path: string;
  content?: string;
};

/**
 * eve's project layouts, as far as the preflight can tell them apart. Eveland
 * deploys only `nested`: one agent whose files live in `agent/` at the
 * repository root. eve also accepts agent files directly in the app root
 * (`flat`) and workspace members under `agents/<name>/` (`workspace`); a
 * build injects platform files into `agent/`, which turns a flat project
 * into an empty nested one, so both are refused before anything is built.
 */
export type EveProjectLayout = "nested" | "flat" | "workspace" | "unknown";

const AGENT_ROOT = "agent/";

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
  eveVersion: string | null;
  summary: EveProjectSummary;
  envVars: string[];
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
  const root = AGENT_ROOT;
  const summary = emptySummary();
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

    if (isUnder(file.path, `${root}schedules/`) && /\.(md|[cm]?[jt]s)$/.test(file.path)) {
      summary.schedules.push(file.path);
    }

    const subagent = getSubagentId(file.path, root);
    if (subagent) {
      summary.subagents.push(subagent);
    }
  }

  dedupeSummary(summary);

  const layoutError = unsupportedLayoutMessage(layout);
  if (layoutError) errors.push(layoutError);
  const eveVersion = readDeclaredEveVersion(normalized);
  if (!isSupportedEveSpecifier(eveVersion)) {
    errors.push(unsupportedEveSpecifierMessage(eveVersion));
  }

  return {
    valid: errors.length === 0,
    layout,
    projectName: readProjectName(normalized),
    eveVersion,
    summary,
    envVars: [...envVars].sort(),
    errors,
  };
}

const SUPPORTED_LAYOUT_HINT =
  "Eveland deploys one agent per repository, with its files in agent/ at the repository root " +
  "(agent/instructions.md, agent/agent.ts, agent/tools/, ...).";

/** The preflight error for a layout Eveland does not deploy, or null for `nested`. */
export function unsupportedLayoutMessage(layout: EveProjectLayout): string | null {
  switch (layout) {
    case "nested":
      return null;
    case "flat":
      return (
        "The agent's files are at the repository root (eve's flat layout), which Eveland does " +
        "not deploy. Move instructions, agent.ts, and the agent's directories into agent/. " +
        SUPPORTED_LAYOUT_HINT
      );
    case "workspace":
      return (
        "The repository is an eve workspace with agents under agents/<name>/, which Eveland does " +
        `not deploy. Import a repository that holds a single agent. ${SUPPORTED_LAYOUT_HINT}`
      );
    case "unknown":
      return `Missing agent/instructions.md, agent/instructions.ts, or agent/instructions/. ${SUPPORTED_LAYOUT_HINT}`;
  }
}

function detectLayout(paths: Set<string>): EveProjectLayout {
  const all = [...paths];
  if (all.some((filePath) => isInstructionPath(filePath, AGENT_ROOT))) return "nested";
  if (all.some((filePath) => isInstructionPath(filePath, ""))) return "flat";
  if (all.some((filePath) => /^agents\/[^/]+\/instructions(?:\.|\/)/.test(filePath))) {
    return "workspace";
  }
  return "unknown";
}

// eve's authored instruction forms: one markdown or module file, or a directory.
const INSTRUCTION_FILE = /^instructions\.(?:md|[cm]?[jt]s)$/;

function isInstructionPath(filePath: string, root: string): boolean {
  if (!filePath.startsWith(root)) return false;
  const relative = filePath.slice(root.length);
  return INSTRUCTION_FILE.test(relative) || relative.startsWith("instructions/");
}

function isUnder(filePath: string, directory: string): boolean {
  return filePath.startsWith(directory);
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
