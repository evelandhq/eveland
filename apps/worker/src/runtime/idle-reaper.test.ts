import { createTestStore } from "@eveland/db/vitest";
import { describe, expect, test, vi } from "vitest";
import { reapIdleDeployments } from "./idle-reaper.js";
import type { RuntimeAdapter } from "./types.js";

describe("reapIdleDeployments", () => {
  test("keeps a scheduler target warm when its next run is inside the prewarm window", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Warm Scheduler Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/warm-scheduler-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordScheduleVersions({
      projectId: project.id,
      sourceRevisionId: revision.id,
      definitions: [{
        key: "heartbeat",
        kind: "handler",
        cron: "* * * * *",
        sourcePath: "agent/schedules/heartbeat.ts",
        definitionHash: "heartbeat-v1",
      }],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:warm-scheduler",
      containerName: "fixture-warm-scheduler",
      internalPort: 3000,
      hostPort: 41988,
      runtimeKind: "docker",
    });
    await store.setProjectSchedulerTarget(project.id, deployment.id, new Date("2026-07-16T03:00:00.000Z"));
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_warm_scheduler",
      expiresAt: new Date("2026-07-16T02:51:00.000Z"),
      now: new Date("2026-07-16T02:50:00.000Z"),
    });
    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
    }, new Date("2026-07-16T02:50:00.000Z"));
    await store.releaseActivationLease(claim.lease.id, new Date("2026-07-16T02:51:00.000Z"));
    const stopProcess = vi.fn(async () => {});
    const runtime = {
      name: "docker",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess,
    } as unknown as RuntimeAdapter;

    await expect(reapIdleDeployments(store, {
      now: new Date("2026-07-16T03:00:10.000Z"),
      idleTtlMs: 0,
      schedulePrewarmMs: 60_000,
      limit: 10,
      runtimeForKind: () => runtime,
    })).resolves.toBe(0);

    expect(stopProcess).not.toHaveBeenCalled();
    await expect(store.getRuntimeInstance(claim.runtimeInstance.id)).resolves.toMatchObject({ status: "ready" });
  });

  test("stops a ready process only after its final lease idle deadline", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Idle Reaper Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/idle-reaper-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:idle-reaper",
      containerName: "fixture-idle-reaper",
      internalPort: 3000,
      hostPort: 41989,
      runtimeKind: "docker",
    });
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_idle_reaper",
      expiresAt: new Date("2026-07-15T03:01:00.000Z"),
      now: new Date("2026-07-15T03:00:00.000Z"),
    });
    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
    }, new Date("2026-07-15T03:00:00.000Z"));
    await store.releaseActivationLease(claim.lease.id, new Date("2026-07-15T03:01:00.000Z"));
    const stopProcess = vi.fn(async () => {});
    const runtime = {
      name: "docker",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess,
    } as unknown as RuntimeAdapter;

    await expect(reapIdleDeployments(store, {
      now: new Date("2026-07-15T03:01:59.999Z"),
      idleTtlMs: 60_000,
      limit: 10,
      runtimeForKind: () => runtime,
    })).resolves.toBe(0);
    await expect(reapIdleDeployments(store, {
      now: new Date("2026-07-15T03:02:00.000Z"),
      idleTtlMs: 60_000,
      limit: 10,
      runtimeForKind: () => runtime,
    })).resolves.toBe(1);

    expect(stopProcess).toHaveBeenCalledWith(deployment.containerName);
    await expect(store.getRuntimeInstance(claim.runtimeInstance.id)).resolves.toMatchObject({ status: "stopped" });
    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({ status: "stopped" });
  });

  test("does not stop a process a restart took over after the idle claim", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Restarted Idle Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/restarted-idle-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:restarted-idle",
      containerName: "fixture-restarted-idle",
      internalPort: 3000,
      hostPort: 41987,
      runtimeKind: "docker",
    });
    const claim = await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_restarted_idle",
      expiresAt: new Date("2026-07-15T03:01:00.000Z"),
      now: new Date("2026-07-15T03:00:00.000Z"),
    });
    await store.updateRuntimeInstance(claim.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: deployment.hostPort,
    }, new Date("2026-07-15T03:00:00.000Z"));
    await store.releaseActivationLease(claim.lease.id, new Date("2026-07-15T03:01:00.000Z"));
    const stopProcess = vi.fn(async () => {});
    const runtime = {
      name: "docker",
      buildRelease: vi.fn(),
      startProcess: vi.fn(),
      stopProcess,
    } as unknown as RuntimeAdapter;
    const readRuntimeInstance = store.getRuntimeInstance.bind(store);
    // A restart_deployment job retires the instance this claim just drained and
    // starts a fresh process on the same port before the reaper reaches its stop.
    vi.spyOn(store, "getRuntimeInstance").mockImplementation(async (runtimeInstanceId) => {
      await store.updateRuntimeInstance(runtimeInstanceId, {
        status: "stopped",
        endpointHost: null,
        endpointPort: null,
      });
      return readRuntimeInstance(runtimeInstanceId);
    });

    await expect(reapIdleDeployments(store, {
      now: new Date("2026-07-15T03:02:00.000Z"),
      idleTtlMs: 60_000,
      limit: 10,
      runtimeForKind: () => runtime,
    })).resolves.toBe(0);

    expect(stopProcess).not.toHaveBeenCalled();
    await expect(readRuntimeInstance(claim.runtimeInstance.id)).resolves.toMatchObject({ status: "stopped" });
    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({ status: "running" });
  });
});
