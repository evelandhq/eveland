import { describe, expect, test } from "vitest";
import { projectRowToProject, timestampToIso } from "./mappers.js";

describe("db mappers", () => {
  test("converts nullable project timestamp fields to public API shape", () => {
    const createdAt = new Date("2026-07-01T01:00:00.000Z");
    const updatedAt = new Date("2026-07-01T02:00:00.000Z");

    const project = projectRowToProject({
      id: "proj_123",
      ownerId: "user_local_admin",
      name: "Weather Agent",
      importKind: "git",
      gitUrl: null,
      status: "import_pending",
      deploymentStatus: "not_deployed",
      sourceRevisionId: null,
      releaseId: null,
      deploymentId: null,
      latestSessionStatus: null,
      nextScheduleAt: null,
      createdAt,
      updatedAt,
    });

    expect(project).toEqual({
      id: "proj_123",
      name: "Weather Agent",
      importKind: "git",
      gitUrl: null,
      status: "import_pending",
      deploymentStatus: "not_deployed",
      sourceRevisionId: null,
      releaseId: null,
      deploymentId: null,
      latestSessionStatus: null,
      nextScheduleAt: null,
      createdAt: "2026-07-01T01:00:00.000Z",
      updatedAt: "2026-07-01T02:00:00.000Z",
    });
  });

  test("accepts null timestamps where API fields are nullable", () => {
    expect(timestampToIso(null)).toBeNull();
  });
});
