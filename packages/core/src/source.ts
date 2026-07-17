import path from "node:path";
import { parseScheduleSource, type DiscoveredSchedule } from "./schedules.js";

export type SourceFile = {
  path: string;
  content?: string;
};

export type EveProjectLayout = "nested" | "flat" | "unknown";
export type DetectedAgentAuthMethod = "jinshuju-oidc";

export type EveProjectSummary = {
  agents: string[];
  agentAuthMethods: DetectedAgentAuthMethod[];
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
  schedules: DiscoveredSchedule[];
  errors: string[];
};

export const SUPPORTED_EVE_VERSION_RANGE = "0.24.x";

export type EveVersionInfo = {
  version: string | null;
  expected: typeof SUPPORTED_EVE_VERSION_RANGE;
  supported: boolean;
  sourceRevisionId: string | null;
};

const emptySummary = (): EveProjectSummary => ({
  agents: [],
  agentAuthMethods: [],
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

    if (
      isUnder(file.path, `${root}channels/`)
      && /\.[cm]?[jt]sx?$/.test(file.path)
      && usesJinshujuOidcInEveChannel(file.content)
    ) {
      summary.agentAuthMethods.push("jinshuju-oidc");
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

    if (root === "agent/" && isUnder(file.path, `${root}schedules/`) && /\.(md|[cm]?[jt]s)$/.test(file.path)) {
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
    summary,
    envVars: [...envVars].sort(),
    schedules,
    errors,
  };
}

export function isSupportedEveDependency(specifier: string | null): boolean {
  if (specifier === null) return false;
  return /^[~^]?0\.24\.\d+$/.test(specifier.trim()) || /^0\.24(\.[x*])?$/.test(specifier.trim());
}

export function unsupportedEveVersionMessage(specifier: string | null): string {
  if (specifier === null) {
    return `Missing Eve dependency. Eveland requires Eve ${SUPPORTED_EVE_VERSION_RANGE}. Add the \"eve\" dependency before importing or deploying.`;
  }
  return `Unsupported Eve dependency \"${specifier}\". Eveland requires Eve ${SUPPORTED_EVE_VERSION_RANGE}. Upgrade the project's \"eve\" dependency before importing or deploying.`;
}

export function createEveVersionInfo(version: string | null, sourceRevisionId: string | null): EveVersionInfo {
  return {
    version,
    expected: SUPPORTED_EVE_VERSION_RANGE,
    supported: isSupportedEveDependency(version),
    sourceRevisionId,
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

export function readDeclaredEveVersion(files: Array<{ path: string; content: string }>): string | null {
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
  for (const values of Object.values(summary)) {
    const deduped = [...new Set(values)].sort();
    values.splice(0, values.length, ...deduped);
  }
}

function usesJinshujuOidcInEveChannel(content: string): boolean {
  const source = content
    .replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, (value) =>
      /^["'`]auth["'`]$/.test(value) ? ` auth ` : " ".repeat(value.length))
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (value) => " ".repeat(value.length));
  const verifierNames = collectIdentifierAliases(source, "jinshujuOidc");
  const channelNames = new Set([
    ...collectIdentifierAliases(source, "eveChannel"),
    ...collectIdentifierAliases(source, "EveChannel"),
  ]);

  for (const channelName of channelNames) {
    const calls = new RegExp(`\\b${escapeRegExp(channelName)}\\s*\\(`, "g");
    for (const match of source.matchAll(calls)) {
      const openParen = source.indexOf("(", match.index);
      const call = readBalanced(source, openParen, "(", ")");
      if (!call) continue;
      const objectStart = call.value.indexOf("{", 1);
      if (objectStart < 0 || call.value.slice(1, objectStart).trim() !== "") continue;
      const object = readBalanced(call.value, objectStart, "{", "}");
      if (object && channelObjectUsesVerifier(object.value, source, verifierNames)) return true;
    }
  }
  return false;
}

function channelObjectUsesVerifier(
  objectSource: string,
  fullSource: string,
  verifierNames: Set<string>,
): boolean {
  for (const property of splitTopLevel(objectSource.slice(1, -1), ",")) {
    const colon = findTopLevelDelimiter(property, ":");
    if (colon >= 0 && property.slice(0, colon).trim() === "auth") {
      return expressionUsesVerifier(property.slice(colon + 1), fullSource, verifierNames, new Set());
    }
    if (property.trim() === "auth") {
      return bindingUsesVerifier("auth", fullSource, verifierNames, new Set());
    }
  }
  return false;
}

function expressionUsesVerifier(
  expression: string,
  fullSource: string,
  verifierNames: Set<string>,
  visitedBindings: Set<string>,
): boolean {
  for (const name of verifierNames) {
    if (new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(expression)) return true;
  }
  if (/\b[A-Za-z_$][\w$]*\.jinshujuOidc\s*\(/.test(expression)) return true;
  const reference = /^\s*([A-Za-z_$][\w$]*)\b/.exec(expression)?.[1];
  return reference ? bindingUsesVerifier(reference, fullSource, verifierNames, visitedBindings) : false;
}

function bindingUsesVerifier(
  name: string,
  source: string,
  verifierNames: Set<string>,
  visited: Set<string>,
): boolean {
  if (visited.has(name)) return false;
  visited.add(name);
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=`, "g").exec(source);
  if (!declaration) return false;
  const expressionStart = declaration.index + declaration[0].length;
  const expression = readExpression(source, expressionStart);
  return expressionUsesVerifier(expression, source, verifierNames, visited);
}

function collectIdentifierAliases(source: string, exportedName: string): Set<string> {
  const names = new Set([exportedName]);
  const aliases = new RegExp(`\\b${escapeRegExp(exportedName)}\\s+as\\s+([A-Za-z_$][\\w$]*)`, "g");
  for (const match of source.matchAll(aliases)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

function readBalanced(source: string, start: number, open: string, close: string): { value: string; end: number } | null {
  if (source[start] !== open) return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    if (source[index] === close) depth -= 1;
    if (depth === 0) return { value: source.slice(start, index + 1), end: index + 1 };
  }
  return null;
}

function readExpression(source: string, start: number): string {
  let hasContent = false;
  for (const { character, depth, index } of walkBracketDepth(source, start)) {
    if (depth === 0 && hasContent && (character === ";" || character === "\n")) {
      return source.slice(start, index);
    }
    if (!/\s/.test(character)) hasContent = true;
  }
  return source.slice(start);
}

function splitTopLevel(source: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const { character, depth, index } of walkBracketDepth(source)) {
    if (depth === 0 && character === delimiter) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function findTopLevelDelimiter(source: string, delimiter: string): number {
  for (const { character, depth, index } of walkBracketDepth(source)) {
    if (depth === 0 && character === delimiter) return index;
  }
  return -1;
}

function* walkBracketDepth(source: string, start = 0): Generator<{ character: string; depth: number; index: number }> {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    yield { character, depth, index };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSourcePath(input: string): string {
  return input.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
}
