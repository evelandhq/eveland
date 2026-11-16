import { encryptSecretValue } from "@evelandhq/core/server/secrets";
import { createTestStore } from "@evelandhq/db/vitest";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  RESERVED_RUNTIME_ENVIRONMENT_KEYS,
  RESERVED_RUNTIME_ENVIRONMENT_SOURCES,
} from "../runtime/reserved-environment.js";
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

const encrypt = (value: string) =>
  JSON.stringify(encryptSecretValue(value, baseOptions.appSecretKey));

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
      WORKFLOW_WORLD_URL: evelandWorldUrl,
      WORKFLOW_WORLD_STREAM_COMPACTION: "off",
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

  // The half of the sync that keeps the drift reconciler honest: a reserved
  // name whose platform inputs are undeclared is invisible to the fingerprint,
  // which is precisely how every non-Identity name escaped the check until
  // issue #477. Declaring an empty list is a legitimate answer -- it says the
  // value is derived per project and cannot drift -- but it has to be said out
  // loud.
  test("every reserved name declares the platform inputs it derives from", () => {
    const undeclared = RESERVED_RUNTIME_ENVIRONMENT_KEYS.filter(
      (key) => RESERVED_RUNTIME_ENVIRONMENT_SOURCES[key] === undefined,
    );

    expect(undeclared).toEqual([]);
    // EVELAND_PROJECT_ID and WORKFLOW_WORLD_TENANT_ID are derived per project; the EVELAND_MODEL_GATEWAY_KIND
    // and _URL names come from the database at every launch; EVE_SCHEDULES_DISABLED,
    // EVE_TELEMETRY_DISABLED and WORKFLOW_SPEC_VERSION are platform constants. None
    // has a worker-environment input.
    expect(
      RESERVED_RUNTIME_ENVIRONMENT_KEYS.filter(
        (key) => RESERVED_RUNTIME_ENVIRONMENT_SOURCES[key]?.length === 0,
      ),
    ).toEqual([
      "EVELAND_MODEL_GATEWAY_KIND",
      "EVELAND_MODEL_GATEWAY_URL",
      "EVELAND_PROJECT_ID",
      "WORKFLOW_SPEC_VERSION",
      "WORKFLOW_WORLD_TENANT_ID",
      "EVE_TELEMETRY_DISABLED",
      "EVE_SCHEDULES_DISABLED",
    ]);
  });

  test("a project entry cannot aim the injected provider at a gateway of its own", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "gateway-spoof", importKind: "zip" });
    await store.saveModelGateway({ kind: "litellm", baseUrl: "https://llm.example/v1" });
    await store.upsertSecrets(project.id, [
      { key: "EVELAND_MODEL_GATEWAY_KIND", value: encrypt("openai-compatible"), kind: "variable" },
      {
        key: "EVELAND_MODEL_GATEWAY_URL",
        value: encrypt("https://attacker.example/v1"),
        kind: "variable",
      },
      { key: "AI_GATEWAY_API_KEY", value: encrypt("sk-project-own"), kind: "secret" },
    ]);

    const { env, secretValues } = await composeDeploymentEnv(store, project.id, baseOptions, {});

    expect(env.EVELAND_MODEL_GATEWAY_KIND).toBe("litellm");
    expect(env.EVELAND_MODEL_GATEWAY_URL).toBe("https://llm.example/v1");
    // The key is the project's own, delivered and masked like any secret.
    expect(env.AI_GATEWAY_API_KEY).toBe("sk-project-own");
    expect(secretValues).toContain("sk-project-own");
  });

  test("a project entry never wins against a reserved name at runtime", async () => {
    const { env } = await composeOnWorldPostgres();

    expect(env.NODE_ENV).toBe("production");
    expect(env.EVELAND_PROJECT_ID).toBe("proj_reserved");
    // eve 0.52.0 turned CLI telemetry on by default; `npx eve start` runs the CLI.
    expect(env.EVE_TELEMETRY_DISABLED).toBe("1");
    // The platform scheduler dispatches every authored schedule; eve's own
    // cron would run each one a second time.
    expect(env.EVE_SCHEDULES_DISABLED).toBe("1");
    expect(env.WORKFLOW_POSTGRES_URL).toBe(`${workflowPostgresUrl}_wf_proj_reserved`);
    // No memoryRootDir option here, so the reserved value is the derived
    // worker-visible default: <EVELAND_DATA_DIR>/memory/<projectId>.
    expect(env.EVELAND_MEMORY_ROOT).toBe(path.resolve(".eveland-data", "memory", "proj_reserved"));
  });

  test("a project entry cannot retarget the shared World under the World's own names", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "world-spoof", importKind: "zip" });
    await store.upsertSecrets(project.id, [
      { key: "WORKFLOW_WORLD_TENANT_ID", value: encrypt("proj_someone_else"), kind: "variable" },
      { key: "WORKFLOW_WORLD_URL", value: encrypt("postgres://x@evil/db"), kind: "secret" },
      { key: "WORKFLOW_WORLD_RUNTIME_SECRET", value: encrypt("chosen"), kind: "secret" },
      { key: "WORKFLOW_SPEC_VERSION", value: encrypt("8"), kind: "variable" },
      { key: "WORKFLOW_WORLD_STREAM_COMPACTION", value: encrypt("off"), kind: "variable" },
      { key: "WORKFLOW_POSTGRES_MAX_POOL_SIZE", value: encrypt("500"), kind: "variable" },
    ]);

    const { env } = await composeDeploymentEnv(
      store,
      project.id,
      {
        ...baseOptions,
        evelandWorkflowWorldUrl: evelandWorldUrl,
        ensureEvelandWorkflowTenant: async () => {},
      },
      { WORKFLOW_POSTGRES_MAX_POOL_SIZE: "4" },
    );

    expect(env.WORKFLOW_WORLD_TENANT_ID).toBe(project.id);
    expect(env.WORKFLOW_WORLD_URL).toBe(evelandWorldUrl);
    expect(env.WORKFLOW_WORLD_RUNTIME_SECRET).toBe(baseOptions.schedulerRuntimeSecret);
    expect(env.WORKFLOW_WORLD_STREAM_COMPACTION).toBe("on");
    // Empty is unset to eve, which then asks for the spec the World serves.
    expect(env.WORKFLOW_SPEC_VERSION).toBe("");
    // Connection capacity on the shared instance is platform-planned.
    expect(env.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBe("4");
  });

  test("the platform world gets its own tenancy names and no per-project database", async () => {
    const { env, secretValues } = await composeOnEvelandWorld();

    expect(env.WORKFLOW_WORLD_URL).toBe(evelandWorldUrl);
    expect(env.WORKFLOW_WORLD_TENANT_ID).toBe("proj_reserved");
    expect(env.WORKFLOW_WORLD_STREAM_COMPACTION).toBe("off");
    expect(env.WORKFLOW_WORLD_RUNTIME_SECRET).toBe(baseOptions.schedulerRuntimeSecret);
    expect(env.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBe("10");
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
