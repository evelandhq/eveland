import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";

const serviceHeaders = {
  authorization: "Bearer gateway-service-token",
  "content-type": "application/json",
};

/** The cluster identity both the fixture dispatcher and the API expect. */
const WORLD_IDENTITY = "cluster:7234567890123456789/eveland_workflow";

function heartbeatBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    instanceId: "wfd_api_test",
    generation: "eveland-workflow-dispatcher test",
    state: "recovering",
    ownershipAcquired: true,
    bootRecoveryCompleted: true,
    reenqueuedRuns: 2,
    worldDatabaseIdentity: WORLD_IDENTITY,
    schemaGeneration: "0013_run_quarantines.sql",
    protocolMin: 1,
    protocolMax: 1,
    startedAt: new Date().toISOString(),
    readyAt: null,
    ...overrides,
  });
}

async function createDeployableFixture(
  store: ReturnType<typeof createTestStore>,
  workflowWorld?: {
    worldKind: "shared" | "legacy_project" | "unknown";
    worldPackage: string | null;
    worldVersion: string | null;
    storageSpec: number | null;
    dispatchProtocol: number | null;
    enqueueCapability: "per_run_queue_v1" | "unscoped" | "unknown";
  },
) {
  const project = await store.createProject({ name: "Dispatcher Gate Agent", importKind: "zip" });
  const importJob = await store.claimNextJob("fixture-import");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/dispatcher-gate",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "fixture:dispatcher-gate",
    containerName: `fixture-dispatcher-gate-${Math.random().toString(36).slice(2, 8)}`,
    internalPort: 3000,
    hostPort: 42_300 + Math.floor(Math.random() * 500),
    runtimeKind: "docker",
    ...(workflowWorld ? { workflowWorld } : {}),
  });
  await store.updateDeploymentStatus(deployment.id, "stopped");
  return deployment;
}

const sharedAttestation = {
  worldKind: "shared" as const,
  worldPackage: "@evelandhq/workflow-world",
  worldVersion: "0.11.0",
  storageSpec: 6,
  dispatchProtocol: 1,
  enqueueCapability: "per_run_queue_v1" as const,
};

describe("workflow dispatcher registration API", () => {
  test("heartbeat requires service auth and persists the registration", async () => {
    const store = createTestStore();
    const app = createApp(store, { gatewayServiceToken: "gateway-service-token" });

    const unauthenticated = await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: heartbeatBody(),
    });
    expect(unauthenticated.status).toBe(404);

    const first = await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody(),
    });
    expect(first.status).toBe(200);
    expect((await first.json()) as { registration: { state: string } }).toMatchObject({
      registration: { state: "recovering" },
    });

    const registration = await app.request("/internal/workflow/dispatcher/registration", {
      method: "GET",
      headers: serviceHeaders,
    });
    expect(registration.status).toBe(200);
    const registrationBody = (await registration.json()) as {
      registration: { state: string; worldDatabaseIdentity: string };
    };
    expect(registrationBody.registration).toMatchObject({
      state: "recovering",
      worldDatabaseIdentity: WORLD_IDENTITY,
    });
    // The readiness surface never carries credentials.
    expect(JSON.stringify(registrationBody)).not.toContain("postgres://");
  });

  test("rejects a registration whose database identity could carry credentials", async () => {
    const store = createTestStore();
    const app = createApp(store, { gatewayServiceToken: "gateway-service-token" });

    const response = await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody({
        worldDatabaseIdentity: "postgres://user:secret@localhost:5432/eveland_workflow",
      }),
    });
    expect(response.status).toBe(400);

    // The legacy host:port/database shape no longer registers either: the
    // readiness gate compares cluster fingerprints, and a URL-derived identity
    // is exactly the fails-open comparison the cluster form exists to replace.
    const legacyShape = await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody({ worldDatabaseIdentity: "localhost:5432/eveland_workflow" }),
    });
    expect(legacyShape.status).toBe(400);

    // "unknown" stays registrable: a dispatcher that cannot read its World
    // must still be able to report itself (it never satisfies readiness).
    const unknownIdentity = await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody({ worldDatabaseIdentity: "unknown" }),
    });
    expect(unknownIdentity.status).toBe(200);
  });
});

describe("workflow_step activation gating", () => {
  async function activate(
    app: ReturnType<typeof createApp>,
    deploymentId: string,
    instanceId = "wfd_api_test",
  ) {
    return app.request("/internal/runtime/activations", {
      method: "POST",
      headers: { ...serviceHeaders, "x-eveland-dispatcher-instance": instanceId },
      body: JSON.stringify({
        deploymentId,
        kind: "workflow_step",
        ownerId: "wfd_api_test",
      }),
    });
  }

  test("fails closed with workflow_unavailable when no fresh dispatcher registration exists", async () => {
    const store = createTestStore();
    const deployment = await createDeployableFixture(store, sharedAttestation);
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      worldClusterIdentity: WORLD_IDENTITY,
    });

    const response = await activate(app, deployment.id);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("workflow_unavailable");
  });

  test("negotiates protocol and enqueue capability for a shared release", async () => {
    const store = createTestStore();
    const deployment = await createDeployableFixture(store, sharedAttestation);
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      worldClusterIdentity: WORLD_IDENTITY,
      runtimeActivationWaiter: async (claim) => {
        const ready = await store.updateRuntimeInstance(claim.runtimeInstance.id, {
          status: "ready",
          endpointHost: "127.0.0.1",
          endpointPort: deployment.hostPort,
        });
        if (!ready) throw new Error("missing runtime instance");
        return ready;
      },
    });
    await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody({ state: "ready", readyAt: new Date().toISOString() }),
    });

    const response = await activate(app, deployment.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workflow?: { selectedProtocol: number; enqueueCapability: string };
    };
    expect(body.workflow).toEqual({
      selectedProtocol: 1,
      enqueueCapability: "per_run_queue_v1",
    });

    // Exact activation is bound to the validated registration: a stale
    // process sharing the service token cannot activate under it.
    const staleInstance = await activate(app, deployment.id, "wfd_stale_generation");
    expect(staleInstance.status).toBe(409);
    expect(((await staleInstance.json()) as { error: string }).error).toContain(
      "does not match the validated dispatcher registration",
    );
  });

  test("an unattested or enqueue-incapable release is terminal workflow_migration_required, not a timeout", async () => {
    const store = createTestStore();
    const unattested = await createDeployableFixture(store);
    const unscoped = await createDeployableFixture(store, {
      ...sharedAttestation,
      enqueueCapability: "unscoped",
    });
    const outsideWindow = await createDeployableFixture(store, {
      ...sharedAttestation,
      dispatchProtocol: 99,
    });
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      worldClusterIdentity: WORLD_IDENTITY,
    });
    await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody({ state: "ready", readyAt: new Date().toISOString() }),
    });

    for (const deployment of [unattested, unscoped, outsideWindow]) {
      const response = await activate(app, deployment.id);
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("workflow_migration_required");
    }
  });

  test("a dispatcher claiming from a different Postgres cluster is refused activation", async () => {
    const store = createTestStore();
    const deployment = await createDeployableFixture(store, sharedAttestation);
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      worldClusterIdentity: WORLD_IDENTITY,
    });
    // Same database name, fresh heartbeat, healthy state — but another
    // cluster's fingerprint. URL-ish resemblance must count for nothing.
    const foreignIdentity = "cluster:9999999999999999999/eveland_workflow";
    await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody({
        state: "ready",
        readyAt: new Date().toISOString(),
        worldDatabaseIdentity: foreignIdentity,
      }),
    });

    const response = await activate(app, deployment.id);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("workflow_unavailable");
    expect(body.error).toContain(foreignIdentity);
    expect(body.error).toContain(WORLD_IDENTITY);
  });
});
