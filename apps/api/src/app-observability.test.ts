import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createTestStore } from "@evelandhq/db/vitest";

describe("api app", () => {
  test("leaves token usage projection to the observer collector", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Token Agent",
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "0.29.5" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/token:rel_123",
      containerName: "eveland-token",
      internalPort: 3000,
      hostPort: 41002,
      runtimeKind: "docker",
    });

    // Playground-persisted session events never project usage: the observer
    // collector is the only usage writer. This is the exact write sequence
    // the Playground session bookkeeping performs.
    const session = await store.createSession({
      projectId: project.id,
      deploymentId: deployment.id,
      trigger: "playground",
      scheduleId: null,
    });
    await store.appendSessionEvent(session.id, "message", {
      role: "user",
      content: "Count this",
    });
    await store.appendSessionEvent(session.id, "step.completed", {
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      usage: { inputTokens: 90, outputTokens: 10, cacheReadTokens: 50 },
    });
    await store.appendSessionEvent(session.id, "model_response", {
      content: "Counted",
    });
    const completed = await store.completeSession(session.id, {
      status: "waiting",
      eveSessionId: "eve_usage",
      continuationToken: null,
    });

    expect(completed?.usage).toMatchObject({
      status: "none",
      inputTokens: 0,
      outputTokens: 0,
      reportedSteps: 0,
    });
    await expect(store.listModelUsageEvents(session.id)).resolves.toEqual([]);
  });

  test("returns per-agent model usage for a session", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Usage API Agent",
      importKind: "zip",
    });
    const session = await store.createSession({
      projectId: project.id,
      trigger: "playground",
    });
    await store.recordModelUsage(session.id, {
      eveSessionId: "eve_root",
      agentId: "agent_root",
      agentName: "Root agent",
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: true,
    });

    const response = await createApp(store).request(`/sessions/${session.id}/usage`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      usage: [
        expect.objectContaining({
          eveSessionId: "eve_root",
          agentId: "agent_root",
          inputTokens: 20,
          outputTokens: 5,
        }),
      ],
    });
  });
});
