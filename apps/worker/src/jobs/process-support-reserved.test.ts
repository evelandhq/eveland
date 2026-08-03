import { createTestStore } from "@eveland/db/vitest";
import { describe, expect, test } from "vitest";

import { RESERVED_RUNTIME_ENVIRONMENT_KEYS } from "../runtime/reserved-environment.js";
import { composeDeploymentEnv } from "./process-support.js";

const workflowPostgresUrl = "postgres://platform@host:5432/eveland";

/**
 * Every platform-owned runtime name, with each conditional branch of
 * composeDeploymentEnv's `reserved` object turned on.
 */
async function composeWithEveryReservedName() {
  const store = createTestStore();
  return composeDeploymentEnv(
    store,
    "proj_reserved",
    {
      appSecretKey: "eveland-test-secret-key-00000000",
      nodeEnv: "production",
      workflowPostgresUrl,
      ensureProjectWorkflowWorld: async () => `${workflowPostgresUrl}_wf_proj_reserved`,
      schedulerRuntimeSecret: "scheduler-runtime-secret",
      schedulerRedeemUrl: "https://eveland.example.com/scheduler/redeem",
      identityIssuer: "https://identity.example.com",
      identityJwksUrl: "https://identity.example.com/.well-known/jwks.json",
    },
    {},
  );
}

describe("reserved runtime environment names", () => {
  // A Release build has no `reserved` layer of its own -- it drops these names
  // instead (see ../runtime/build-environment.ts). That only holds while the
  // exported list still describes what composeDeploymentEnv actually reserves,
  // so a name added to one side and not the other fails here rather than
  // silently letting a project's value into the next build.
  test("the exported list is exactly what composeDeploymentEnv reserves", async () => {
    const { env } = await composeWithEveryReservedName();

    // The project has no environment entries, so every remaining name in the
    // composed environment came from the reserved layer.
    expect(Object.keys(env).sort()).toEqual([...RESERVED_RUNTIME_ENVIRONMENT_KEYS].sort());
  });

  test("a project entry never wins against a reserved name at runtime", async () => {
    const { env } = await composeWithEveryReservedName();

    expect(env.NODE_ENV).toBe("production");
    expect(env.EVELAND_PROJECT_ID).toBe("proj_reserved");
    expect(env.WORKFLOW_POSTGRES_URL).toBe(`${workflowPostgresUrl}_wf_proj_reserved`);
  });
});
