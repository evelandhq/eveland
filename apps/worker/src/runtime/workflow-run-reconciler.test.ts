import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test, vi } from "vitest";
import type { ActiveWorkflowRunDeployment } from "./eveland-workflow-world-runs.js";
import { isEveOwnedWorkflow, reconcileAbandonedWorkflowRuns } from "./workflow-run-reconciler.js";

const SESSION_WORKFLOW = "workflow//eve//workflowEntry";
const TIMEOUT_WORKFLOW = "workflow//eve//sessionTimeoutWorkflow";
const DAY_MS = 86_400_000;

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
      summary: { eveVersionResolved: "0.55.0" },
    });
    // Stopped by the idle reaper — the acceptance case that must NOT settle:
    // a sleeping timer or a session inbox hook on this Deployment is live
    // durable state, and the next activation resumes it. It carries the
    // project route, so the archive policy keeps it whatever its age.
    await store.updateDeploymentStatus(healthy.id, "stopped");
    await store.ensureDeploymentRoutes(project.id, healthy.id, "run-reconciler.localhost");

    const crashed = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "run-reconciler:crashed",
      containerName: "run-reconciler-crashed",
      internalPort: 3000,
      hostPort: 41961,
      runtimeKind: "systemd",
      summary: { eveVersionResolved: "0.55.0" },
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
      summary: { eveVersionResolved: "0.55.0" },
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
      { projectId: project.id, deploymentId: healthy.id, workflowNames: [SESSION_WORKFLOW] },
      { projectId: project.id, deploymentId: crashed.id, workflowNames: [SESSION_WORKFLOW] },
      { projectId: project.id, deploymentId: archived.id, workflowNames: [SESSION_WORKFLOW] },
      { projectId: project.id, deploymentId: staleEve.id, workflowNames: [SESSION_WORKFLOW] },
      { projectId: project.id, deploymentId: "dep_gone", workflowNames: [SESSION_WORKFLOW] },
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
      summary: { eveVersionResolved: "0.55.0" },
    });
    await store.updateDeploymentStatus(deployment.id, "archived");

    const reconcile = vi.fn(async () => ({ disposition: "fail" as const, reconciled: [] }));
    const result = await reconcileAbandonedWorkflowRuns(store, {
      evelandWorkflowWorldUrl: "postgres://world.test/db",
      listActiveDeployments: async () => [
        { projectId: "proj_other", deploymentId: deployment.id, workflowNames: [SESSION_WORKFLOW] },
      ],
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
      summary: { eveVersionResolved: "0.55.0" },
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
      listActiveDeployments: async () => [
        { projectId: project.id, deploymentId: archived.id, workflowNames: [SESSION_WORKFLOW] },
      ],
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

/**
 * Five stopped Deployments, newest last: with keepRecent 3, the two oldest
 * are outside the archive policy's `recent_artifact` window and the newest
 * carries the project route. Returns them oldest first.
 */
async function supersededFixture(store: ReturnType<typeof createTestStore>, name: string) {
  const { project, revision } = await fixtureProject(store, name);
  const deployments = [];
  for (let index = 0; index < 5; index += 1) {
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: `${name}:${index}`,
      containerName: `${name}-${index}`,
      internalPort: 3000,
      hostPort: 41970 + index,
      runtimeKind: "systemd",
      summary: { eveVersionResolved: "0.55.0" },
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    deployments.push(deployment);
  }
  const [projectRoute] = await store.ensureDeploymentRoutes(
    project.id,
    deployments[4]!.id,
    `${name}.localhost`,
  );
  const bind = (deploymentId: string, trigger: "api" | "playground", suffix: string) =>
    store.bindSession({
      projectId: project.id,
      eveSessionId: `eve_${name}_${suffix}`,
      routeId: projectRoute!.id,
      deploymentId,
      trigger,
      variantName: null,
      experimentId: null,
      requestId: `request_${name}_${suffix}`,
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
    });
  return { project, deployments, bind };
}

function cancelRecorder() {
  return vi.fn(
    async (
      _pool: unknown,
      options: { tenantId: string; deploymentIds?: string[]; disposition: string; reason: string },
    ) => ({
      disposition: options.disposition as "cancel",
      reconciled: [
        {
          runId: `wrun_${options.deploymentIds![0]!}`,
          workflowName: SESSION_WORKFLOW,
          deploymentId: options.deploymentIds![0]!,
          previousStatus: "running" as const,
        },
      ],
    }),
  );
}

describe("reconcileAbandonedWorkflowRuns on superseded Deployments", () => {
  test("cancels the session runs of a superseded Deployment once every binding to it has lapsed", async () => {
    const store = createTestStore();
    const { project, deployments, bind } = await supersededFixture(store, "superseded");
    // Oldest: an API session bound nine days ago (TTL is seven).
    await bind(deployments[0]!.id, "api", "old-api");
    // Second oldest: a Playground session bound two days ago (TTL is one).
    await bind(deployments[1]!.id, "playground", "old-playground");
    const reconcile = cancelRecorder();

    const result = await reconcileAbandonedWorkflowRuns(store, {
      evelandWorkflowWorldUrl: "postgres://world.test/db",
      keepRecent: 3,
      now: new Date(Date.now() + 9 * DAY_MS),
      playgroundIdleTtlMs: DAY_MS,
      apiIdleTtlMs: 7 * DAY_MS,
      listActiveDeployments: async () =>
        deployments.map((deployment) => ({
          projectId: project.id,
          deploymentId: deployment.id,
          workflowNames: [SESSION_WORKFLOW, TIMEOUT_WORKFLOW],
        })),
      reconcile: reconcile as never,
    });

    expect(result).toEqual({ examinedDeployments: 5, settledRuns: 2, failures: 0 });
    const settled = reconcile.mock.calls.map((call) => call[1].deploymentIds![0]).sort();
    expect(settled).toEqual([deployments[0]!.id, deployments[1]!.id].sort());
    for (const call of reconcile.mock.calls) {
      expect(call[1]).toMatchObject({ tenantId: project.id, disposition: "cancel" });
      expect(call[1]).not.toHaveProperty("errorCode");
      expect(call[1].reason).toMatch(/^Reconciled by the platform: /);
    }
  });

  test("keeps the runs while a binding is still inside its idle TTL, or the Deployment is recent, routed, or running", async () => {
    const store = createTestStore();
    const { project, deployments, bind } = await supersededFixture(store, "kept");
    // Oldest: an API session bound two days ago — five days of TTL left.
    await bind(deployments[0]!.id, "api", "live-api");
    // Second oldest: no binding at all, but the process is still up.
    await store.updateDeploymentStatus(deployments[1]!.id, "running");
    // deployments[2..3] are inside the recent window; [4] carries the route.
    const reconcile = cancelRecorder();

    const result = await reconcileAbandonedWorkflowRuns(store, {
      evelandWorkflowWorldUrl: "postgres://world.test/db",
      keepRecent: 3,
      now: new Date(Date.now() + 2 * DAY_MS),
      playgroundIdleTtlMs: DAY_MS,
      apiIdleTtlMs: 7 * DAY_MS,
      listActiveDeployments: async () =>
        deployments.map((deployment) => ({
          projectId: project.id,
          deploymentId: deployment.id,
          workflowNames: [SESSION_WORKFLOW],
        })),
      reconcile: reconcile as never,
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(result).toEqual({ examinedDeployments: 5, settledRuns: 0, failures: 0 });
  });

  test("a project-authored workflow sleeping on the Deployment keeps every run there", async () => {
    const store = createTestStore();
    const { project, deployments } = await supersededFixture(store, "authored");
    const reconcile = cancelRecorder();

    const result = await reconcileAbandonedWorkflowRuns(store, {
      evelandWorkflowWorldUrl: "postgres://world.test/db",
      keepRecent: 3,
      now: new Date(Date.now() + 9 * DAY_MS),
      listActiveDeployments: async () => [
        {
          projectId: project.id,
          deploymentId: deployments[0]!.id,
          workflowNames: [SESSION_WORKFLOW, "workflow//agent//nightlyDigest"],
        },
        { projectId: project.id, deploymentId: deployments[1]!.id, workflowNames: [] },
      ],
      reconcile: reconcile as never,
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(result.settledRuns).toBe(0);
  });

  test("an unstartable Deployment is still failed, never cancelled, whatever its bindings", async () => {
    const store = createTestStore();
    const { project, deployments } = await supersededFixture(store, "unstartable");
    await store.updateDeploymentStatus(deployments[0]!.id, "archived");
    const reconcile = cancelRecorder();

    await reconcileAbandonedWorkflowRuns(store, {
      evelandWorkflowWorldUrl: "postgres://world.test/db",
      listActiveDeployments: async () => [
        {
          projectId: project.id,
          deploymentId: deployments[0]!.id,
          workflowNames: [SESSION_WORKFLOW],
        },
      ],
      reconcile: reconcile as never,
    });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]![1]).toMatchObject({
      disposition: "fail",
      errorCode: "DEPLOYMENT_UNSTARTABLE",
    });
  });
});

describe("isEveOwnedWorkflow", () => {
  test("recognises Eve's stable workflow names and nothing else", () => {
    expect(isEveOwnedWorkflow(SESSION_WORKFLOW)).toBe(true);
    expect(isEveOwnedWorkflow(TIMEOUT_WORKFLOW)).toBe(true);
    expect(isEveOwnedWorkflow("workflow//agent//nightlyDigest")).toBe(false);
    expect(isEveOwnedWorkflow("")).toBe(false);
  });
});
