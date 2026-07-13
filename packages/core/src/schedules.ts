import path from "node:path";
import { CronExpressionParser } from "cron-parser";

export type MarkdownSchedule = {
  name: string;
  kind: "markdown";
  cron: string;
  timezone: string;
  enabled: boolean;
  sourcePath: string;
  prompt: string;
  executable: true;
};

export type TypeScriptSchedule = {
  name: string;
  kind: "typescript";
  sourcePath: string;
  executable: false;
};

export type DiscoveredSchedule = MarkdownSchedule | TypeScriptSchedule;

export function parseMarkdownSchedule(sourcePath: string, content: string): DiscoveredSchedule {
  const name = path.posix.basename(sourcePath).replace(/\.(md|mdx|ts|tsx)$/i, "");

  if (/\.(ts|tsx)$/i.test(sourcePath)) {
    return {
      name,
      kind: "typescript",
      sourcePath,
      executable: false,
    };
  }

  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!frontmatter) {
    throw new Error(`Markdown schedule ${sourcePath} is missing frontmatter.`);
  }

  const data = parseSimpleYaml(frontmatter[1] ?? "");
  const cron = data.cron;
  if (!cron) {
    throw new Error(`Markdown schedule ${sourcePath} is missing cron.`);
  }

  return {
    name,
    kind: "markdown",
    cron,
    timezone: data.timezone ?? "UTC",
    enabled: data.enabled == null ? true : data.enabled === "true",
    sourcePath,
    prompt: (frontmatter[2] ?? "").trim(),
    executable: true,
  };
}

export function getNextRunAt(cron: string, timezone: string, currentDate = new Date()): Date {
  return CronExpressionParser.parse(cron, {
    currentDate,
    tz: timezone,
  })
    .next()
    .toDate();
}

function parseSimpleYaml(input: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue = ""] = match;
    if (!key) {
      continue;
    }
    result[key] = rawValue.replace(/^["']|["']$/g, "").trim();
  }

  return result;
}
