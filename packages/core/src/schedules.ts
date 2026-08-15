import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";

// Browser-safe module: pure string handling instead of node:path.
function posixExtname(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}

const moduleExtensions = [".cts", ".mts", ".cjs", ".mjs", ".ts", ".js"] as const;

export type MarkdownSchedule = {
  key: string;
  kind: "markdown";
  cron: string;
  sourcePath: string;
  prompt: string;
  executable: true;
};

export type ModuleSchedule = {
  key: string;
  kind: "module";
  sourcePath: string;
  executable: true;
};

export type DiscoveredSchedule = MarkdownSchedule | ModuleSchedule;

export function parseScheduleSource(sourcePath: string, content: string): DiscoveredSchedule {
  const normalizedPath = sourcePath.replaceAll("\\", "/");
  const key = scheduleKeyFromPath(normalizedPath);
  const extension = posixExtname(normalizedPath);

  if (moduleExtensions.includes(extension as (typeof moduleExtensions)[number])) {
    return { key, kind: "module", sourcePath: normalizedPath, executable: true };
  }
  if (extension !== ".md") {
    throw new Error(
      `Schedule ${sourcePath} uses an unsupported schedule extension for Eveland's supported Eve releases.`,
    );
  }

  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
  if (!frontmatter) {
    throw new Error(`Markdown schedule ${sourcePath} is missing frontmatter.`);
  }

  const data = parseStrictFrontmatter(sourcePath, frontmatter[1] ?? "");
  const cron = data.cron;
  if (!cron) {
    throw new Error(`Markdown schedule ${sourcePath} is missing cron.`);
  }
  validateFiveFieldCron(cron);

  return {
    key,
    kind: "markdown",
    cron,
    sourcePath: normalizedPath,
    prompt: (frontmatter[2] ?? "").trim(),
    executable: true,
  };
}

export const parseMarkdownSchedule = parseScheduleSource;

export function getNextRunAt(cron: string, currentDate = new Date()): Date {
  validateFiveFieldCron(cron);
  return CronExpressionParser.parse(cron, { currentDate, tz: "UTC" }).next().toDate();
}

export function describeScheduleCron(cron: string): string {
  validateFiveFieldCron(cron);
  const description = cronstrue
    .toString(cron, {
      use24HourTimeFormat: true,
      verbose: true,
    })
    .replace(/, every hour, every day$/, "");
  return `${description} (UTC)`;
}

export function validateFiveFieldCron(cron: string): void {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new Error(
      `Eve schedules require a standard cron expression with exactly five fields: ${cron}`,
    );
  }
  try {
    CronExpressionParser.parse(cron, { currentDate: new Date(0), tz: "UTC" });
  } catch (error) {
    throw new Error(
      `Invalid Eve schedule cron expression "${cron}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateScheduleDefinitionFields(input: {
  key: string;
  cron: string;
  sourcePath: string;
  definitionHash: string;
}): void {
  const keySegments = input.key.split("/");
  if (
    !input.key ||
    input.key.trim() !== input.key ||
    input.key.includes("\\") ||
    keySegments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Schedule definition key must be a normalized non-empty key.");
  }
  validateFiveFieldCron(input.cron);
  validateReleaseRelativePath(input.sourcePath, "source path");
  if (
    !input.sourcePath.startsWith("agent/schedules/") &&
    !input.sourcePath.startsWith("agent/extensions/")
  ) {
    throw new Error("Schedule definition source path must identify a platform schedule slot.");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.definitionHash)) {
    throw new Error("Schedule definition hash must be a SHA-256 digest.");
  }
}

export function validateReleaseRelativePath(value: string, label: string): void {
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Schedule definition ${label} must be a normalized Release-relative path.`);
  }
}

function scheduleKeyFromPath(sourcePath: string): string {
  const prefix = "agent/schedules/";
  if (!sourcePath.startsWith(prefix)) {
    throw new Error(`Schedule ${sourcePath} must be located under agent/schedules/.`);
  }
  const relativePath = sourcePath.slice(prefix.length);
  if (
    !relativePath ||
    relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Schedule ${sourcePath} has an invalid path under agent/schedules/.`);
  }
  const extension = posixExtname(relativePath);
  return relativePath.slice(0, -extension.length);
}

function parseStrictFrontmatter(sourcePath: string, input: string): { cron?: string } {
  const result: { cron?: string } = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) throw new Error(`Markdown schedule ${sourcePath} has invalid frontmatter.`);
    const [, key, rawValue = ""] = match;
    if (key !== "cron") {
      throw new Error(`Markdown schedule ${sourcePath} only supports the cron frontmatter field.`);
    }
    if (result.cron !== undefined) {
      throw new Error(`Markdown schedule ${sourcePath} declares cron more than once.`);
    }
    result.cron = unquote(rawValue.trim());
  }
  return result;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'"))
      return value.slice(1, -1);
  }
  return value;
}
