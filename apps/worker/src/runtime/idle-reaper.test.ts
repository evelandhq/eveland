import { createMemoryStore } from "@eveland/db";
import { describe, expect, test, vi } from "vitest";
import { reapIdleDeployments } from "./idle-reaper.js";
import type { RuntimeAdapter } from "./types.js";

describe("reapIdleDeployments", () => {
  test("stops a ready process only after its final lease idle deadline", async () => {
    const store = createMemoryStore();
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
});
