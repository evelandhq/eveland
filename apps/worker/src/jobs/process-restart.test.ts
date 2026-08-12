import { describe, expect, test } from "vitest";
import type { Store } from "@evelandhq/db";
import { createTestStore } from "@evelandhq/db/vitest";
import { processNextJob } from "./process.js";
import { type RuntimeAdapter } from "../runtime/types.js";
import { deriveProjectWorkflowUrl } from "../runtime/workflow-world-bootstrap.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptSecretValue } from "@evelandhq/core/server/secrets";
import { createFixtureEveProject } from "./process.test-support.js";

describe("processNextJob", () => {
  test("restarts the current deployment by stopping and starting it on the recorded runtime kind", async () => {
    const secretKey = "eveland-test-secret-key-00000000";
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Restart Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: ["OPENAI_API_KEY"],
      files: [],
      schedules: [],
    });
    await store.upsertSecret(
      project.id,
      "OPENAI_API_KEY",
      JSON.stringify(encryptSecretValue("sk-test-restart", secretKey)),
    );
    const deployment = await store.recordDeployment({
      releaseId: "rel_cur",
      deploymentId: "dep_cur",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_cur",
      containerName: "eveland-cur-container",
      internalPort: 3000,
      hostPort: 41050,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment");

    await expect(
      processNextJob(store, "worker-a", {
        appSecretKey: secretKey,
        workflowPostgresUrl: "postgres://platform@host.docker.internal:5432/eveland",
        ensureProjectWorkflowWorld: async (env, projectId) =>
          deriveProjectWorkflowUrl(env.WORKFLOW_POSTGRES_URL!, projectId),
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess(input) {
            runtimeCalls.push({ name: "startProcess", input });
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess(processName) {
            runtimeCalls.push({ name: "stopProcess", input: { processName } });
          },
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeCalls).toEqual([
      { name: "stopProcess", input: { processName: deployment.containerName } },
      {
        name: "startProcess",
        input: expect.objectContaining({
          processName: deployment.containerName,
          releaseRef: "eveland/proj:rel_cur",
          port: deployment.hostPort,
          env: expect.objectContaining({
            WORKFLOW_POSTGRES_URL: deriveProjectWorkflowUrl(
              "postgres://platform@host.docker.internal:5432/eveland",
              project.id,
            ),
            OPENAI_API_KEY: "sk-test-restart",
            EVELAND_DEPLOYMENT_ID: deployment.id,
          }),
        }),
      },
    ]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deploymentStatus: "running",
    });
    await expect(store.listLogs(project.id, "deploy")).resolves.toEqual([
      expect.objectContaining({ line: "Restart requested." }),
      expect.objectContaining({
        line: `Deployment running on 127.0.0.1:${deployment.hostPort}.`,
      }),
    ]);
  });

  test("restores the Deployment status when runtime reconciliation races with a successful restart", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Reconciled Restart Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      releaseId: "rel_reconciled_restart",
      deploymentId: "dep_reconciled_restart",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_reconciled_restart",
      containerName: "eveland-reconciled-restart",
      internalPort: 3000,
      hostPort: 41054,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment", {
      deploymentId: deployment.id,
    });

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess() {
            await store.updateDeploymentStatus(deployment.id, "failed");
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({
      status: "running",
    });
  });

  test("keeps a draining Deployment draining across a fanned-out restart", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Draining Restart Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      releaseId: "rel_draining_restart",
      deploymentId: "dep_draining_restart",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_draining_restart",
      containerName: "eveland-draining-restart",
      internalPort: 3000,
      hostPort: 41055,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "draining");
    await store.enqueueJob(project.id, "restart_deployment", {
      deploymentId: deployment.id,
      reason: "shared_agent_environment_changed",
    });

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess() {
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {},
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({
      status: "draining",
    });
    await expect(store.listLogs(project.id, "deploy")).resolves.toEqual([
      expect.objectContaining({ line: "Restart requested." }),
      expect.objectContaining({
        line: `Deployment running on 127.0.0.1:${deployment.hostPort}.`,
      }),
    ]);
  });

  test("skips a restart of an archived deployment instead of resurrecting its process", async () => {
    const runtimeCalls: string[] = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Archived Restart Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      releaseId: "rel_archived_restart",
      deploymentId: "dep_archived_restart",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_archived_restart",
      containerName: "eveland-archived-restart",
      internalPort: 3000,
      hostPort: 41056,
      runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(deployment.id, "archived");
    await store.enqueueJob(project.id, "restart_deployment", {
      deploymentId: deployment.id,
      reason: "secret_changed",
    });

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess() {
            runtimeCalls.push("startProcess");
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess() {
            runtimeCalls.push("stopProcess");
          },
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeCalls).toEqual([]);
    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({
      status: "archived",
    });
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deploymentStatus: "archived",
    });
    await expect(store.listLogs(project.id, "deploy")).resolves.toEqual([
      expect.objectContaining({ line: "Restart requested." }),
      expect.objectContaining({
        line: `Restart skipped: deployment ${deployment.deploymentKey} is archived.`,
      }),
    ]);
  });

  test("marks the Deployment stopped when a restart cannot bring the process back", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Failed Restart Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      releaseId: "rel_failed_restart",
      deploymentId: "dep_failed_restart",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_failed_restart",
      containerName: "eveland-failed-restart",
      internalPort: 3000,
      hostPort: 41057,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment", {
      deploymentId: deployment.id,
    });

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess() {
            throw new Error("image is gone");
          },
          async stopProcess() {},
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    // "stopped", not "failed": a failed Deployment is refused by the activation
    // gate and skipped by every restart fan-out, which would leave this one with
    // no way back. The failure is recorded on the project instead.
    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({
      status: "stopped",
    });
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
  });

  test("restarts the deployment targeted by the job instead of the current project deployment", async () => {
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Targeted Restart Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const current = await store.recordDeployment({
      releaseId: "rel_target_current",
      deploymentId: "dep_target_current",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_target_current",
      containerName: "eveland-target-current",
      internalPort: 3000,
      hostPort: 41052,
      runtimeKind: "docker",
    });
    const preview = await store.recordDeployment({
      releaseId: "rel_target_preview",
      deploymentId: "dep_target_preview",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_target_preview",
      containerName: "eveland-target-preview",
      internalPort: 3000,
      hostPort: 41053,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment", {
      deploymentId: preview.id,
    });

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess(input) {
            runtimeCalls.push({ name: "startProcess", input });
            return { internalPort: 3000, log: "started" };
          },
          async stopProcess(processName) {
            runtimeCalls.push({ name: "stopProcess", input: { processName } });
          },
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeCalls).toEqual([
      { name: "stopProcess", input: { processName: preview.containerName } },
      {
        name: "startProcess",
        input: expect.objectContaining({
          processName: preview.containerName,
          releaseRef: "eveland/proj:rel_target_preview",
          port: preview.hostPort,
          env: expect.objectContaining({ EVELAND_DEPLOYMENT_ID: preview.id }),
        }),
      },
    ]);
    expect(runtimeCalls).not.toContainEqual({
      name: "stopProcess",
      input: { processName: current.containerName },
    });
  });

  test("resolves the runtime adapter by the deployment's recorded runtimeKind when no runtime override is injected", async () => {
    const runtimeCalls: Array<{ name: string; input: unknown }> = [];
    let runtimeForKindCalledWith: "docker" | "systemd" | null = null;
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Restart Systemd Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      releaseId: "rel_systemd",
      deploymentId: "dep_systemd",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_systemd",
      containerName: "eveland-systemd-unit",
      internalPort: 3000,
      hostPort: 41051,
      runtimeKind: "systemd",
    });
    await store.enqueueJob(project.id, "restart_deployment");

    // The deployment was made by systemd; only the systemd adapter may stop and
    // restart its unit, regardless of what runtime kind the worker defaults to.
    const systemdAdapter: RuntimeAdapter = {
      name: "systemd",
      async buildRelease() {
        throw new Error("restart must never build a release");
      },
      async startProcess(input) {
        runtimeCalls.push({ name: "startProcess", input });
        return { internalPort: 3000, log: "started" };
      },
      async stopProcess(processName) {
        runtimeCalls.push({ name: "stopProcess", input: { processName } });
      },
    };

    await expect(
      processNextJob(store, "worker-a", {
        runtimeForKind(kind) {
          runtimeForKindCalledWith = kind;
          return systemdAdapter;
        },
        async waitForDeployment() {},
      }),
    ).resolves.toBe(true);

    expect(runtimeForKindCalledWith).toBe("systemd");
    expect(runtimeCalls).toEqual([
      { name: "stopProcess", input: { processName: deployment.containerName } },
      expect.objectContaining({ name: "startProcess" }),
    ]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deploymentStatus: "running",
    });
  });

  test("stops the restarted process when its health check fails after restart's own stop and start succeed", async () => {
    const stopCalls: string[] = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Restart Cleanup Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      releaseId: "rel_restart_fail",
      deploymentId: "dep_restart_fail",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_restart_fail",
      containerName: "eveland-restart-fail-container",
      internalPort: 3000,
      hostPort: 41113,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment");

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess() {
            return { internalPort: 3000, log: "" };
          },
          async stopProcess(processName) {
            stopCalls.push(processName);
          },
        },
        async waitForDeployment() {
          throw new Error("restarted process never became healthy");
        },
      }),
    ).resolves.toBe(true);

    // Once for the restart's own stop of the running deployment, once more
    // for cleanup of the freshly restarted (but unhealthy) replacement.
    expect(stopCalls).toEqual([deployment.containerName, deployment.containerName]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({
        line: expect.stringContaining("restarted process never became healthy"),
      }),
    );
  });

  test("stops the pre-restart process exactly once when startProcess itself fails during restart (nothing new was started)", async () => {
    const stopCalls: string[] = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Restart Start Fail Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      releaseId: "rel_restart_start_fail",
      deploymentId: "dep_restart_start_fail",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_restart_start_fail",
      containerName: "eveland-restart-start-fail-container",
      internalPort: 3000,
      hostPort: 41114,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment");

    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess() {
            throw new Error("failed to start transient unit");
          },
          async stopProcess(processName) {
            stopCalls.push(processName);
          },
        },
      }),
    ).resolves.toBe(true);

    // Only the pre-restart stop ran: `restarted` stays false when startProcess
    // itself throws, so there is nothing new to clean up and the cleanup stop
    // must not fire a second time.
    expect(stopCalls).toEqual([deployment.containerName]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({
        line: expect.stringContaining("failed to start transient unit"),
      }),
    );
  });

  test("fails a restart_deployment job when there is no deployment to restart", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "No Deployment Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.enqueueJob(project.id, "restart_deployment");

    await expect(processNextJob(store, "worker-a")).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({
        line: expect.stringContaining("No deployment to restart."),
      }),
    );
  });

  test("fails a restart_deployment job when the deployment's release record is missing", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Corrupt State Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath,
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      releaseId: "rel_missing",
      deploymentId: "dep_missing",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_missing",
      containerName: "eveland-missing-container",
      internalPort: 3000,
      hostPort: 41052,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment");
    // Simulates corrupt state: the deployment's release row is gone even though
    // the deployment itself still is (a deployment without its release is not
    // recoverable, so restart must fail loudly rather than guess).
    const storeWithMissingRelease: Store = {
      ...store,
      async getRelease() {
        return null;
      },
    };

    await expect(processNextJob(storeWithMissingRelease, "worker-a")).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({ line: expect.stringContaining("rel_missing") }),
    );
  });

  test("fails a restart_deployment job loudly when the revision's source directory has vanished from disk, without stopping the running process first", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Vanished Source Agent",
      importKind: "zip",
      sourcePath,
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    // A real temp dir, then removed -- the revision's sourcePath row still
    // points at it, but nothing exists there anymore on disk.
    const vanishedSourcePath = await mkdtemp(path.join(os.tmpdir(), "eveland-vanished-"));
    await rm(vanishedSourcePath, { recursive: true, force: true });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: vanishedSourcePath,
      summary: {},
      envVars: [],
      files: [
        {
          path: "package.json",
          content: JSON.stringify({ dependencies: { eve: "^0.31.0" } }),
        },
        { path: "package-lock.json", content: "{}" },
      ],
      schedules: [],
    });
    await store.recordDeployment({
      releaseId: "rel_vanished",
      deploymentId: "dep_vanished",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_vanished",
      containerName: "eveland-vanished-container",
      internalPort: 3000,
      hostPort: 41060,
      runtimeKind: "docker",
    });
    await store.enqueueJob(project.id, "restart_deployment");

    const stopCalls: string[] = [];
    await expect(
      processNextJob(store, "worker-a", {
        runtime: {
          name: "docker",
          async buildRelease() {
            throw new Error("restart must never build a release");
          },
          async startProcess() {
            throw new Error("restart must never start a process when the source dir is missing");
          },
          async stopProcess(processName) {
            stopCalls.push(processName);
          },
        },
      }),
    ).resolves.toBe(true);

    // The missing-source check must run before the pre-restart stop, so a
    // vanished source dir never takes the currently running process down.
    expect(stopCalls).toEqual([]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "failed",
      deploymentStatus: "failed",
    });
    await expect(store.listLogs(project.id, "runtime")).resolves.toContainEqual(
      expect.objectContaining({
        line: expect.stringContaining(
          `Source directory for revision ${revision.id} is missing: ${vanishedSourcePath}. Re-import the source and deploy instead.`,
        ),
      }),
    );
  });
});
