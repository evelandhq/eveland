import { createTestStore } from "@evelandhq/db/vitest";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { RESERVED_RUNTIME_ENVIRONMENT_KEYS } from "../runtime/reserved-environment.js";
import { composeDeploymentEnv } from "./process-support.js";

const workflowPostgresUrl = "postgres://platform@host:5432/eveland";
const evelandWorldUrl = "postgres://platform@host:5432/eveland_workflow";

const baseOptions = {
  appSecretKey: "eveland-test-secret-key-00000000",
  nodeEnv: "production",
  schedulerRuntimeSecret: "scheduler-runtime-secret",
  schedulerRedeemUrl: "https://eveland.example.com/scheduler/redeem",
  identityIssuer: "https://identity.example.com",
  identityJwksUrl: "https://identity.example.com/.well-known/jwks.json",
} as const;

/**
 * Every platform-owned runtime name for a Deployment still on the legacy
 * per-project world. Only the legacy termination path launches with this kind;
 * no new build ever selects it.
 */
async function composeOnWorldPostgres() {
  return composeDeploymentEnv(
    createTestStore(),
    "proj_reserved",
    {
      ...baseOptions,
      workflowWorldKind: "legacy_project",
      workflowPostgresUrl,
      ensureProjectWorkflowWorld: async () => `${workflowPostgresUrl}_wf_proj_reserved`,
    },
    {},
  );
}

/**
 * The same, for a Deployment on the shared platform world — the only kind new
 * builds produce. The two sets are mutually exclusive by design — a project on
 * the platform world gets no per-project database, and so no
 * `WORKFLOW_POSTGRES_URL` — which is why the exported list is the union of
 * both rather than what either one produces.
 */
async function composeOnEvelandWorld() {
  return composeDeploymentEnv(
    createTestStore(),
    "proj_reserved",
    {
      ...baseOptions,
      workflowPostgresUrl,
      evelandWorkflowWorldUrl: evelandWorldUrl,
      ensureEvelandWorkflowTenant: async () => {},
      // The launch context passes the runtime-visible path (here: Docker's
      // fixed in-container mount); without the option the compose falls back
      // to the worker-visible default derived from EVELAND_DATA_DIR.
      memoryRootDir: "/var/lib/eveland-memory",
    },
    {
      EVELAND_WORKFLOW_WORLD_URL: evelandWorldUrl,
      EVELAND_WORKFLOW_STREAM_COMPACTION: "off",
    },
  );
}

describe("reserved runtime environment names", () => {
  // A Release build has no `reserved` layer of its own -- it drops these names
  // instead (see ../runtime/build-environment.ts). That only holds while the
  // exported list still describes what composeDeploymentEnv actually reserves,
  // so a name added to one side and not the other fails here rather than
  // silently letting a project's value into the next build.
  test("the exported list is exactly what composeDeploymentEnv reserves", async () => {
    const [legacy, platform] = await Promise.all([
      composeOnWorldPostgres(),
      composeOnEvelandWorld(),
    ]);

    // The project has no environment entries, so every remaining name in the
    // composed environments came from the reserved layer.
    const reserved = new Set([...Object.keys(legacy.env), ...Object.keys(platform.env)]);
    expect([...reserved].sort()).toEqual([...RESERVED_RUNTIME_ENVIRONMENT_KEYS].sort());
  });

  test("a project entry never wins against a reserved name at runtime", async () => {
    const { env } = await composeOnWorldPostgres();

    expect(env.NODE_ENV).toBe("production");
    expect(env.EVELAND_PROJECT_ID).toBe("proj_reserved");
    expect(env.WORKFLOW_POSTGRES_URL).toBe(`${workflowPostgresUrl}_wf_proj_reserved`);
    // No memoryRootDir option here, so the reserved value is the derived
    // worker-visible default: <EVELAND_DATA_DIR>/memory/<projectId>.
    expect(env.EVELAND_MEMORY_ROOT).toBe(path.resolve(".eveland-data", "memory", "proj_reserved"));
  });

  test("the platform world gets its own tenancy names and no per-project database", async () => {
    const { env, secretValues } = await composeOnEvelandWorld();

    expect(env.EVELAND_WORKFLOW_WORLD_URL).toBe(evelandWorldUrl);
    expect(env.EVELAND_WORKFLOW_RUNNER).toBe("external");
    expect(env.EVELAND_WORKFLOW_STREAM_COMPACTION).toBe("off");
    expect(env.EVELAND_SANDBOX_RUN_TIMEOUT_MS).toBe("600000");
    expect(env.EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES).toBe("64");
    expect(env.EVELAND_SANDBOX_MAX_OUTPUT_BYTES).toBe("16777216");
    expect(env.EVELAND_MEMORY_ROOT).toBe("/var/lib/eveland-memory");
    expect(env.EVELAND_PROJECT_ID).toBe("proj_reserved");
    // Provisioning a per-project database here would leave an empty one behind
    // for every project on the new world.
    expect(env.WORKFLOW_POSTGRES_URL).toBeUndefined();
    // The shared world URL carries credentials like the other connection
    // strings and must be masked out of logs the same way.
    expect(secretValues).toContain(evelandWorldUrl);
  });
});
