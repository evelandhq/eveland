import { describe, expect, test } from "vitest";
import { createTestStore } from "@eveland/db/vitest";
import { createApp } from "./app.js";

describe("observability settings", () => {
  test("updates the revisioned Agent capture policy", async () => {
    const app = createApp(createTestStore());

    const initial = await app.request("/system/observability");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      revision: 1,
      agentCapture: {
        enabled: true,
        sampling: { ratio: 1 },
        recordInputs: true,
        recordOutputs: true,
        includeReasoning: true,
      },
      externalDestinations: [],
    });

    const updated = await app.request("/system/observability", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        agentCapture: {
          enabled: false,
          sampling: { ratio: 0.25 },
          recordInputs: true,
          recordOutputs: false,
          includeReasoning: false,
        },
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      revision: 2,
      agentCapture: {
        enabled: false,
        sampling: { ratio: 0.25 },
        recordInputs: true,
        recordOutputs: false,
        includeReasoning: false,
      },
    });

    const stale = await app.request("/system/observability", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        agentCapture: {
          enabled: true,
          sampling: { ratio: 1 },
          recordInputs: false,
          recordOutputs: false,
          includeReasoning: false,
        },
      }),
    });
    expect(stale.status).toBe(409);
  });
});
