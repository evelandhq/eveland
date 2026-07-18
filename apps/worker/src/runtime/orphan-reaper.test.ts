import { createTestStore } from "@eveland/db/vitest";
import { describe, expect, test, vi } from "vitest";
import { reapIdleDeployments } from "./idle-reaper.js";
import { createOrphanProcessReaper } from "./orphan-reaper.js";
import type { RuntimeAdapter } from "./types.js";

function fakeAdapter(name: "docker" | "systemd", processNames: string[]) {
  const stopProcess = vi.fn(async () => {});
  const adapter = {
    name,
    buildRelease: vi.fn(),
    startProcess: vi.fn(),
    stopProcess,
    listProcesses: vi.fn(async () => processNames),
  } as unknown as RuntimeAdapter;
  return { adapter, stopProcess };
}

async function deploymentFixture(
  store: ReturnType<typeof createTestStore>,
  name: string,
  hostPort: number,
  containerName: string,
) {
  const project = await store.createProject({ name, importKind: "zip" });
  const importJob = await store.claimNextJob("fixture-import");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: `/tmp/${name.toLowerCase().replaceAll(" ", "-")}`,
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: `fixture:${project.slug}`,
    containerName,
    internalPort: 3000,
    hostPort,
    runtimeKind: "docker",
  });
  return { project, deployment };
}

describe("createOrphanProcessReaper", () => {
  test("never touches platform processes that do not match the deployment name shape", async () => {
    const store = createTestStore();
    const { adapter, stopProcess } = fakeAdapter("docker", ["eveland-postgres-1", "eveland-api-1", "eveland-gateway-1"]);
    const reap = createOrphanProcessReaper(store, {
      kinds: ["docker"],
      graceMs: 60_000,
      runtimeForKind: () => adapter,
    });

    await reap(new Date("2026-07-16T10:00:00.000Z"));
    await reap(new Date("2026-07-16T12:00:00.000Z"));

    expect(stopProcess).not.toHaveBeenCalled();
  });

  test("stops a process with no Deployment row only after the grace period", async () => {
    const store = createTestStore();
    const { adapter, stopProcess } = fakeAdapter("docker", ["eveland-proj_gone-dep_gone123"]);
    const reap = createOrphanProcessReaper(store, {
      kinds: ["docker"],
      graceMs: 300_000,
      runtimeForKind: () => adapter,
    });

    await reap(new Date("2026-07-16T10:00:00.000Z"));
    expect(stopProcess).not.toHaveBeenCalled();
    await reap(new Date("2026-07-16T10:04:59.000Z"));
    expect(stopProcess).not.toHaveBeenCalled();
    await reap(new Date("2026-07-16T10:05:00.000Z"));
    expect(stopProcess).toHaveBeenCalledExactlyOnceWith("eveland-proj_gone-dep_gone123");
  });

  test("adopts an unmanaged known deployment so the idle reaper stops it later", async () => {
    const store = createTestStore();
    const containerName = "eveland-proj_zombie-dep_zombie99";
    const { deployment } = await deploymentFixture(store, "Zombie Sweep Agent", 41981, containerName);
    const { adapter, stopProcess } = fakeAdapter("docker", [containerName]);
    const reap = createOrphanProcessReaper(store, {
      kinds: ["docker"],
      graceMs: 300_000,
      runtimeForKind: () => adapter,
    });

    await reap(new Date("2026-07-16T10:00:00.000Z"));

    expect(stopProcess).not.toHaveBeenCalled();
    await expect(store.listDeploymentRuntimeInstances(deployment.id)).resolves.toEqual([
      expect.objectContaining({ status: "ready", endpointHost: "127.0.0.1", endpointPort: deployment.hostPort }),
    ]);

    // Repeat sweeps never duplicate the adoption.
    await reap(new Date("2026-07-16T10:01:00.000Z"));
    await expect(store.listDeploymentRuntimeInstances(deployment.id)).resolves.toHaveLength(1);

    // The normal idle lifecycle now owns the process: no leases arrive, so the
    // idle reaper drains and stops it after the idle TTL.
    await expect(reapIdleDeployments(store, {
      now: new Date("2026-07-16T10:05:00.000Z"),
      idleTtlMs: 300_000,
      limit: 10,
      runtimeForKind: () => adapter,
    })).resolves.toBe(1);
    expect(stopProcess).toHaveBeenCalledExactlyOnceWith(containerName);
    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({ status: "stopped" });
  });

  test("skips deployments already under activation management", async () => {
    const store = createTestStore();
    const containerName = "eveland-proj_active-dep_active77";
    const { deployment } = await deploymentFixture(store, "Active Sweep Agent", 41982, containerName);
    await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_sweep_active",
      expiresAt: new Date("2026-07-16T10:10:00.000Z"),
      now: new Date("2026-07-16T10:00:00.000Z"),
    });
    const { adapter, stopProcess } = fakeAdapter("docker", [containerName]);
    const reap = createOrphanProcessReaper(store, {
      kinds: ["docker"],
      graceMs: 0,
      runtimeForKind: () => adapter,
    });

    await reap(new Date("2026-07-16T10:00:30.000Z"));

    expect(stopProcess).not.toHaveBeenCalled();
    await expect(store.listDeploymentRuntimeInstances(deployment.id)).resolves.toHaveLength(1);
  });

  test("stops an archived deployment's leftover process after the grace period", async () => {
    const store = createTestStore();
    const containerName = "eveland-proj_arch-dep_arch55";
    const { project, deployment } = await deploymentFixture(store, "Archived Sweep Agent", 41983, containerName);
    await store.updateDeploymentStatus(deployment.id, "archived");
    const { adapter, stopProcess } = fakeAdapter("docker", [containerName]);
    const reap = createOrphanProcessReaper(store, {
      kinds: ["docker"],
      graceMs: 60_000,
      runtimeForKind: () => adapter,
    });

    await reap(new Date("2026-07-16T10:00:00.000Z"));
    expect(stopProcess).not.toHaveBeenCalled();
    await reap(new Date("2026-07-16T10:01:00.000Z"));

    expect(stopProcess).toHaveBeenCalledExactlyOnceWith(containerName);
    const logs = await store.listLogs(project.id);
    expect(logs.some((log) => log.line.includes(containerName))).toBe(true);
  });

  test("stops a process found under a runtime kind the deployment does not own", async () => {
    const store = createTestStore();
    const containerName = "eveland-proj_kind-dep_kind33";
    // Fixture records runtimeKind "docker"; the same name showing up under
    // systemd is by definition a leftover from a runtime migration.
    await deploymentFixture(store, "Kind Sweep Agent", 41984, containerName);
    const { adapter, stopProcess } = fakeAdapter("systemd", [containerName]);
    const reap = createOrphanProcessReaper(store, {
      kinds: ["systemd"],
      graceMs: 60_000,
      runtimeForKind: () => adapter,
    });

    await reap(new Date("2026-07-16T10:00:00.000Z"));
    await reap(new Date("2026-07-16T10:01:00.000Z"));

    expect(stopProcess).toHaveBeenCalledExactlyOnceWith(containerName);
  });

  test("a runtime whose listing fails is skipped without failing the sweep", async () => {
    const store = createTestStore();
    const broken = {
      name: "systemd",
      listProcesses: vi.fn(async () => {
        throw new Error("systemctl is not available");
      }),
      stopProcess: vi.fn(),
    } as unknown as RuntimeAdapter;
    const { adapter, stopProcess } = fakeAdapter("docker", ["eveland-proj_gone-dep_gone321"]);
    const reap = createOrphanProcessReaper(store, {
      kinds: ["systemd", "docker"],
      graceMs: 0,
      runtimeForKind: (kind) => (kind === "systemd" ? broken : adapter),
    });

    await expect(reap(new Date("2026-07-16T10:00:00.000Z"))).resolves.toBeGreaterThanOrEqual(0);
    await reap(new Date("2026-07-16T10:00:01.000Z"));

    expect(stopProcess).toHaveBeenCalledWith("eveland-proj_gone-dep_gone321");
  });
});
