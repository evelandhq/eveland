import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test } from "vitest";

import { composeDeploymentEnv } from "./process-support.js";

const workflowPostgresUrl = "postgres://platform@host.docker.internal:5432/eveland";

async function composeWithWorkflowWorld(workerEnv: NodeJS.ProcessEnv) {
  const store = createTestStore();
  return composeDeploymentEnv(
    store,
    "proj_pool",
    {
      appSecretKey: "eveland-test-secret-key-00000000",
      workflowPostgresUrl,
      ensureProjectWorkflowWorld: async () => `${workflowPostgresUrl}_wf_proj_pool`,
    },
    workerEnv,
  );
}

describe("composeDeploymentEnv workflow pool size", () => {
  test("injects the default max pool size alongside the workflow URL", async () => {
    const result = await composeWithWorkflowWorld({});

    expect(result.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBe("10");
  });

  test("passes the worker's configured pool size through to the deployment", async () => {
    const result = await composeWithWorkflowWorld({ WORKFLOW_POSTGRES_MAX_POOL_SIZE: "25" });

    expect(result.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBe("25");
  });

  test("falls back to the default when the configured pool size is not a positive integer", async () => {
    for (const invalid of ["", "0", "-3", "abc"]) {
      const result = await composeWithWorkflowWorld({ WORKFLOW_POSTGRES_MAX_POOL_SIZE: invalid });

      expect(result.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBe("10");
    }
  });

  test("does not inject a pool size when no workflow world is configured", async () => {
    const store = createTestStore();

    const result = await composeDeploymentEnv(
      store,
      "proj_pool",
      { appSecretKey: "eveland-test-secret-key-00000000", nodeEnv: "development" },
      {},
    );

    expect(result.env.WORKFLOW_POSTGRES_URL).toBeUndefined();
    expect(result.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBeUndefined();
  });
});
