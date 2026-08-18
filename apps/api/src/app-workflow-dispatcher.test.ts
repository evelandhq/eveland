import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";

const serviceHeaders = {
  authorization: "Bearer gateway-service-token",
  "content-type": "application/json",
};

function heartbeatBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    instanceId: "wfd_api_test",
    generation: "eveland-workflow-dispatcher test",
    state: "ready_paused",
    ownershipAcquired: true,
    bootRecoveryCompleted: true,
    reenqueuedRuns: 2,
    worldDatabaseIdentity: "localhost:5432/eveland_workflow",
    schemaGeneration: "0013_run_quarantines.sql",
    protocolMin: 1,
    protocolMax: 1,
    cutoverOperationId: null,
    unscopedRunnableJobs: 0,
    unresolvedQuarantines: 0,
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
  worldVersion: "0.10.0",
  storageSpec: 6,
  dispatchProtocol: 1,
  enqueueCapability: "per_run_queue_v1" as const,
};

describe("workflow dispatcher registration API", () => {
  test("heartbeat requires service auth, persists the registration, and answers the desired state", async () => {
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
    // ready_paused never grants itself permission to claim.
    expect(await first.json()).toEqual({ desiredState: "paused" });

    const registration = await app.request("/internal/workflow/dispatcher/registration", {
      method: "GET",
      headers: serviceHeaders,
    });
    expect(registration.status).toBe(200);
    const registrationBody = (await registration.json()) as {
      registration: { state: string; worldDatabaseIdentity: string };
    };
    expect(registrationBody.registration).toMatchObject({
      state: "ready_paused",
      worldDatabaseIdentity: "localhost:5432/eveland_workflow",
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
  });

  test("the explicit resume flips the desired state exactly once from ready_paused", async () => {
    const store = createTestStore();
    const app = createApp(store, { gatewayServiceToken: "gateway-service-token" });
    await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody(),
    });

    const resume = await app.request("/internal/workflow/dispatcher/resume", {
      method: "POST",
      headers: serviceHeaders,
    });
    expect(resume.status).toBe(200);

    const next = await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody(),
    });
    expect(await next.json()).toEqual({ desiredState: "ready" });

    // Once the dispatcher reports ready, resume is a 409 — it is not a toggle.
    await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody({ state: "ready", readyAt: new Date().toISOString() }),
    });
    const again = await app.request("/internal/workflow/dispatcher/resume", {
      method: "POST",
      headers: serviceHeaders,
    });
    expect(again.status).toBe(409);
  });
});

describe("cutover process mode", () => {
  test("serves only the cutover surface and answers everything else with a managed 503", async () => {
    const store = createTestStore();
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      cutoverOperationId: "cut_api_test",
    });
    await store.ensureWorkflowCutoverOperation({
      id: "cut_api_test",
      kind: "cutover",
      scope: {},
    });

    // Ordinary control-plane surface is refused with a stable managed code.
    const projects = await app.request("/api/projects");
    expect(projects.status).toBe(503);
    expect(((await projects.json()) as { error: string }).error).toContain("workflow_unavailable");

    // The cutover surface stays up: health, heartbeat, and operation status.
    expect((await app.request("/health")).status).toBe(200);
    const heartbeat = await app.request("/internal/workflow/dispatcher/heartbeat", {
      method: "POST",
      headers: serviceHeaders,
      body: heartbeatBody(),
    });
    expect(heartbeat.status).toBe(200);
    const status = await app.request("/internal/workflow/cutover/status", {
      headers: serviceHeaders,
    });
    expect(status.status).toBe(200);
    expect(
      ((await status.json()) as { operation: { id: string; phase: string } }).operation,
    ).toMatchObject({ id: "cut_api_test", phase: "pending" });
  });
});

describe("workflow_step activation gating", () => {
  async function activate(app: ReturnType<typeof createApp>, deploymentId: string) {
    return app.request("/internal/runtime/activations", {
      method: "POST",
      headers: serviceHeaders,
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
    const app = createApp(store, { gatewayServiceToken: "gateway-service-token" });

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
    const app = createApp(store, { gatewayServiceToken: "gateway-service-token" });
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
});
