import { createTestStore } from "@evelandhq/db/vitest";
import { access, mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  platformRuntimeConfigurationFingerprint,
  reconcilePlatformRuntimeConfiguration,
} from "./platform-runtime-config-reconciler.js";
import { RESERVED_RUNTIME_ENVIRONMENT_INPUTS } from "./reserved-environment.js";

const baseEnv = {
  EVELAND_WORKFLOW_WORLD_URL: "postgres://eveland@127.0.0.1:17310/eveland_workflow",
  EVELAND_IDENTITY_ISSUER: "https://identity.example.com",
  EVELAND_SCHEDULER_RUNTIME_SECRET: "scheduler-runtime-secret",
  NODE_ENV: "production",
} as const satisfies NodeJS.ProcessEnv;

async function storeWithLiveDeployment(status?: "draining") {
  const store = createTestStore();
  const project = await store.createProject({ name: "Drift Agent", importKind: "zip" });
  const importJob = await store.claimNextJob("worker-a");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/drift-agent",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    releaseId: "rel_drift",
    deploymentId: "dep_drift",
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "eveland/drift:rel",
    containerName: "eveland-drift",
    internalPort: 3000,
    hostPort: 41060,
    runtimeKind: "systemd",
  });
  if (status) await store.updateDeploymentStatus(deployment.id, status);
  return { store, project, deployment };
}

async function temporaryDataDir() {
  return mkdtemp(path.join(os.tmpdir(), "eveland-platform-config-"));
}

describe("platformRuntimeConfigurationFingerprint", () => {
  test("covers every input the reserved layer reads", () => {
    // The guard that would have caught issue #477: before it, only the two
    // Identity variables were fingerprinted, so moving the workflow world
    // changed nothing here and no running Deployment was ever told.
    for (const name of RESERVED_RUNTIME_ENVIRONMENT_INPUTS) {
      expect(
        platformRuntimeConfigurationFingerprint({ ...baseEnv, [name]: "changed-value" }),
        `${name} does not reach the fingerprint`,
      ).not.toBe(platformRuntimeConfigurationFingerprint(baseEnv));
    }
  });

  test("distinguishes an unset variable from an empty one", () => {
    expect(platformRuntimeConfigurationFingerprint({})).not.toBe(
      platformRuntimeConfigurationFingerprint({ EVELAND_WORKFLOW_WORLD_URL: "" }),
    );
  });

  test("ignores everything outside the reserved layer's inputs", () => {
    expect(
      platformRuntimeConfigurationFingerprint({ ...baseEnv, DATABASE_URL: "postgres://elsewhere" }),
    ).toBe(platformRuntimeConfigurationFingerprint(baseEnv));
  });
});

describe("reconcilePlatformRuntimeConfiguration", () => {
  test("restarts live Deployments when a reserved input changes, then settles", async () => {
    const { store, project, deployment } = await storeWithLiveDeployment();
    const dataDir = await temporaryDataDir();

    // First boot: nothing recorded, so the fleet is restarted once rather than
    // left running on values that may already have drifted.
    await expect(
      reconcilePlatformRuntimeConfiguration(store, { dataDir, env: baseEnv }),
    ).resolves.toEqual([
      expect.objectContaining({
        projectId: project.id,
        type: "restart_deployment",
        payload: {
          deploymentId: deployment.id,
          reason: "platform_runtime_configuration_changed",
        },
      }),
    ]);

    // Same environment, later boot: no bounce.
    await expect(
      reconcilePlatformRuntimeConfiguration(store, { dataDir, env: baseEnv }),
    ).resolves.toEqual([]);

    // The UAT case: the workflow world moved to an external instance.
    await expect(
      reconcilePlatformRuntimeConfiguration(store, {
        dataDir,
        env: {
          ...baseEnv,
          EVELAND_WORKFLOW_WORLD_URL: "postgres://eveland@10.0.0.5:5432/eveland_workflow",
        },
      }),
    ).resolves.toHaveLength(1);
  });

  test("restarts a draining Deployment and leaves a stopped one alone", async () => {
    const draining = await storeWithLiveDeployment("draining");
    await expect(
      reconcilePlatformRuntimeConfiguration(draining.store, {
        dataDir: await temporaryDataDir(),
        env: baseEnv,
      }),
    ).resolves.toHaveLength(1);

    // A stopped Deployment composes a fresh environment when it cold activates.
    const stopped = await storeWithLiveDeployment();
    await stopped.store.updateDeploymentStatus(stopped.deployment.id, "stopped");
    await expect(
      reconcilePlatformRuntimeConfiguration(stopped.store, {
        dataDir: await temporaryDataDir(),
        env: baseEnv,
      }),
    ).resolves.toEqual([]);
  });

  test("records the fingerprint 0600 and retires the Identity-only predecessor", async () => {
    const { store } = await storeWithLiveDeployment();
    const dataDir = await temporaryDataDir();
    const stateDir = path.join(dataDir, "runtime-state");
    await mkdir(stateDir, { recursive: true });
    const legacyPath = path.join(stateDir, "identity-configuration.sha256");
    await writeFile(legacyPath, "stale-identity-only-fingerprint\n");

    await reconcilePlatformRuntimeConfiguration(store, { dataDir, env: baseEnv });

    const statePath = path.join(stateDir, "platform-runtime-configuration.sha256");
    await expect(readFile(statePath, "utf8")).resolves.toBe(
      `${platformRuntimeConfigurationFingerprint(baseEnv)}\n`,
    );
    // A digest of a secret is still worth 0600.
    const { mode } = await import("node:fs/promises").then((fs) => fs.stat(statePath));
    expect(mode & 0o777).toBe(0o600);
    await expect(access(legacyPath)).rejects.toThrow();
  });

  test("runs before the Worker accepts jobs", async () => {
    const workerSource = await readFile(new URL("../worker.ts", import.meta.url), "utf8");

    expect(workerSource).toMatch(/await\s+reconcilePlatformRuntimeConfiguration/);
  });
});
