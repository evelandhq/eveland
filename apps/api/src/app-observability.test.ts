import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { recordObservedModelUsage } from "./app.test-support.js";
import { createTestStore } from "@evelandhq/db/vitest";

describe("api app", () => {
  test("returns per-agent model usage for a session", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Usage API Agent",
      importKind: "zip",
    });
    const { session } = await recordObservedModelUsage(store, {
      projectId: project.id,
      eveSessionId: "eve_root",
      agent: { id: "agent_root", name: "Root agent" },
      usage: { inputTokens: 20, outputTokens: 5 },
    });

    const response = await createApp(store).request(`/api/sessions/${session.id}/usage`);

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
