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
        worldVersion: "0.11.0",
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
      worldDatabaseIdentity: "cluster:7234567890123456789/eveland_workflow",
      schemaGeneration: null,
      protocolMin: 1,
      protocolMax: 1,
      startedAt: new Date().toISOString(),
      readyAt: new Date().toISOString(),
    });
    let gatedLeaseId: string | null = null;
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      worldClusterIdentity: "cluster:7234567890123456789/eveland_workflow",
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
        "x-eveland-dispatcher-instance": "wfd_stale_eve_test",
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

  test("refuses activation at request time when the Release pins an unsupported Eve version", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Retired Release Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/retired-release-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:retired-release",
      containerName: "fixture-retired-release",
      internalPort: 3000,
      hostPort: 41994,
      runtimeKind: "docker",
      // The build recorded the Eve version actually installed into this
      // Release; the supported window has since slid past it.
      summary: { eveVersionResolved: "0.31.1" },
      workflowWorld: {
        worldKind: "shared",
        worldPackage: "@evelandhq/workflow-world",
        worldVersion: "0.11.0",
        storageSpec: 6,
        dispatchProtocol: 1,
        enqueueCapability: "per_run_queue_v1",
      },
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      runtimeActivationWaiter: async () => {
        throw new Error("activation must be refused before any start attempt");
      },
    });

    // The dispatcher's request is refused terminally even with no dispatcher
    // heartbeat recorded: a Release that can never start must dead-letter, not
    // ride the 503 retry path -- and a gateway wake fails the same way.
    for (const [kind, ownerId] of [
      ["workflow_step", "workflow-dispatcher:msg_retired_release"],
      ["public_request", "req_retired_release"],
    ] as const) {
      const activation = await app.request("/internal/runtime/activations", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ deploymentId: deployment.id, kind, ownerId }),
      });
      expect(activation.status).toBe(409);
      await expect(activation.json()).resolves.toEqual({
        error: unsupportedEveVersionMessage("0.31.1"),
      });
    }
    // No lease, RuntimeInstance generation, or worker job was created: the
    // refusal costs the serialized activation lane nothing.
    await expect(store.claimNextJob("wake-worker")).resolves.toBeNull();
  });

  test("refuses workflow_step activation for a Release outside the storage window", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Stale Storage API Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/stale-storage-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    // Protocol 1 and per_run_queue_v1, but an event log written under a
    // storage generation this platform cannot read: independent axes.
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:stale-storage",
      containerName: "fixture-stale-storage",
      internalPort: 3000,
      hostPort: 41989,
      runtimeKind: "docker",
      workflowWorld: {
        worldKind: "shared",
        worldPackage: "@evelandhq/workflow-world",
        worldVersion: "0.4.0",
        storageSpec: 4,
        dispatchProtocol: 1,
        enqueueCapability: "per_run_queue_v1",
      },
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    await store.recordWorkflowDispatcherHeartbeat({
      instanceId: "wfd_stale_storage_test",
      generation: "test",
      state: "ready",
      ownershipAcquired: true,
      bootRecoveryCompleted: true,
      reenqueuedRuns: 0,
      worldDatabaseIdentity: "cluster:7234567890123456789/eveland_workflow",
      schemaGeneration: null,
      protocolMin: 1,
      protocolMax: 1,
      startedAt: new Date().toISOString(),
      readyAt: new Date().toISOString(),
    });
    const app = createApp(store, {
      gatewayServiceToken: "gateway-service-token",
      worldClusterIdentity: "cluster:7234567890123456789/eveland_workflow",
    });

    const activation = await app.request("/internal/runtime/activations", {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-service-token",
        "content-type": "application/json",
        "x-eveland-dispatcher-instance": "wfd_stale_storage_test",
      },
      body: JSON.stringify({
        deploymentId: deployment.id,
        kind: "workflow_step",
        ownerId: "workflow-dispatcher:msg_stale_storage",
      }),
    });

    expect(activation.status).toBe(409);
    const body = (await activation.json()) as { error: string };
    expect(body.error).toMatch(/^workflow_migration_required: /);
    expect(body.error).toContain("storage spec 4");
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

  test("records an ambiguous dispatch as dispatch_unknown, not failed", async () => {
    // The Scheduler Channel reports dispatch_unknown when session creation
    // timed out after the durable workflow may have committed (#407): the
    // scheduled Session can still run, so the run must not read as failed.
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
        status: "dispatch_unknown",
      }),
    });

    expect(complete.status).toBe(200);
    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({
      status: "dispatch_unknown",
      error: "The dispatch outcome is unknown; the scheduled Session may still run.",
    });
  });

  test("creates a manual ScheduleRun through the control-plane path", async () => {
    const store = createTestStore();
    const { project, schedule, deployment } = await createScheduleRunFixture(store, false);
    const response = await createApp(store).request(
      `/api/projects/${project.id}/schedules/${schedule.id}/runs`,
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

    const schedules = await app.request(`/api/projects/${project.id}/schedules`);
    await expect(schedules.json()).resolves.toMatchObject({
      schedules: [
        {
          schedule: { id: schedule.id, key: "billing/sweep" },
          version: { kind: "handler", cron: "0 3 * * *" },
          targetDeploymentId: deployment.id,
          latestRunStatus: "running",
        },
      ],
    });
    const runs = await app.request(
      `/api/projects/${project.id}/schedule-runs?scheduleId=${schedule.id}&trigger=manual&status=running&limit=1`,
    );
    expect(runs.status).toBe(200);
    await expect(runs.json()).resolves.toMatchObject({
      runs: [{ id: run.id, sessionCount: 1 }],
      nextCursor: null,
    });
    const detail = await app.request(`/api/schedule-runs/${run.id}`);
    await expect(detail.json()).resolves.toMatchObject({
      run: {
        id: run.id,
        scheduleKey: "billing/sweep",
        deployment: { id: deployment.id },
        sessions: [{ scheduleRunId: run.id }],
      },
    });
    const sessions = await app.request(
      `/api/projects/${project.id}/sessions?trigger=manual&scheduleId=${schedule.id}&scheduleRunId=${run.id}&limit=10`,
    );
    await expect(sessions.json()).resolves.toMatchObject({
      sessions: [{ scheduleRunId: run.id }],
      nextCursor: null,
    });
    expect(
      (await app.request(`/api/projects/${project.id}/schedule-runs?status=unknown`)).status,
    ).toBe(400);
  });

  test("acknowledges failed schedule runs and reports per-project attention", async () => {
    const store = createTestStore();
    const { project, run } = await createScheduleRunFixture(store);
    await store.completeScheduleRun(run.id, {
      status: "failed",
      error: "Scheduled handler failed.",
    });
    const app = createApp(store);

    const before = await app.request(`/api/projects/${project.id}/schedule-attention`);
    await expect(before.json()).resolves.toEqual({ unacknowledgedFailedRuns: 1 });
    const projectList = await app.request("/api/projects");
    await expect(projectList.json()).resolves.toMatchObject({
      projects: [{ id: project.id, unacknowledgedFailedRuns: 1 }],
    });

    const acknowledge = await app.request(`/api/projects/${project.id}/schedule-runs/acknowledge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runIds: [run.id] }),
    });
    expect(acknowledge.status).toBe(200);
    await expect(acknowledge.json()).resolves.toEqual({ acknowledged: 1 });

    const after = await app.request(`/api/projects/${project.id}/schedule-attention`);
    await expect(after.json()).resolves.toEqual({ unacknowledgedFailedRuns: 0 });
    // Replays and empty-body project-wide sweeps are safe no-ops.
    const sweep = await app.request(`/api/projects/${project.id}/schedule-runs/acknowledge`, {
      method: "POST",
    });
    await expect(sweep.json()).resolves.toEqual({ acknowledged: 0 });
    expect(
      (await app.request("/api/projects/missing/schedule-runs/acknowledge", { method: "POST" }))
        .status,
    ).toBe(404);
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
