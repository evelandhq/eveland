import { describe, expect, test } from "vitest";
import { createBuildInfo } from "@evelandhq/core/build-info";
import { createScheduleDispatchCredential } from "@evelandhq/core/server/scheduler-dispatch";
import { unsupportedEveVersionMessage } from "@evelandhq/core/eve-compatibility";
import { createApp } from "./app.js";
import { createTestStore } from "@evelandhq/db/vitest";

import { createScheduleRunFixture } from "./app.test-support.js";

describe("api app", () => {
  test("creates, renews, and releases a service-authenticated runtime activation", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Wake API Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/wake-api-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:wake-api",
      containerName: "fixture-wake-api",
      internalPort: 3000,
      hostPort: 41991,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
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

    expect((await app.request("/internal/runtime/activations", { method: "POST" })).status).toBe(
      404,
    );
    const activation = await app.request("/internal/runtime/activations", {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deploymentId: deployment.id,
        kind: "public_request",
        ownerId: "req_api_wake",
      }),
    });
    expect(activation.status).toBe(200);
    const body = (await activation.json()) as {
      lease: { id: string };
      runtimeInstance: { status: string; endpointPort: number };
    };
    expect(body.runtimeInstance).toMatchObject({
      status: "ready",
      endpointPort: deployment.hostPort,
    });
    await expect(store.claimNextJob("wake-worker")).resolves.toMatchObject({
      type: "ensure_deployment_running",
      payload: { deploymentId: deployment.id, runtimeInstanceId: expect.any(String) },
    });

    const renew = await app.request(`/internal/runtime/activations/${body.lease.id}/renew`, {
      method: "POST",
      headers: { authorization: "Bearer gateway-service-token" },
    });
    expect(renew.status).toBe(200);
    const release = await app.request(`/internal/runtime/activations/${body.lease.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer gateway-service-token" },
    });
    expect(release.status).toBe(204);
    await expect(store.getActivationLease(body.lease.id)).resolves.toMatchObject({
      releasedAt: expect.any(String),
    });
  });

  test("answers a launch blocked by the Eve version gate with a terminal 409", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Stale Eve Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/stale-eve-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:stale-eve",
      containerName: "fixture-stale-eve",
      internalPort: 3000,
      hostPort: 41993,
      runtimeKind: "docker",
      workflowWorld: {
        worldKind: "shared",
        worldPackage: "@evelandhq/workflow-world",
        worldVersion: "0.10.0",
        storageSpec: 6,
        dispatchProtocol: 1,
        enqueueCapability: "per_run_queue_v1",
      },
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    // workflow_step activation now gates on machine-readable dispatcher
    // readiness before it ever reaches the Eve version gate.
    await store.recordWorkflowDispatcherHeartbeat({
      instanceId: "wfd_stale_eve_test",
      generation: "test",
      state: "ready",
      ownershipAcquired: true,
      bootRecoveryCompleted: true,
      reenqueuedRuns: 0,
      worldDatabaseIdentity: "localhost:5432/eveland_workflow",
      schemaGeneration: null,
      protocolMin: 1,
      protocolMax: 1,
      cutoverOperationId: null,
      unscopedRunnableJobs: 0,
      unresolvedQuarantines: 0,
      startedAt: new Date().toISOString(),
      readyAt: new Date().toISOString(),
    });
    let gatedLeaseId: string | null = null;
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      // The worker records the gate failure on the runtime instance and
      // waitForRuntimeActivation rethrows it as a bare message, which is exactly
      // what the waiter stands in for here.
      runtimeActivationWaiter: async (claim) => {
        gatedLeaseId = claim.lease.id;
        throw new Error(unsupportedEveVersionMessage("0.31.1"));
      },
    });

    const activation = await app.request("/internal/runtime/activations", {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deploymentId: deployment.id,
        kind: "workflow_step",
        ownerId: "workflow-dispatcher:msg_stale_eve",
      }),
    });

    expect(activation.status).toBe(409);
    await expect(activation.json()).resolves.toEqual({
      error: unsupportedEveVersionMessage("0.31.1"),
    });
    expect(gatedLeaseId).not.toBeNull();
    await expect(store.getActivationLease(gatedLeaseId!)).resolves.toMatchObject({
      releasedAt: expect.any(String),
    });
  });

  test("releases only the request lease when a cold activation is aborted", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Aborted Wake API Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/aborted-wake-api-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:aborted-wake-api",
      containerName: "fixture-aborted-wake-api",
      internalPort: 3000,
      hostPort: 41992,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    let waiterStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      waiterStarted = resolve;
    });
    let abortedLeaseId: string | null = null;
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      runtimeActivationWaiter: async (claim, input) => {
        abortedLeaseId = claim.lease.id;
        waiterStarted();
        return new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const controller = new AbortController();
    const pending = app.request("/internal/runtime/activations", {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deploymentId: deployment.id,
        kind: "public_request",
        ownerId: "req_api_aborted",
      }),
      signal: controller.signal,
    });
    await started;
    controller.abort();

    expect((await pending).status).toBe(499);
    expect(abortedLeaseId).not.toBeNull();
    await expect(store.getActivationLease(abortedLeaseId!)).resolves.toMatchObject({
      releasedAt: expect.any(String),
    });
  });

  test("redeems a schedule dispatch credential once and attaches running Sessions", async () => {
    const store = createTestStore();
    const { project, schedule, deployment, run } = await createScheduleRunFixture(store);
    await store.claimScheduleRunActivation(run.id);
    const dispatchSecret = "schedule-dispatch-secret-at-least-32-bytes";
    const runtimeSecret = "runtime-secret-at-least-32-bytes-long";
    const credential = createScheduleDispatchCredential(
      {
        scheduleRunId: run.id,
        deploymentId: deployment.id,
        scheduleKey: schedule.key,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      dispatchSecret,
    );
    const app = createApp(store, {
      schedulerDispatchSecret: dispatchSecret,
      schedulerRuntimeSecret: runtimeSecret,
    });

    const claim = () =>
      app.request("/internal/scheduler/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-eveland-runtime-secret": runtimeSecret },
        body: JSON.stringify({
          phase: "claim",
          credential,
          scheduleRunId: run.id,
          scheduleKey: schedule.key,
        }),
      });
    expect((await claim()).status).toBe(200);
    expect((await claim()).status).toBe(409);

    const complete = await app.request("/internal/scheduler/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eveland-runtime-secret": runtimeSecret },
      body: JSON.stringify({
        phase: "complete",
        credential,
        scheduleRunId: run.id,
        scheduleKey: schedule.key,
        sessionIds: ["eve_schedule_api"],
        status: "succeeded",
      }),
    });
    expect(complete.status).toBe(200);
    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({ status: "running" });
    await expect(store.listSessions(project.id)).resolves.toContainEqual(
      expect.objectContaining({
        eveSessionId: "eve_schedule_api",
        scheduleRunId: run.id,
      }),
    );
  });

  test("stores the handler-reported error when a dispatch completes failed", async () => {
    const store = createTestStore();
    const { schedule, deployment, run } = await createScheduleRunFixture(store);
    await store.claimScheduleRunActivation(run.id);
    await store.redeemScheduleRunDispatch(run.id, deployment.id);
    const dispatchSecret = "schedule-dispatch-secret-at-least-32-bytes";
    const runtimeSecret = "runtime-secret-at-least-32-bytes-long";
    const credential = createScheduleDispatchCredential(
      {
        scheduleRunId: run.id,
        deploymentId: deployment.id,
        scheduleKey: schedule.key,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      dispatchSecret,
    );
    const app = createApp(store, {
      schedulerDispatchSecret: dispatchSecret,
      schedulerRuntimeSecret: runtimeSecret,
    });

    const complete = await app.request("/internal/scheduler/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eveland-runtime-secret": runtimeSecret },
      body: JSON.stringify({
        phase: "complete",
        credential,
        scheduleRunId: run.id,
        scheduleKey: schedule.key,
        sessionIds: [],
        status: "failed",
        error: 'args.receive(): channel "eve" does not implement receive().',
      }),
    });

    expect(complete.status).toBe(200);
    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({
      status: "failed",
      error: 'args.receive(): channel "eve" does not implement receive().',
    });
  });

  test("keeps the generic error when a failed dispatch completes without one", async () => {
    const store = createTestStore();
    const { schedule, deployment, run } = await createScheduleRunFixture(store);
    await store.claimScheduleRunActivation(run.id);
    await store.redeemScheduleRunDispatch(run.id, deployment.id);
    const dispatchSecret = "schedule-dispatch-secret-at-least-32-bytes";
    const runtimeSecret = "runtime-secret-at-least-32-bytes-long";
    const credential = createScheduleDispatchCredential(
      {
        scheduleRunId: run.id,
        deploymentId: deployment.id,
        scheduleKey: schedule.key,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      dispatchSecret,
    );
    const app = createApp(store, {
      schedulerDispatchSecret: dispatchSecret,
      schedulerRuntimeSecret: runtimeSecret,
    });

    const complete = await app.request("/internal/scheduler/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eveland-runtime-secret": runtimeSecret },
      body: JSON.stringify({
        phase: "complete",
        credential,
        scheduleRunId: run.id,
        scheduleKey: schedule.key,
        sessionIds: [],
        status: "failed",
      }),
    });

    expect(complete.status).toBe(200);
    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({
      status: "failed",
      error: "Scheduled handler failed.",
    });
  });

  test("creates a manual ScheduleRun through the control-plane path", async () => {
    const store = createTestStore();
    const { project, schedule, deployment } = await createScheduleRunFixture(store, false);
    const response = await createApp(store).request(
      `/projects/${project.id}/schedules/${schedule.id}/runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      run: {
        scheduleId: schedule.id,
        deploymentId: deployment.id,
        trigger: "manual",
        status: "queued",
      },
    });
  });

  test("serves filtered paginated schedule runs, details, and linked Sessions", async () => {
    const store = createTestStore();
    const { project, schedule, deployment, run } = await createScheduleRunFixture(store);
    await store.completeScheduleRun(run.id, {
      status: "succeeded",
      eveSessionIds: ["eve_api_history"],
    });
    const app = createApp(store);

    const schedules = await app.request(`/projects/${project.id}/schedules`);
    await expect(schedules.json()).resolves.toMatchObject({
      schedules: [
        {
          schedule: { id: schedule.id, key: "billing/sweep" },
          version: { kind: "handler", cron: "0 3 * * *" },
          targetDeploymentId: deployment.id,
        },
      ],
    });
    const runs = await app.request(
      `/projects/${project.id}/schedule-runs?scheduleId=${schedule.id}&trigger=manual&status=running&limit=1`,
    );
    expect(runs.status).toBe(200);
    await expect(runs.json()).resolves.toMatchObject({
      runs: [{ id: run.id, sessionCount: 1 }],
      nextCursor: null,
    });
    const detail = await app.request(`/schedule-runs/${run.id}`);
    await expect(detail.json()).resolves.toMatchObject({
      run: {
        id: run.id,
        scheduleKey: "billing/sweep",
        deployment: { id: deployment.id },
        sessions: [{ scheduleRunId: run.id }],
      },
    });
    const sessions = await app.request(
      `/projects/${project.id}/sessions?trigger=manual&scheduleId=${schedule.id}&scheduleRunId=${run.id}&limit=10`,
    );
    await expect(sessions.json()).resolves.toMatchObject({
      sessions: [{ scheduleRunId: run.id }],
      nextCursor: null,
    });
    expect((await app.request(`/projects/${project.id}/schedule-runs?status=unknown`)).status).toBe(
      400,
    );
  });

  test("returns health status", async () => {
    const buildInfo = createBuildInfo("api", {
      revision: "6bb1d53f51ab",
      channel: "stable",
    });
    const app = createApp(createTestStore(), { buildInfo });
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ...buildInfo });
  });
});
