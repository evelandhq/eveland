import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestStore } from "@eveland/db/vitest";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_TEAM_ID } from "@eveland/db";
import { resolveAgentObservabilityDirs } from "../runtime/observability/policy.js";
import {
  createDeploymentObservabilityReconciler,
  prepareDeploymentObservability,
  warnStaleObserverRelease,
} from "./process-observability.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Deployment observability policy", () => {
  test("materializes the current system setting into a credential-free Docker policy", async () => {
    const store = createTestStore();
    await store.createProject({
      name: "Policy Delivery Agent",
      importKind: "zip",
    });
    await store.saveObservabilityPolicy({
      teamId: DEFAULT_TEAM_ID,
      expectedRevision: 1,
      agentCapture: {
        enabled: false,
        sampling: { ratio: 0.5 },
        recordInputs: true,
        recordOutputs: false,
        includeReasoning: false,
      },
      externalDestinations: [],
    });
    const dataDir = path.join(os.tmpdir(), `eveland-policy-delivery-${Date.now()}`);
    temporaryDirectories.push(dataDir);

    const prepared = await prepareDeploymentObservability({
      store,
      env: {
        EVELAND_DATA_DIR: dataDir,
        EVELAND_HOST_DATA_DIR: "/host/eveland-data",
      },
      projectId: "proj_1",
      releaseId: "rel_1",
      deploymentId: "dep_1",
      runtimeKind: "docker",
      nodeEnv: "production",
    });

    expect(prepared).toMatchObject({
      policy: {
        revision: 2,
        capture: {
          enabled: false,
          sampleRatio: 0.5,
          recordInputs: true,
        },
        otlp: { endpoint: "http://eveland-otel-collector:4328" },
        resource: {
          teamId: DEFAULT_TEAM_ID,
          projectId: "proj_1",
          releaseId: "rel_1",
          deploymentId: "dep_1",
          runtimeKind: "docker",
          environment: "production",
        },
      },
      workerDir: path.join(dataDir, "observability/proj_1/dep_1"),
      hostDir: "/host/eveland-data/observability/proj_1/dep_1",
    });
    expect(
      JSON.parse(await readFile(path.join(prepared.workerDir, "agent-policy.json"), "utf8")),
    ).toEqual(prepared.policy);
    expect(JSON.stringify(prepared.policy)).not.toContain("externalDestinations");
  });

  test("delivers the current observer runtime bundle next to the policy", async () => {
    const store = createTestStore();
    await store.createProject({
      name: "Runtime Delivery Agent",
      importKind: "zip",
    });
    const dataDir = path.join(os.tmpdir(), `eveland-runtime-delivery-${Date.now()}`);
    temporaryDirectories.push(dataDir);

    const prepared = await prepareDeploymentObservability({
      store,
      env: { EVELAND_DATA_DIR: dataDir },
      projectId: "proj_1",
      releaseId: "rel_1",
      deploymentId: "dep_1",
      runtimeKind: "docker",
      nodeEnv: "production",
    });

    const runtime = await readFile(path.join(prepared.workerDir, "runtime.mjs"), "utf8");
    // The mount-delivered bundle must be self-contained: the Agent cannot
    // resolve platform packages from inside the observability mount.
    expect(runtime).toContain("OTLPTraceExporter");
    expect(runtime).not.toContain('from "eve/hooks"');
    expect(runtime).not.toContain('from "@eveland/');
  });

  test("flags a release whose baked observer predates the delivery contract", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Stale Observer Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/stale-observer-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    // No observerContract: mirrors every release built before the column existed.
    const legacyDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:stale-observer",
      containerName: "fixture-stale-observer",
      internalPort: 3000,
      hostPort: 41996,
      runtimeKind: "docker",
    });
    const legacyRelease = await store.getRelease(legacyDeployment.releaseId);

    await warnStaleObserverRelease(store, {
      projectId: project.id,
      deploymentId: legacyDeployment.id,
      release: legacyRelease!,
    });

    const runtimeLogs = await store.listLogs(project.id, "runtime");
    expect(runtimeLogs).toHaveLength(1);
    expect(runtimeLogs[0]!.line).toContain(legacyRelease!.id);
    expect(runtimeLogs[0]!.line).toContain("Rebuild the release");

    const currentDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:current-observer",
      observerContract: 2,
      containerName: "fixture-current-observer",
      internalPort: 3000,
      hostPort: 41997,
      runtimeKind: "docker",
    });
    const currentRelease = await store.getRelease(currentDeployment.releaseId);
    expect(currentRelease!.observerContract).toBe(2);

    await warnStaleObserverRelease(store, {
      projectId: project.id,
      deploymentId: currentDeployment.id,
      release: currentRelease!,
    });

    await expect(store.listLogs(project.id, "runtime")).resolves.toHaveLength(1);
  });

  test("refreshes every running Deployment after a policy revision without touching its runtime", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Live Policy Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/live-policy-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:live-policy",
      containerName: "fixture-live-policy",
      internalPort: 3000,
      hostPort: 41995,
      runtimeKind: "docker",
    });
    const dataDir = path.join(os.tmpdir(), `eveland-policy-reconcile-${Date.now()}`);
    temporaryDirectories.push(dataDir);
    const reconcile = createDeploymentObservabilityReconciler({
      store,
      env: {
        EVELAND_DATA_DIR: dataDir,
        EVELAND_HOST_DATA_DIR: "/host/eveland-data",
      },
      nodeEnv: "production",
    });

    await expect(reconcile()).resolves.toBe(1);
    await expect(reconcile()).resolves.toBe(0);

    await store.saveObservabilityPolicy({
      teamId: DEFAULT_TEAM_ID,
      expectedRevision: 1,
      agentCapture: {
        enabled: false,
        sampling: { ratio: 0.25 },
        recordInputs: false,
        recordOutputs: false,
        includeReasoning: false,
      },
      externalDestinations: [],
    });

    await expect(reconcile()).resolves.toBe(1);
    await expect(readRuntimePolicy(dataDir, project.id, deployment.id)).resolves.toMatchObject({
      revision: 2,
      capture: { enabled: false, sampleRatio: 0.25 },
      resource: {
        projectId: project.id,
        releaseId: deployment.releaseId,
        deploymentId: deployment.id,
      },
    });
  });
});

/**
 * Resolves the directory the same way the runtime does instead of joining the raw ids: the
 * path segments are process-safe names, so a mixed-case id only matches on a
 * case-insensitive filesystem.
 */
async function readRuntimePolicy(dataDir: string, projectId: string, deploymentId: string) {
  const { workerDir } = resolveAgentObservabilityDirs(
    { EVELAND_DATA_DIR: dataDir },
    projectId,
    deploymentId,
  );
  return JSON.parse(await readFile(path.join(workerDir, "agent-policy.json"), "utf8"));
}
