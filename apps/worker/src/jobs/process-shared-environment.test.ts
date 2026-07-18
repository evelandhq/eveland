import { describe, expect, test } from "vitest";
import { createMemoryStore } from "@eveland/db";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import { composeDeploymentEnv } from "./process-support.js";

const appSecretKey = "eveland-test-secret-key-00000000";

describe("shared Agent environment compatibility", () => {
  test("keeps an existing runtime Profile binding effective until it is replaced", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Legacy Runtime Profile Agent", importKind: "zip" });
    const legacy = await store.savePlatformSecretProfile({
      name: "Legacy runtime credentials",
      entries: [{
        key: "LEGACY_LLM_KEY",
        kind: "secret",
        encryptedValue: JSON.stringify(encryptSecretValue("legacy-value", appSecretKey)),
      }],
    });
    await store.bindPlatformSecretProfile({
      profileId: legacy.id,
      projectId: project.id,
      deploymentId: null,
      consumer: "agent-runtime",
    });

    const { env } = await composeDeploymentEnv(store, project.id, "dep_legacy", {
      appSecretKey,
      nodeEnv: "development",
    });

    expect(env.LEGACY_LLM_KEY).toBe("legacy-value");
  });
});
