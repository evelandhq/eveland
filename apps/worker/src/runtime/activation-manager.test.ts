import { createTestStore } from "@eveland/db/vitest";
import { describe, expect, test, vi } from "vitest";
import { ensureDeploymentActive, reconcileRuntimeInstances } from "./activation-manager.js";
import type { ProcessStartInput, RuntimeAdapter } from "./types.js";

describe("ensureDeploymentActive", () => {
  test("waits for a draining RuntimeInstance to stop before starting its next generation", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Draining Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/draining-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:draining",
      containerName: "fixture-draining",
      internalPort: 3000,
      hostPort: 41995,
      runtimeKind: "docker",
    });
    const first = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_draining",
      expiresAt: new Date("2026-07-16T03:01:00.000Z"),
      now: new Date("2026-07-16T03:00:00.000Z"),
    });
    await store.updateRuntimeInstance(first.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
    });
    await store.releaseActivationLease(first.lease.id);
    await store.updateRuntimeInstance(first.runtimeInstance.id, { status: "draining" });

    const acquireActivationLease = store.acquireActivationLease.bind(store);
    let acquisitionAttempts = 0;
    const drainingStore = {
      ...store,
      async acquireActivationLease(input: Parameters<typeof store.acquireActivationLease>[0]) {
        acquisitionAttempts += 1;
        if (acquisitionAttempts === 1) {
          await store.updateRuntimeInstance(first.runtimeInstance.id, { status: "stopped" });
          throw new Error("RuntimeInstance is draining; retry activation after it stops.");
        }
        return acquireActivationLease(input);
      },
    };
    const ensureProcess = vi.fn(async () => ({ internalPort: 3000, log: "started" }));
    const runtime = {
      name: "docker",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      ensureProcess,
    } as unknown as RuntimeAdapter;

    const activation = await ensureDeploymentActive(drainingStore, {
      deployment,
      runtime,
      kind: "schedule_run",
      ownerId: "srun_after_drain",
      startInput: {
        processName: deployment.containerName,
        releaseRef: "fixture:draining",
        port: deployment.hostPort,
        env: {},
        commandContext: { isEveProject: true, hasLockfile: false, scripts: {} },
        sandboxCacheDir: "/tmp/cache",
        observabilityPolicyDir: "/tmp/observability",
      },
    }, {
      drainRetryMs: 1,
      waitForHealth: vi.fn(),
    });

    expect(acquisitionAttempts).toBe(2);
    expect(ensureProcess).toHaveBeenCalledTimes(1);
    expect(activation.runtimeInstance).toMatchObject({ status: "ready", generation: 2 });
  });

  test("elects one cold starter and returns one ready RuntimeInstance to concurrent leases", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Cold Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/cold-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:cold",
      containerName: "fixture-cold",
      internalPort: 3000,
      hostPort: 41996,
      runtimeKind: "docker",
    });
    const ensureProcess = vi.fn(async () => ({ internalPort: 3000, log: "started" }));
    const runtime = {
      name: "docker",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      ensureProcess,
    } as unknown as RuntimeAdapter;
    const startInput = {
      processName: deployment.containerName,
      releaseRef: "fixture:cold",
      port: deployment.hostPort,
      env: {},
      commandContext: { isEveProject: true, hasLockfile: false, scripts: {} },
      sandboxCacheDir: "/tmp/cache",
      observabilityPolicyDir: "/tmp/observability",
    } satisfies ProcessStartInput;

    const activations = await Promise.all([
      ensureDeploymentActive(store, {
        deployment,
        runtime,
        startInput,
        kind: "schedule_run",
        ownerId: "srun_cold",
      }, { waitForHealth: vi.fn() }),
      ensureDeploymentActive(store, {
        deployment,
        runtime,
        startInput,
        kind: "public_request",
        ownerId: "req_cold",
      }, { waitForHealth: vi.fn() }),
    ]);

    expect(ensureProcess).toHaveBeenCalledTimes(1);
    expect(new Set(activations.map((activation) => activation.runtimeInstance.id)).size).toBe(1);
    expect(activations[0]?.runtimeInstance).toMatchObject({ status: "ready", endpointPort: deployment.hostPort });
    expect(ensureProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          EVELAND_RUNTIME_INSTANCE_ID: activations[0]!.runtimeInstance.id,
        }),
      }),
    );
  });

  test("releases every concurrent lease when the elected starter fails", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Broken Cold Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/broken-cold-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:broken-cold",
      containerName: "fixture-broken-cold",
      internalPort: 3000,
      hostPort: 41997,
      runtimeKind: "docker",
    });
    let rejectStart!: (error: Error) => void;
    const startFailure = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    const runtime = {
      name: "docker",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      ensureProcess: vi.fn(() => startFailure),
    } as unknown as RuntimeAdapter;
    const startInput = {
      processName: deployment.containerName,
      releaseRef: "fixture:broken-cold",
      port: deployment.hostPort,
      env: {},
      commandContext: { isEveProject: true, hasLockfile: false, scripts: {} },
      sandboxCacheDir: "/tmp/cache",
      observabilityPolicyDir: "/tmp/observability",
    } satisfies ProcessStartInput;

    const first = ensureDeploymentActive(store, {
      deployment,
      runtime,
      startInput,
      kind: "schedule_run",
      ownerId: "srun_broken",
    }, { waitForHealth: vi.fn(), pollIntervalMs: 1 });
    const second = ensureDeploymentActive(store, {
      deployment,
      runtime,
      startInput,
      kind: "public_request",
      ownerId: "req_broken",
    }, { waitForHealth: vi.fn(), pollIntervalMs: 1 });
    rejectStart(new Error("runtime start failed"));

    await expect(first).rejects.toThrow("runtime start failed");
    await expect(second).rejects.toThrow("runtime start failed");
    await expect(store.hasActiveActivationLeases(deployment.id)).resolves.toBe(false);
  });

  test("fails activation loudly when the deployment's port is held by a foreign process", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Crossed Port Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/crossed-port-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:crossed-port",
      containerName: "fixture-crossed-port",
      internalPort: 3000,
      hostPort: 41996,
      runtimeKind: "systemd",
    });
    const runtime = {
      name: "systemd",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      ensureProcess: vi.fn(async () => ({ internalPort: 41996, log: "started" })),
      verifyPortOwnership: vi.fn(async () => ({
        status: "foreign" as const,
        holder: "pid 4242 (unit eveland-proj_other-dep_7.service)",
      })),
    } as unknown as RuntimeAdapter;
    const waitForHealth = vi.fn();

    await expect(
      ensureDeploymentActive(store, {
        deployment,
        runtime,
        startInput: {
          processName: deployment.containerName,
          releaseRef: "fixture:crossed-port",
          port: deployment.hostPort,
          env: {},
          commandContext: { isEveProject: true, hasLockfile: false, scripts: {} },
          sandboxCacheDir: "/tmp/cache",
          observabilityPolicyDir: "/tmp/observability",
        },
        kind: "public_request",
        ownerId: "req_crossed_port",
      }, { waitForHealth, pollIntervalMs: 1 }),
    ).rejects.toThrow(/eveland-proj_other-dep_7\.service/);

    // Readiness must never be proven by the foreign process's HTTP responses.
    expect(waitForHealth).not.toHaveBeenCalled();
    const [failed] = await store.listRuntimeInstances(["failed"], 10);
    expect(failed?.lastError).toMatch(/eveland-proj_other-dep_7\.service/);
    await expect(store.hasActiveActivationLeases(deployment.id)).resolves.toBe(false);
  });

  test("reconciles a ready RuntimeInstance whose port is held by a foreign process", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Crossed Ready Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/crossed-ready-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:crossed-ready",
      containerName: "fixture-crossed-ready",
      internalPort: 3000,
      hostPort: 41994,
      runtimeKind: "systemd",
    });
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_crossed_ready",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
    });
    await store.releaseActivationLease(claim.lease.id);
    const runtime = {
      name: "systemd",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      inspectProcess: vi.fn(async () => "ready" as const),
      verifyPortOwnership: vi.fn(async () => ({
        status: "foreign" as const,
        holder: "pid 4242 (unit eveland-proj_other-dep_7.service)",
      })),
    } as unknown as RuntimeAdapter;

    await expect(reconcileRuntimeInstances(store, {
      limit: 10,
      runtimeForKind: () => runtime,
    })).resolves.toBe(1);

    await expect(store.getRuntimeInstance(claim.runtimeInstance.id)).resolves.toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("eveland-proj_other-dep_7.service"),
    });
    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({ status: "failed" });
    expect(runtime.verifyPortOwnership).toHaveBeenCalledWith({
      processName: deployment.containerName,
      port: deployment.hostPort,
    });
  });

  test("reconciles a ready RuntimeInstance whose process disappeared", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Crashed Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/crashed-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:crashed",
      containerName: "fixture-crashed",
      internalPort: 3000,
      hostPort: 41998,
      runtimeKind: "docker",
    });
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_crashed",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
    });
    const observed = await store.ingestAgentEvent({
      telemetryEventId: "evt_crashed_runtime",
      eventFingerprint: "fingerprint_crashed_runtime",
      deploymentId: deployment.id,
      runtimeInstanceId: claim.runtimeInstance.id,
      eveSessionId: "eve_crashed_runtime",
      parentEveSessionId: null,
      sourceSequence: 1,
      agent: { id: null, name: "root", nodeId: "root" },
      channelKind: "http",
      eventAt: "2026-07-28T02:21:14.000Z",
      event: { type: "step.started", data: { stepIndex: 201 } },
    });
    const runtime = {
      name: "docker",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      inspectProcess: vi.fn(async () => "missing" as const),
    } as unknown as RuntimeAdapter;

    await expect(reconcileRuntimeInstances(store, {
      limit: 10,
      runtimeForKind: () => runtime,
    })).resolves.toBe(1);

    await expect(store.getRuntimeInstance(claim.runtimeInstance.id)).resolves.toMatchObject({ status: "stopped" });
    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({ status: "stopped" });
    await expect(store.getSession(observed.session.id)).resolves.toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
    });
    await expect(store.listSessionEvents(observed.session.id)).resolves.toContainEqual(
      expect.objectContaining({
        type: "platform.runtime_lost",
        payload: expect.objectContaining({
          runtimeInstanceId: claim.runtimeInstance.id,
        }),
      }),
    );
  });

  test("fails an active scheduled execution when its RuntimeInstance disappears", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Interrupted Schedule Agent",
      importKind: "zip",
    });
    await store.completeJob((await store.claimNextJob("fixture-import"))!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/interrupted-schedule-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const [recorded] = await store.recordScheduleVersions({
      projectId: project.id,
      sourceRevisionId: revision.id,
      definitions: [{
        key: "daily-topics",
        kind: "markdown",
        cron: "0 2 * * *",
        sourcePath: "agent/schedules/daily-topics.md",
        definitionHash: "interrupted-v1",
      }],
    });
    if (!recorded) throw new Error("Expected schedule fixture.");
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:interrupted-schedule",
      containerName: "fixture-interrupted-schedule",
      internalPort: 3000,
      hostPort: 41999,
      runtimeKind: "docker",
    });
    await store.setProjectSchedulerTarget(project.id, deployment.id);
    const run = await store.createManualScheduleRun(
      project.id,
      recorded.schedule.id,
      new Date("2026-07-28T02:21:14.000Z"),
    );
    await store.claimScheduleRunActivation(run.id);
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "schedule_run",
      ownerId: run.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
    });
    await store.redeemScheduleRunDispatch(run.id, deployment.id);
    await store.completeScheduleRun(run.id, {
      status: "succeeded",
      eveSessionIds: ["eve_interrupted_schedule"],
    });
    const runtime = {
      name: "docker",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      inspectProcess: vi.fn(async () => "missing" as const),
    } as unknown as RuntimeAdapter;

    await expect(reconcileRuntimeInstances(store, {
      limit: 10,
      runtimeForKind: () => runtime,
    })).resolves.toBe(1);

    const [session] = await store.listSessions(project.id);
    expect(session).toMatchObject({
      eveSessionId: "eve_interrupted_schedule",
      status: "failed",
      completedAt: expect.any(String),
    });
    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining(claim.runtimeInstance.id),
      completedAt: expect.any(String),
    });
    await expect(store.listSessionEvents(session!.id)).resolves.toContainEqual(
      expect.objectContaining({
        type: "platform.runtime_lost",
        payload: expect.objectContaining({
          runtimeInstanceId: claim.runtimeInstance.id,
        }),
      }),
    );
    await expect(store.hasActiveActivationLeases(deployment.id)).resolves.toBe(false);
  });

  test("recovers a zombie scheduled execution whose RuntimeInstance was already stopped", async () => {
    const store = createTestStore();
    const fixture = await createRunningScheduleExecution(
      store,
      "Previously Stopped Schedule Agent",
      42000,
    );
    await store.updateRuntimeInstance(
      fixture.runtimeInstanceId,
      { status: "stopped" },
      new Date("2026-07-28T02:26:24.000Z"),
    );
    const runtime = {
      name: "docker",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      inspectProcess: vi.fn(async () => "missing" as const),
    } as unknown as RuntimeAdapter;

    await expect(reconcileRuntimeInstances(store, {
      now: new Date("2026-07-28T02:36:24.000Z"),
      limit: 10,
      runtimeForKind: () => runtime,
    })).resolves.toBe(1);

    await expect(store.getScheduleRun(fixture.scheduleRunId)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining(fixture.runtimeInstanceId),
    });
    await expect(store.getSession(fixture.sessionId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(runtime.inspectProcess).not.toHaveBeenCalled();
  });

  test("fails a scheduled execution after its hard runtime deadline", async () => {
    const store = createTestStore();
    const fixture = await createRunningScheduleExecution(
      store,
      "Expired Schedule Agent",
      42001,
    );
    await store.releaseActivationLease(
      fixture.activationLeaseId,
      new Date("2026-07-28T02:22:14.000Z"),
    );
    const runtime = {
      name: "docker",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      inspectProcess: vi.fn(async () => "ready" as const),
    } as unknown as RuntimeAdapter;

    await expect(reconcileRuntimeInstances(store, {
      now: new Date("2026-07-29T02:21:14.001Z"),
      limit: 10,
      runtimeForKind: () => runtime,
    })).resolves.toBe(1);

    await expect(store.getScheduleRun(fixture.scheduleRunId)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("maximum runtime"),
    });
    await expect(store.getSession(fixture.sessionId)).resolves.toMatchObject({
      status: "failed",
    });
  });
});

async function createRunningScheduleExecution(
  store: ReturnType<typeof createTestStore>,
  name: string,
  hostPort: number,
) {
  const project = await store.createProject({ name, importKind: "zip" });
  await store.completeJob((await store.claimNextJob("fixture-import"))!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: `/tmp/${name.toLowerCase().replaceAll(" ", "-")}`,
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const [recorded] = await store.recordScheduleVersions({
    projectId: project.id,
    sourceRevisionId: revision.id,
    definitions: [{
      key: "daily-topics",
      kind: "markdown",
      cron: "0 2 * * *",
      sourcePath: "agent/schedules/daily-topics.md",
      definitionHash: `${name}-v1`,
    }],
  });
  if (!recorded) throw new Error("Expected schedule fixture.");
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: `fixture:${name}`,
    containerName: `fixture-${hostPort}`,
    internalPort: 3000,
    hostPort,
    runtimeKind: "docker",
  });
  await store.setProjectSchedulerTarget(project.id, deployment.id);
  const run = await store.createManualScheduleRun(
    project.id,
    recorded.schedule.id,
    new Date("2026-07-28T02:21:14.000Z"),
  );
  await store.claimScheduleRunActivation(run.id);
  const claim = await store.acquireActivationLease({
    deploymentId: deployment.id,
    kind: "schedule_run",
    ownerId: run.id,
    expiresAt: new Date("2026-07-29T02:21:14.000Z"),
    now: new Date("2026-07-28T02:21:14.000Z"),
  });
  await store.updateRuntimeInstance(claim.runtimeInstance.id, {
    status: "ready",
    endpointHost: "127.0.0.1",
    endpointPort: deployment.hostPort,
  });
  await store.redeemScheduleRunDispatch(run.id, deployment.id);
  await store.completeScheduleRun(run.id, {
    status: "succeeded",
    eveSessionIds: [`eve_${hostPort}`],
  });
  const session = await store.getSessionByEveSessionId(
    project.id,
    `eve_${hostPort}`,
  );
  if (!session) throw new Error("Expected scheduled Session fixture.");
  return {
    deploymentId: deployment.id,
    runtimeInstanceId: claim.runtimeInstance.id,
    activationLeaseId: claim.lease.id,
    scheduleRunId: run.id,
    sessionId: session.id,
  };
}
