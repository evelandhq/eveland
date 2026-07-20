import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { modelUsageEvents, sessionNodes, sessions } from "./schema.js";
import { createPgliteTestStore } from "./test-store.js";

type UsageAnalyticsInput = {
  range: "24h" | "7d" | "30d";
  projectId?: string;
  modelId?: string;
  now: Date;
};

describe("SQL Store usage analytics", () => {
  test("aggregates workspace, project, and model usage without session pagination", async () => {
    const fixture = await createPgliteTestStore();
    const { db, store } = fixture;

    try {
      const support = await store.createProject({ name: "support-agent", importKind: "zip" });
      const research = await store.createProject({ name: "research-agent", importKind: "zip" });
      const supportRevision = await store.recordSourceRevision({
        projectId: support.id,
        kind: "zip",
        sourcePath: "/tmp/support-agent",
        summary: {},
        envVars: [],
        files: [],
        schedules: [],
      });
      const researchRevision = await store.recordSourceRevision({
        projectId: research.id,
        kind: "zip",
        sourcePath: "/tmp/research-agent",
        summary: {},
        envVars: [],
        files: [],
        schedules: [],
      });
      const supportDeployment = await store.recordDeployment({
        projectId: support.id,
        sourceRevisionId: supportRevision.id,
        imageTag: "fixture:support",
        containerName: "fixture-support",
        internalPort: 3000,
        hostPort: 41901,
        runtimeKind: "docker",
      });
      const researchDeployment = await store.recordDeployment({
        projectId: research.id,
        sourceRevisionId: researchRevision.id,
        imageTag: "fixture:research",
        containerName: "fixture-research",
        internalPort: 3000,
        hostPort: 41902,
        runtimeKind: "docker",
      });

      const supportSession = await store.createSession({
        projectId: support.id,
        deploymentId: supportDeployment.id,
        trigger: "api",
      });
      const researchSession = await store.createSession({
        projectId: research.id,
        deploymentId: researchDeployment.id,
        trigger: "cron",
      });
      const previousSession = await store.createSession({
        projectId: support.id,
        deploymentId: supportDeployment.id,
        trigger: "playground",
      });

      await db.insert(sessionNodes).values([
        {
          id: "node_support",
          rootSessionId: supportSession.id,
          projectId: support.id,
          eveSessionId: "eve_support",
          startedDeploymentId: supportDeployment.id,
          lastObservedDeploymentId: supportDeployment.id,
          agentId: "agent_triage",
          agentName: "Triage",
          modelId: "openai/gpt-5-mini",
          status: "completed",
        },
        {
          id: "node_research",
          rootSessionId: researchSession.id,
          projectId: research.id,
          eveSessionId: "eve_research",
          startedDeploymentId: researchDeployment.id,
          lastObservedDeploymentId: researchDeployment.id,
          agentId: "agent_researcher",
          agentName: "Researcher",
          modelId: "anthropic/claude-sonnet-4",
          status: "running",
        },
        {
          id: "node_previous",
          rootSessionId: previousSession.id,
          projectId: support.id,
          eveSessionId: "eve_previous",
          startedDeploymentId: supportDeployment.id,
          lastObservedDeploymentId: supportDeployment.id,
          agentId: "agent_triage",
          agentName: "Triage",
          modelId: "openai/gpt-5-mini",
          status: "completed",
        },
      ]);

      await db.insert(modelUsageEvents).values([
        {
          id: "usage_support_reported",
          sessionId: supportSession.id,
          sessionNodeId: "node_support",
          eveSessionId: "eve_support",
          agentId: "agent_triage",
          agentName: "Triage",
          turnId: "turn_support",
          stepIndex: 0,
          finishReason: "stop",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 60,
          cacheWriteTokens: 5,
          costUsd: 0.004,
          usageReported: true,
          createdAt: new Date("2026-07-20T10:10:00.000Z"),
        },
        {
          id: "usage_support_missing",
          sessionId: supportSession.id,
          sessionNodeId: "node_support",
          eveSessionId: "eve_support",
          agentId: "agent_triage",
          agentName: "Triage",
          turnId: "turn_support",
          stepIndex: 1,
          finishReason: "stop",
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: null,
          usageReported: false,
          createdAt: new Date("2026-07-20T10:11:00.000Z"),
        },
        {
          id: "usage_research",
          sessionId: researchSession.id,
          sessionNodeId: "node_research",
          eveSessionId: "eve_research",
          agentId: "agent_researcher",
          agentName: "Researcher",
          turnId: "turn_research",
          stepIndex: 0,
          finishReason: "tool-calls",
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: null,
          usageReported: true,
          createdAt: new Date("2026-07-20T11:05:00.000Z"),
        },
        {
          id: "usage_previous",
          sessionId: previousSession.id,
          sessionNodeId: "node_previous",
          eveSessionId: "eve_previous",
          agentId: "agent_triage",
          agentName: "Triage",
          turnId: "turn_previous",
          stepIndex: 0,
          finishReason: "stop",
          inputTokens: 40,
          outputTokens: 5,
          cacheReadTokens: 10,
          cacheWriteTokens: 2,
          costUsd: 0.002,
          usageReported: true,
          createdAt: new Date("2026-07-19T10:05:00.000Z"),
        },
      ]);

      await db
        .update(sessions)
        .set({
          status: "completed",
          startedAt: new Date("2026-07-20T10:00:00.000Z"),
          completedAt: new Date("2026-07-20T10:12:00.000Z"),
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 60,
          cacheWriteTokens: 5,
          costUsd: 0.004,
          usageReportedSteps: 1,
          usageMissingSteps: 1,
        })
        .where(eq(sessions.id, supportSession.id));
      await db
        .update(sessions)
        .set({
          status: "running",
          startedAt: new Date("2026-07-20T11:00:00.000Z"),
          inputTokens: 50,
          outputTokens: 10,
          usageReportedSteps: 1,
        })
        .where(eq(sessions.id, researchSession.id));
      await db
        .update(sessions)
        .set({
          status: "completed",
          startedAt: new Date("2026-07-19T10:00:00.000Z"),
          completedAt: new Date("2026-07-19T10:06:00.000Z"),
          inputTokens: 40,
          outputTokens: 5,
          cacheReadTokens: 10,
          cacheWriteTokens: 2,
          costUsd: 0.002,
          usageReportedSteps: 1,
        })
        .where(eq(sessions.id, previousSession.id));

      const getUsageAnalytics = Reflect.get(store, "getUsageAnalytics") as
        | ((input: UsageAnalyticsInput) => Promise<any>)
        | undefined;
      expect(getUsageAnalytics).toBeTypeOf("function");

      const workspace = await getUsageAnalytics!.call(store, {
        range: "24h",
        now: new Date("2026-07-20T12:00:00.000Z"),
      });
      expect(workspace.summary).toMatchObject({
        sessions: 2,
        runningSessions: 1,
        completedSessions: 1,
        failedSessions: 0,
        modelSteps: 3,
        inputTokens: 150,
        outputTokens: 30,
        cacheReadTokens: 60,
        cacheWriteTokens: 5,
        costUsd: 0.004,
        reportedSteps: 2,
        missingSteps: 1,
        costReportedSteps: 1,
      });
      expect(workspace.previousSummary).toMatchObject({
        sessions: 1,
        modelSteps: 1,
        inputTokens: 40,
        outputTokens: 5,
        costUsd: 0.002,
      });
      expect(workspace.series).toHaveLength(24);
      expect(workspace.series.reduce((total: number, point: { modelSteps: number }) => total + point.modelSteps, 0)).toBe(3);
      expect(workspace.projects).toEqual([
        expect.objectContaining({ projectId: support.id, projectName: "support-agent", sessions: 1, modelSteps: 2 }),
        expect.objectContaining({ projectId: research.id, projectName: "research-agent", sessions: 1, modelSteps: 1 }),
      ]);
      expect(workspace.models).toEqual([
        expect.objectContaining({ modelId: "openai/gpt-5-mini", sessions: 1, modelSteps: 2, missingSteps: 1 }),
        expect.objectContaining({ modelId: "anthropic/claude-sonnet-4", sessions: 1, modelSteps: 1 }),
      ]);
      expect(workspace.agentModels).toEqual([
        expect.objectContaining({
          agentId: "agent_triage",
          agentName: "Triage",
          modelId: "openai/gpt-5-mini",
          modelSteps: 2,
        }),
        expect.objectContaining({
          agentId: "agent_researcher",
          agentName: "Researcher",
          modelId: "anthropic/claude-sonnet-4",
          modelSteps: 1,
        }),
      ]);
      expect(workspace.recentSessions).toHaveLength(2);

      const project = await getUsageAnalytics!.call(store, {
        range: "24h",
        projectId: support.id,
        now: new Date("2026-07-20T12:00:00.000Z"),
      });
      expect(project.summary).toMatchObject({ sessions: 1, modelSteps: 2, inputTokens: 100, outputTokens: 20 });
      expect(project.projects).toEqual([
        expect.objectContaining({ projectId: support.id, projectName: "support-agent" }),
      ]);
      expect(project.models).toHaveLength(1);

      const model = await getUsageAnalytics!.call(store, {
        range: "24h",
        modelId: "openai/gpt-5-mini",
        now: new Date("2026-07-20T12:00:00.000Z"),
      });
      expect(model.summary).toMatchObject({ sessions: 1, modelSteps: 2, inputTokens: 100, outputTokens: 20 });
      expect(model.models).toEqual([
        expect.objectContaining({ modelId: "openai/gpt-5-mini", modelSteps: 2 }),
        expect.objectContaining({
          modelId: "anthropic/claude-sonnet-4",
          modelSteps: 1,
        }),
      ]);
      expect(model.recentSessions).toEqual([
        expect.objectContaining({ id: supportSession.id }),
      ]);
    } finally {
      await fixture.close();
    }
  });
});
