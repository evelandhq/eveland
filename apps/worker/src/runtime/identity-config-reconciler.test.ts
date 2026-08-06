import { createTestStore } from "@evelandhq/db/vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { reconcileIdentityDeploymentConfiguration } from "./identity-config-reconciler.js";

describe("reconcileIdentityDeploymentConfiguration", () => {
  test("queues targeted restarts when the injected Identity configuration changes", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Identity Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/identity-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      releaseId: "rel_identity",
      deploymentId: "dep_identity",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/identity:rel",
      containerName: "eveland-identity",
      internalPort: 3000,
      hostPort: 41050,
      runtimeKind: "docker",
    });
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-identity-config-"));

    const jobs = await reconcileIdentityDeploymentConfiguration(store, {
      dataDir,
      issuer: "http://localhost:4000",
      jwksUrl: "http://host.docker.internal:4000/.well-known/jwks.json",
    });

    expect(jobs).toEqual([
      expect.objectContaining({
        projectId: project.id,
        type: "restart_deployment",
        payload: {
          deploymentId: deployment.id,
          reason: "identity_configuration_changed",
        },
      }),
    ]);
    await expect(
      reconcileIdentityDeploymentConfiguration(store, {
        dataDir,
        issuer: "http://localhost:4000",
        jwksUrl: "http://host.docker.internal:4000/.well-known/jwks.json",
      }),
    ).resolves.toEqual([]);
    const queued = await store.claimNextJob("worker-a");
    expect(queued?.id).toBe(jobs[0]?.id);
    await store.completeJob(queued!.id);
    await expect(store.claimNextJob("worker-a")).resolves.toBeNull();
  });

  test("runs Identity configuration reconciliation before the Worker accepts jobs", async () => {
    const workerSource = await readFile(new URL("../worker.ts", import.meta.url), "utf8");

    expect(workerSource).toMatch(/await\s+reconcileIdentityDeploymentConfiguration/);
  });
});
