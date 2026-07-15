import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("schedule history surfaces", () => {
  test("renders ScheduleRun envelopes, linked Sessions, filters, and detail provenance", () => {
    const sessions = source("./projects/[projectId]/sessions/page.tsx");
    const schedules = source("./projects/[projectId]/schedules/page.tsx");
    const detailPath = new URL("./projects/[projectId]/schedule-runs/[scheduleRunId]/page.tsx", import.meta.url);

    expect(existsSync(fileURLToPath(detailPath))).toBe(true);
    expect(sessions).toContain("getScheduleRuns");
    expect(sessions).toContain("run.sessions.map");
    expect(sessions).toContain("run.sessionCount");
    expect(sessions).toContain("Runs remain visible even when a successful handler creates zero Sessions");
    expect(sessions).toContain("query.schedule");
    expect(sessions).toContain("<Table");
    expect(schedules).toContain("Markdown and TypeScript schedules");
    expect(schedules).toContain("<RunScheduleAction");
    expect(schedules).toContain("<Card");
    const detail = source("./projects/[projectId]/schedule-runs/[scheduleRunId]/page.tsx");
    expect(detail).toContain("run.release.id");
    expect(detail).toContain("run.deployment.id");
    expect(detail).toContain("run.missedTicks");
    expect(detail).toContain("run.error");
  });

  test("uses the filtered paginated API instead of filtering full history in the browser", () => {
    const serverApi = source("../lib/server-api.ts");
    expect(serverApi).toContain("export const getScheduleRuns");
    expect(serverApi).toContain("export const getSessionsPage");
    expect(serverApi).toContain("queryString(filters)");
  });
});
