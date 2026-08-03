import { describe, expect, test } from "vitest";
import { createTestStore } from "@eveland/db/vitest";
import { createApp } from "./app.js";

describe("usage analytics API", () => {
  test("returns the same scoped analytics contract for workspace and project usage", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "usage-api-agent",
      importKind: "zip",
    });
    const session = await store.createSession({
      projectId: project.id,
      trigger: "api",
    });
    await store.recordModelUsage(session.id, {
      eveSessionId: "eve_usage_api",
      agentId: "agent_usage_api",
      agentName: "Usage API agent",
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      costUsd: 0.003,
      usageReported: true,
    });

    const app = createApp(store);
    const workspaceResponse = await app.request("/usage?range=7d");
    expect(workspaceResponse.status).toBe(200);
    await expect(workspaceResponse.json()).resolves.toMatchObject({
      usage: {
        range: "7d",
        summary: {
          sessions: 1,
          modelSteps: 1,
          inputTokens: 80,
          outputTokens: 20,
          costUsd: 0.003,
        },
        projects: [
          expect.objectContaining({
            projectId: project.id,
            projectName: "usage-api-agent",
          }),
        ],
      },
    });

    const projectResponse = await app.request(`/projects/${project.id}/usage?range=7d`);
    expect(projectResponse.status).toBe(200);
    await expect(projectResponse.json()).resolves.toMatchObject({
      usage: {
        range: "7d",
        summary: { sessions: 1, modelSteps: 1 },
        projects: [expect.objectContaining({ projectId: project.id })],
      },
    });
  });
});
