import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test, vi } from "vitest";
import type { ActiveWorkflowRunDeployment } from "./eveland-workflow-world-runs.js";
import { reconcileAbandonedWorkflowRuns } from "./workflow-run-reconciler.js";

async function fixtureProject(store: ReturnType<typeof createTestStore>, name: string) {
  const project = await store.createProject({ name, importKind: "zip" });
  const importJob = await store.claimNextJob(`${name}-fixture`);
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: `/tmp/${name}`,
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  return { project, revision };
}

describe("reconcileAbandonedWorkflowRuns", () => {
  test("settles runs only on Deployments that can never activate again", async () => {
    const store = createTestStore();
    const { project, revision } = await fixtureProject(store, "run-reconciler");

    const healthy = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "run-reconciler:healthy",
      containerName: "run-reconciler-healthy",
      internalPort: 3000,
      hostPort: 41960,
      runtimeKind: "systemd",
      summary: { eveVersionResolved: "0.49.0" },
    });
    // Stopped by the idle reaper — the acceptance case that must NOT settle:
    // a sleeping timer or a session inbox hook on this Deployment is live
    // durable state, and the next activation resumes it.
    await store.updateDeploymentStatus(healthy.id, "stopped");

    const crashed = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "run-reconciler:crashed",
      containerName: "run-reconciler-crashed",
      internalPort: 3000,
      hostPort: 41961,
      runtimeKind: "systemd",
      summary: { eveVersionResolved: "0.49.0" },
    });
    await store.updateDeploymentStatus(crashed.id, "failed");

    const archived = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "run-reconciler:archived",
      containerName: "run-reconciler-archived",
      internalPort: 3000,
      hostPort: 41962,
      runtimeKind: "systemd",
      summary: { eveVersionResolved: "0.49.0" },
    });
    await store.updateDeploymentStatus(archived.id, "archived");

    const staleEve = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "run-reconciler:stale-eve",
      containerName: "run-reconciler-stale-eve",
      internalPort: 3000,
      hostPort: 41963,
      runtimeKind: "systemd",
      summary: { eveVersionResolved: "0.31.1" },
    });
    await store.updateDeploymentStatus(staleEve.id, "stopped");

    const candidates: ActiveWorkflowRunDeployment[] = [
      { projectId: project.id, deploymentId: healthy.id },
      { projectId: project.id, deploymentId: crashed.id },
      { projectId: project.id, deploymentId: archived.id },
      { projectId: project.id, deploymentId: staleEve.id },
      { projectId: project.id, deploymentId: "dep_gone" },
    ];
    const reconcile = vi.fn(
      async (
        _pool: unknown,
        options: {
          tenantId: string;
          deploymentIds?: string[];
          disposition: string;
          errorCode?: string;
          reason: string;
        },
      ) => ({
        disposition: "fail" as const,
        reconciled: [
          {
            runId: `wrun_${options.deploymentIds![0]!}`,
            workflowName: "wf",
            deploymentId: options.deploymentIds![0]!,
            previousStatus: "running" as const,
          },
        ],
      }),
    );

    const result = await reconcileAbandonedWorkflowRuns(store, {
      evelandWorkflowWorldUrl: "postgres://world.test/db",
      listActiveDeployments: async () => candidates,
      reconcile: reconcile as never,
    });

    expect(result).toEqual({ examinedDeployments: 5, settledRuns: 3, failures: 0 });
    const settled = reconcile.mock.calls.map((call) => call[1].deploymentIds![0]);
    expect(settled.sort()).toEqual([archived.id, staleEve.id, "dep_gone"].sort());
    for (const call of reconcile.mock.calls) {
      expect(call[1]).toMatchObject({
        tenantId: project.id,
        disposition: "fail",
        errorCode: "DEPLOYMENT_UNSTARTABLE",
      });
      expect(call[1].reason).toMatch(/^Reconciled by the platform: /);
    }
  });

  test("a cross-tenant candidate row is never judged through another project's Deployment", async () => {
    const store = createTestStore();
    const { project, revision } = await fixtureProject(store, "run-reconciler-tenant");
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "run-reconciler-tenant:archived",
      containerName: "run-reconciler-tenant-archived",
      internalPort: 3000,
      hostPort: 41964,
      runtimeKind: "systemd",
      summary: { eveVersionResolved: "0.49.0" },
    });
    await store.updateDeploymentStatus(deployment.id, "archived");

    const reconcile = vi.fn(async () => ({ disposition: "fail" as const, reconciled: [] }));
    const result = await reconcileAbandonedWorkflowRuns(store, {
      evelandWorkflowWorldUrl: "postgres://world.test/db",
      listActiveDeployments: async () => [{ projectId: "proj_other", deploymentId: deployment.id }],
      reconcile: reconcile as never,
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(result.settledRuns).toBe(0);
  });

  test("uncertainty skips the Deployment instead of settling on it", async () => {
    const store = createTestStore();
    const { project, revision } = await fixtureProject(store, "run-reconciler-error");
    const archived = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "run-reconciler-error:archived",
      containerName: "run-reconciler-error-archived",
      internalPort: 3000,
      hostPort: 41965,
      runtimeKind: "systemd",
      summary: { eveVersionResolved: "0.49.0" },
    });
    await store.updateDeploymentStatus(archived.id, "archived");

    const failingStore = {
      ...store,
      getDeployment: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    };
    const reconcile = vi.fn(async () => ({ disposition: "fail" as const, reconciled: [] }));
    const result = await reconcileAbandonedWorkflowRuns(failingStore as never, {
      evelandWorkflowWorldUrl: "postgres://world.test/db",
      listActiveDeployments: async () => [{ projectId: project.id, deploymentId: archived.id }],
      reconcile: reconcile as never,
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(result).toEqual({ examinedDeployments: 1, settledRuns: 0, failures: 1 });
  });

  test("no configured world is a no-op", async () => {
    vi.stubEnv("EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL", "");
    vi.stubEnv("EVELAND_WORKFLOW_WORLD_URL", "");
    try {
      const store = createTestStore();
      const listActiveDeployments = vi.fn();
      const result = await reconcileAbandonedWorkflowRuns(store, {
        listActiveDeployments: listActiveDeployments as never,
      });
      expect(result).toEqual({ examinedDeployments: 0, settledRuns: 0, failures: 0 });
      expect(listActiveDeployments).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
