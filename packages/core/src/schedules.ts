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
  /** Canonical IANA zone the cron is read in; "UTC" when the schedule names none. */
  timezone: string;
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

  return {
    key,
    kind: "markdown",
    sourcePath: normalizedPath,
    ...parseMarkdownScheduleContent(sourcePath, content),
    executable: true,
  };
}

/**
 * A Markdown schedule's frontmatter and prompt, without deriving a key from
 * its path: the same file can sit under `agent/schedules/` or inside an
 * Extension package.
 */
export function parseMarkdownScheduleContent(
  sourcePath: string,
  content: string,
): { cron: string; timezone: string; prompt: string } {
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
    cron,
    timezone:
      data.timezone === undefined
        ? DEFAULT_SCHEDULE_TIMEZONE
        : canonicalScheduleTimezone(data.timezone, sourcePath),
    prompt: (frontmatter[2] ?? "").trim(),
  };
}

/**
 * The zone a schedule without `timezone` runs in. eve itself uses the process
 * zone on a self-hosted server; the platform fixes it, so a schedule fires at
 * the same instant on every host.
 */
export const DEFAULT_SCHEDULE_TIMEZONE = "UTC";

/**
 * The canonical IANA name for a schedule's `timezone`, validated the way eve
 * validates it at build time (offsets such as "+08:00" are refused, "utc"
 * becomes "UTC"), so the platform stores the name eve compiled.
 */
export function canonicalScheduleTimezone(value: string, sourcePath?: string): string {
  const trimmed = value.trim();
  const where = sourcePath ? `Schedule ${sourcePath}: ` : "";
  if (trimmed.length === 0 || trimmed.length > 50 || /^[+-]/.test(trimmed)) {
    throw new Error(`${where}${JSON.stringify(value)} is not an IANA timezone.`);
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`${where}${JSON.stringify(value)} is not an IANA timezone.`);
  }
}

export const parseMarkdownSchedule = parseScheduleSource;

/**
 * The first instant strictly after `currentDate` at which `cron`, read in
 * `timezone`, fires.
 *
 * A zoned schedule follows eve's self-hosted rule across daylight saving
 * changes: a local time the clock skips runs at the next valid local time,
 * and a local time the clock repeats runs once, at its first occurrence. The
 * cron is evaluated on the zone's wall clock and each match is then placed on
 * the timeline, so both cases fall out of how a wall-clock time maps to an
 * instant rather than out of special cases in the cron arithmetic.
 */
export function getNextRunAt(
  cron: string,
  currentDate = new Date(),
  timezone: string = DEFAULT_SCHEDULE_TIMEZONE,
): Date {
  validateFiveFieldCron(cron);
  if (timezone === DEFAULT_SCHEDULE_TIMEZONE) {
    return CronExpressionParser.parse(cron, { currentDate, tz: "UTC" }).next().toDate();
  }
  const after = currentDate.getTime();
  // Wall-clock matches, in order, as if the zone's clock were UTC.
  const matches = CronExpressionParser.parse(cron, {
    currentDate: new Date(wallClockMs(after, timezone)),
    tz: "UTC",
  });
  // Placing a wall-clock time never moves it before an earlier one, so the
  // first match placed after `currentDate` is the answer. Skipped matches all
  // land on the end of the gap and repeated ones on their first pass, which
  // is what the loop steps over.
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const instant = instantForWallClock(matches.next().getTime(), timezone);
    if (instant > after) return new Date(instant);
  }
  throw new Error(`Schedule cron "${cron}" in ${timezone} has no upcoming run.`);
}

const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

/** The zone's wall-clock reading at `instant`, encoded as if that reading were UTC. */
function wallClockMs(instant: number, timezone: string): number {
  let format = wallClockFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    wallClockFormats.set(timezone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return (
    Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) +
    (((instant % 1000) + 1000) % 1000)
  );
}

const DAY_MS = 86_400_000;

/**
 * The instant the zone's clock first reads `wall`. A repeated reading gives
 * its first occurrence; a skipped one gives the first instant after the gap,
 * when the clock reads the next valid local time.
 */
function instantForWallClock(wall: number, timezone: string): number {
  const offsets = new Set([
    wallClockMs(wall - DAY_MS, timezone) - (wall - DAY_MS),
    wallClockMs(wall + DAY_MS, timezone) - (wall + DAY_MS),
  ]);
  const candidates = [...offsets].map((offset) => wall - offset);
  const exact = candidates.filter((instant) => wallClockMs(instant, timezone) === wall);
  if (exact.length > 0) return Math.min(...exact);
  // In a gap: the first instant whose reading is at or past `wall`.
  let low = Math.min(...candidates);
  let high = Math.max(...candidates);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (wallClockMs(middle, timezone) >= wall) high = middle;
    else low = middle;
  }
  return high;
}

export function describeScheduleCron(
  cron: string,
  timezone: string = DEFAULT_SCHEDULE_TIMEZONE,
): string {
  validateFiveFieldCron(cron);
  const description = cronstrue
    .toString(cron, {
      use24HourTimeFormat: true,
      verbose: true,
    })
    .replace(/, every hour, every day$/, "");
  return `${description} (${timezone})`;
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
  timezone: string;
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
  if (canonicalScheduleTimezone(input.timezone) !== input.timezone) {
    throw new Error("Schedule definition timezone must be a canonical IANA name.");
  }
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

function parseStrictFrontmatter(
  sourcePath: string,
  input: string,
): { cron?: string; timezone?: string } {
  const result: { cron?: string; timezone?: string } = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!match) throw new Error(`Markdown schedule ${sourcePath} has invalid frontmatter.`);
    const [, key, rawValue = ""] = match;
    if (key !== "cron" && key !== "timezone") {
      throw new Error(
        `Markdown schedule ${sourcePath} only supports the cron and timezone frontmatter fields.`,
      );
    }
    if (result[key] !== undefined) {
      throw new Error(`Markdown schedule ${sourcePath} declares ${key} more than once.`);
    }
    result[key] = unquote(rawValue.trim());
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
