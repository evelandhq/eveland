// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ProjectListItem } from "@/lib/server-api";

const api = vi.hoisted(() => ({ getProjects: vi.fn() }));
vi.mock("@/lib/server-api", () => api);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import ProjectsPage from "./page";

function project(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id: "proj_test",
    slug: "test-agent",
    name: "Test agent",
    description: null,
    importKind: "git",
    gitUrl: null,
    status: "deployed",
    deploymentStatus: "running",
    deletionStatus: null,
    deletionError: null,
    sourceRevisionId: null,
    releaseId: null,
    deploymentId: null,
    latestSessionStatus: "waiting",
    nextScheduleAt: null,
    createdAt: "2026-11-02T01:00:00.000Z",
    updatedAt: "2026-11-02T01:00:00.000Z",
    eveVersion: {
      version: "1.0.0-rc.1",
      expected: "0.83.x or 1.0.x",
      supportedRanges: ["0.83.x", "1.0.x"],
      supported: true,
      sourceRevisionId: null,
    },
    activity: {
      days: ["ok"],
      sessions: 1,
      succeeded: 0,
      failed: 0,
      awaiting: 0,
      successRate: null,
      p95DurationMs: null,
    },
    unacknowledgedFailedRuns: 0,
    ...overrides,
  };
}

describe("Projects session state", () => {
  test.each([
    [null, "Idle"],
    ["2026-11-03T01:00:00.000Z", "Scheduled"],
  ])("a waiting conversation with next run %s is %s", async (nextScheduleAt, label) => {
    api.getProjects.mockResolvedValue([project({ nextScheduleAt })]);

    render(await ProjectsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText(label, { exact: true })).toBeDefined();
    expect(screen.getByText("Ready for next message")).toBeDefined();
    expect(screen.getByRole("link", { name: "Needs review · 0" })).toBeDefined();
  });

  test("the review filter includes pending interactions and excludes idle conversations", async () => {
    api.getProjects.mockResolvedValue([
      project(),
      project({
        id: "proj_approval",
        name: "Approval agent",
        latestSessionStatus: "waiting_approval",
      }),
    ]);

    render(await ProjectsPage({ searchParams: Promise.resolve({ state: "attention" }) }));

    expect(screen.getByRole("link", { name: "Needs review · 1" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Approval agent" })).toBeDefined();
    expect(screen.getByText("Paused for your approval")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Test agent" })).toBeNull();
  });

  test("a waiting conversation preserves scheduled failure alerts", async () => {
    api.getProjects.mockResolvedValue([project({ unacknowledgedFailedRuns: 1 })]);

    render(await ProjectsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("Failed runs")).toBeDefined();
    expect(screen.getByText("1 scheduled run needs review")).toBeDefined();
  });
});
