import { describe, expect, test } from "vitest";
import {
  deploymentRowToDeployment,
  projectRowToProject,
  sessionRowToSession,
  timestampToIso,
} from "./mappers.js";

describe("db mappers", () => {
  test("converts nullable project timestamp fields to public API shape", () => {
    const createdAt = new Date("2026-07-01T01:00:00.000Z");
    const updatedAt = new Date("2026-07-01T02:00:00.000Z");

    const project = projectRowToProject({
      id: "proj_123",
      slug: "weather-agent",
      ownerId: "user_local_admin",
      name: "weather-agent",
      description: null,
      importKind: "git",
      gitUrl: null,
      status: "import_pending",
      deploymentStatus: "not_deployed",
      deletionStatus: "failed",
      deletionError: "runtime unavailable",
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
      slug: "weather-agent",
      name: "weather-agent",
      description: null,
      importKind: "git",
      gitUrl: null,
      status: "import_pending",
      deploymentStatus: "not_deployed",
      deletionStatus: "failed",
      deletionError: "runtime unavailable",
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

  test("maps a deployment row's runtime_kind column onto the RuntimeKind field", () => {
    const createdAt = new Date("2026-07-01T01:00:00.000Z");
    const updatedAt = new Date("2026-07-01T02:00:00.000Z");

    const deployment = deploymentRowToDeployment({
      id: "dep_123",
      deploymentKey: "a1b2c3d4",
      projectId: "proj_123",
      releaseId: "rel_123",
      containerName: "eveland-proj-dep_123",
      internalPort: 3000,
      hostPort: 41001,
      status: "running",
      runtimeKind: "systemd",
      createdAt,
      updatedAt,
    });

    expect(deployment).toEqual({
      id: "dep_123",
      deploymentKey: "a1b2c3d4",
      projectId: "proj_123",
      releaseId: "rel_123",
      containerName: "eveland-proj-dep_123",
      internalPort: 3000,
      hostPort: 41001,
      status: "running",
      runtimeKind: "systemd",
      createdAt: "2026-07-01T01:00:00.000Z",
      updatedAt: "2026-07-01T02:00:00.000Z",
    });
  });

  test("maps persisted token totals onto a session", () => {
    expect(
      sessionRowToSession({
        id: "sess_123",
        projectId: "proj_123",
        deploymentId: "dep_123",
        eveSessionId: "eve_123",
        rootNodeId: "node_123",
        routeId: null,
        experimentId: null,
        variantName: null,
        trigger: "playground",
        scheduleId: null,
        scheduleRunId: null,
        status: "completed",
        startedAt: new Date("2026-07-10T01:00:00.000Z"),
        completedAt: new Date("2026-07-10T01:01:00.000Z"),
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cacheWriteTokens: 10,
        costUsd: 0.0042,
        usageReportedSteps: 1,
        usageMissingSteps: 0,
      }),
    ).toMatchObject({
      usage: {
        status: "reported",
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cacheWriteTokens: 10,
        costUsd: 0.0042,
        reportedSteps: 1,
        missingSteps: 0,
      },
    });
  });
});
