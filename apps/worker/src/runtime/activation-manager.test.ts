import { createMemoryStore } from "@eveland/db";
import { describe, expect, test, vi } from "vitest";
import { ensureDeploymentActive, reconcileRuntimeInstances } from "./activation-manager.js";
import type { ProcessStartInput, RuntimeAdapter } from "./types.js";

describe("ensureDeploymentActive", () => {
  test("elects one cold starter and returns one ready RuntimeInstance to concurrent leases", async () => {
    const store = createMemoryStore();
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
      observerOutboxDir: "/tmp/outbox",
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
  });

  test("releases every concurrent lease when the elected starter fails", async () => {
    const store = createMemoryStore();
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
      observerOutboxDir: "/tmp/outbox",
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

  test("reconciles a ready RuntimeInstance whose process disappeared", async () => {
    const store = createMemoryStore();
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
  });
});
