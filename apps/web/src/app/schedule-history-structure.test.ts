import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("schedule history surfaces", () => {
  test("keeps Sessions session-only and renders recent Schedule runs under Schedules", () => {
    const sessions = source("./projects/[projectId]/sessions/page.tsx");
    const schedules = source("./projects/[projectId]/schedules/page.tsx");
    const sessionDetail = source("./projects/[projectId]/sessions/[sessionId]/page.tsx");
    const detailPath = new URL(
      "./projects/[projectId]/schedule-runs/[scheduleRunId]/page.tsx",
      import.meta.url,
    );

    expect(existsSync(fileURLToPath(detailPath))).toBe(true);
    expect(sessions).toContain("getSessionsPage");
    expect(sessions).toContain("sessionPage.sessions.map");
    expect(sessions).toContain("scheduleId: query.schedule");
    expect(sessions).toContain("<Table");
    // Whitespace-insensitive on purpose: pinning exact indentation makes this
    // fail on any reformat or change of nesting depth without catching a single
    // real regression. What matters is that Sessions renders the trigger label.
    expect(sessions.replace(/\s+/g, " ")).toContain(
      '<TableCell className="text-xs"> <span>{triggerLabel(session.trigger)}</span>',
    );
    expect(schedules).toContain("getScheduleRuns");
    expect(schedules).toContain("Recent runs");
    expect(schedules).toContain("describeScheduleCron");
    expect(schedules).toContain("run.sessions.length === 1");
    expect(schedules).toContain("href={`/projects/${projectId}/schedules#recent-runs`}");
    expect(schedules).toContain("Markdown and TypeScript schedules");
    expect(schedules).toContain("<RunScheduleAction");
    expect(sessionDetail).toContain("getScheduleRun");
    expect(sessionDetail).toContain("describeScheduleCron");
    expect(sessionDetail).toContain("Run details");
    const detail = source("./projects/[projectId]/schedule-runs/[scheduleRunId]/page.tsx");
    expect(detail).toContain("run.release.id");
    expect(detail).toContain("run.deployment.id");
    expect(detail).toContain("run.missedTicks");
    expect(detail).toContain("run.error");
  });

  test("uses filtered paginated APIs instead of filtering full history in the browser", () => {
    const serverApi = source("../lib/server-api.ts");
    expect(serverApi).toContain("export const getScheduleRuns");
    expect(serverApi).toContain("export const getSessionsPage");
    expect(serverApi).toContain("queryString(filters)");
  });
});
