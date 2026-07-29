import { createDefaultObservabilityPolicy } from "@eveland/core/observability";
import { describe, expect, test } from "vitest";
import { DEFAULT_TEAM_ID } from "./store.js";
import { createTestStore } from "./vitest-store.js";

describe("observability policy store", () => {
  test("provides the built-in default and persists revisioned admin policy", async () => {
    const store = createTestStore();
    await store.createProject({
      name: "Observed Agent",
      importKind: "zip",
    });

    await expect(
      store.getObservabilityPolicy(DEFAULT_TEAM_ID),
    ).resolves.toEqual(createDefaultObservabilityPolicy(1));

    const updated = await store.saveObservabilityPolicy({
      teamId: DEFAULT_TEAM_ID,
      expectedRevision: 1,
      agentCapture: {
        enabled: false,
        sampling: { ratio: 0.25 },
        recordInputs: true,
        recordOutputs: false,
        includeReasoning: false,
      },
      externalDestinations: [],
    });

    expect(updated).toEqual({
      schemaVersion: 1,
      revision: 2,
      agentCapture: {
        enabled: false,
        sampling: { ratio: 0.25 },
        recordInputs: true,
        recordOutputs: false,
        includeReasoning: false,
      },
      externalDestinations: [],
    });
    await expect(
      store.getObservabilityPolicy(DEFAULT_TEAM_ID),
    ).resolves.toEqual(updated);
    await expect(
      store.saveObservabilityPolicy({
        teamId: DEFAULT_TEAM_ID,
        expectedRevision: 1,
        agentCapture: updated!.agentCapture,
        externalDestinations: [],
      }),
    ).resolves.toBeNull();
  });
});
