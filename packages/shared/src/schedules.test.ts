import { describe, expect, test } from "vitest";
import { getNextRunAt, parseMarkdownSchedule } from "./schedules.js";

describe("parseMarkdownSchedule", () => {
  test("parses cron, timezone, prompt, name, and source path from Markdown frontmatter", () => {
    const schedule = parseMarkdownSchedule(
      "agent/schedules/daily-report.md",
      `---
cron: "0 8 * * *"
timezone: "Asia/Shanghai"
enabled: true
---
Send the daily report.
`,
    );

    expect(schedule).toEqual({
      name: "daily-report",
      kind: "markdown",
      cron: "0 8 * * *",
      timezone: "Asia/Shanghai",
      enabled: true,
      sourcePath: "agent/schedules/daily-report.md",
      prompt: "Send the daily report.",
      executable: true,
    });
  });

  test("marks TypeScript schedules as non-executable in the MVP parser", () => {
    const schedule = parseMarkdownSchedule(
      "agent/schedules/weekly.ts",
      `import { defineSchedule } from "eve/schedules";`,
    );

    expect(schedule).toEqual({
      name: "weekly",
      kind: "typescript",
      sourcePath: "agent/schedules/weekly.ts",
      executable: false,
    });
  });

  test("computes the next run using the schedule timezone", () => {
    const nextRun = getNextRunAt("0 8 * * *", "Asia/Shanghai", new Date("2026-06-30T23:00:00.000Z"));

    expect(nextRun.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});
