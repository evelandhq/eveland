import { describe, expect, test } from "vitest";
import type { Store } from "@eveland/db";
import { createTestStore } from "@eveland/db/vitest";
import { processNextJob } from "./process.js";
import { processSafeName, type RuntimeAdapter } from "../runtime/types.js";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFixtureEveProject } from "./process.test-support.js";

describe("processNextJob", () => {
  test("delete_project stops the deployment through its recorded runtimeKind adapter, logging before stopping, then deletes the project last", async () => {
    const calls: string[] = [];
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Delete Agent",
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
      releaseId: "rel_del",
      deploymentId: "dep_del",
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_del",
      containerName: "eveland-del-systemd-unit",
      internalPort: 3000,
      hostPort: 41060,
      runtimeKind: "systemd",
    });
    await store.enqueueJob(project.id, "delete_project");

    let runtimeForKindCalledWith: "docker" | "systemd" | null = null;
    // Only the systemd adapter may stop a systemd unit; the worker's active
    // default runtime (docker, injected as `options.runtime` in other tests)
    // must never be consulted for stopping a deployment it doesn't own.
    const stopAdapter: RuntimeAdapter = {
      name: "systemd",
      async buildRelease() {
        throw new Error("delete_project must never build a release");
      },
      async startProcess() {
        throw new Error("delete_project must never start a process");
      },
      async stopProcess(processName) {
        calls.push(`stopProcess:${processName}`);
      },
    };
    const spyingStore: Store = {
      ...store,
      async appendLog(input) {
        calls.push(`appendLog:${input.line}`);
        return store.appendLog(input);
      },
      async updateProjectState(projectId, state) {
        calls.push("updateProjectState");
        return store.updateProjectState(projectId, state);
      },
      async deleteProject(projectId) {
        calls.push(`deleteProject:${projectId}`);
        return store.deleteProject(projectId);
      },
    };

    await expect(
      processNextJob(spyingStore, "worker-a", {
        runtimeForKind(kind) {
          runtimeForKindCalledWith = kind;
          return stopAdapter;
        },
      }),
    ).resolves.toBe(true);

    expect(runtimeForKindCalledWith).toBe("systemd");
    // The log must land before the process is stopped, and nothing --
    // no log, no state update -- may follow the delete.
    expect(calls).toEqual([
      "appendLog:Stopping 1 deployment(s) before deleting project.",
      `stopProcess:${deployment.containerName}`,
      `deleteProject:${project.id}`,
    ]);
    await expect(store.getProject(project.id)).resolves.toBeNull();
  });

  test("delete_project drops the project's workflow database before the project row is removed", async () => {
    const calls: string[] = [];
    const store = createTestStore();
    const project = await store.createProject({
      name: "Drop World Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "delete_project");
    const spyingStore: Store = {
      ...store,
      async deleteProject(projectId) {
        calls.push(`deleteProject:${projectId}`);
        return store.deleteProject(projectId);
      },
    };

    await expect(
      processNextJob(spyingStore, "worker-a", {
        dropProjectWorkflowWorld: async (_env, projectId) => {
          calls.push(`dropWorld:${projectId}`);
        },
      }),
    ).resolves.toBe(true);

    expect(calls).toEqual([`dropWorld:${project.id}`, `deleteProject:${project.id}`]);
    await expect(store.getProject(project.id)).resolves.toBeNull();
  });

  test("delete_project keeps the project when dropping its workflow database fails", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Drop Fail Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "delete_project");

    await expect(
      processNextJob(store, "worker-a", {
        dropProjectWorkflowWorld: async () => {
          throw new Error("workflow database is unreachable");
        },
      }),
    ).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deletionError: expect.stringContaining("workflow database is unreachable"),
    });
  });

  test("delete_project removes runtime releases and only platform-managed project files", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-delete-data-"));
    const externalSource = await mkdtemp(path.join(os.tmpdir(), "eveland-external-source-"));
    const managedUpload = path.join(dataDir, "uploads", "zip-managed");
    const managedSource = path.join(managedUpload, "source", "wrapped-project");
    const calls: string[] = [];

    try {
      await mkdir(managedSource, { recursive: true });
      await writeFile(path.join(managedSource, "package.json"), "{}");
      await writeFile(path.join(managedUpload, "source.zip"), "archive");
      await writeFile(path.join(externalSource, "keep.txt"), "keep");
      const store = createTestStore();
      const project = await store.createProject({
        name: "Deep Delete Agent",
        importKind: "zip",
        sourcePath: managedSource,
      });
      const importJob = await store.claimNextJob("worker-a");
      await store.completeJob(importJob!.id);
      await store.recordSourceRevision({
        projectId: project.id,
        kind: "zip",
        sourcePath: managedSource,
        summary: {},
        envVars: [],
        files: [],
        schedules: [],
      });
      const currentRevision = await store.recordSourceRevision({
        projectId: project.id,
        kind: "zip",
        sourcePath: externalSource,
        summary: {},
        envVars: [],
        files: [],
        schedules: [],
      });
      const deployment = await store.recordDeployment({
        releaseId: "rel_deep_delete",
        deploymentId: "dep_deep_delete",
        projectId: project.id,
        sourceRevisionId: currentRevision.id,
        imageTag: "eveland/deep-delete:release",
        containerName: "eveland-deep-delete",
        internalPort: 3000,
        hostPort: 41061,
        runtimeKind: "systemd",
      });
      const deploymentEnvFile = path.join(
        dataDir,
        "deployment-env",
        `${deployment.containerName}.env`,
      );
      await mkdir(path.dirname(deploymentEnvFile), { recursive: true });
      await writeFile(deploymentEnvFile, "SECRET=remove");
      const managedProjectDirs = [
        path.join(dataDir, "sources", project.id),
        path.join(dataDir, "builds", project.id),
        path.join(dataDir, "observability", processSafeName(project.id)),
        path.join(dataDir, "sandbox", processSafeName(project.id)),
      ];
      for (const directory of managedProjectDirs) {
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "owned.txt"), "delete");
      }
      await store.requestProjectDeletion(project.id);
      const adapter: RuntimeAdapter = {
        name: "systemd",
        async buildRelease() {
          throw new Error("delete_project must never build a release");
        },
        async startProcess() {
          throw new Error("delete_project must never start a process");
        },
        async stopProcess(processName) {
          calls.push(`stop:${processName}`);
        },
        async removeRelease(releaseRef) {
          calls.push(`remove:${releaseRef}`);
        },
      };

      await expect(
        processNextJob(store, "worker-a", {
          dataDir,
          runtimeForKind: () => adapter,
        }),
      ).resolves.toBe(true);

      expect(calls).toEqual([
        `stop:${deployment.containerName}`,
        "remove:eveland/deep-delete:release",
      ]);
      await expect(store.getProject(project.id)).resolves.toBeNull();
      for (const directory of [...managedProjectDirs, managedUpload]) {
        await expect(access(directory)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(access(deploymentEnvFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(path.join(externalSource, "keep.txt"))).resolves.toBeUndefined();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(externalSource, { recursive: true, force: true });
    }
  });

  test("delete_project removes a pending Zip upload before source import has run", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-delete-pending-"));
    const uploadDir = path.join(dataDir, "uploads", "zip-pending");
    const sourcePath = path.join(uploadDir, "source", "wrapped-project");

    try {
      await mkdir(sourcePath, { recursive: true });
      await writeFile(path.join(sourcePath, "package.json"), "{}");
      await writeFile(path.join(uploadDir, "source.zip"), "archive");
      const store = createTestStore();
      const project = await store.createProject({
        name: "Pending Delete Agent",
        importKind: "zip",
        sourcePath,
      });
      await store.requestProjectDeletion(project.id);

      await expect(processNextJob(store, "worker-a", { dataDir })).resolves.toBe(true);

      await expect(store.getProject(project.id)).resolves.toBeNull();
      await expect(access(uploadDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("delete_project with no current deployment deletes the project without stopping or logging anything", async () => {
    const calls: string[] = [];
    const store = createTestStore();
    const project = await store.createProject({
      name: "No Deployment Delete Agent",
      importKind: "zip",
      sourcePath: "/tmp/no-deployment",
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "delete_project");

    const spyingStore: Store = {
      ...store,
      async appendLog(input) {
        calls.push(`appendLog:${input.line}`);
        return store.appendLog(input);
      },
      async deleteProject(projectId) {
        calls.push(`deleteProject:${projectId}`);
        return store.deleteProject(projectId);
      },
    };

    await expect(processNextJob(spyingStore, "worker-a")).resolves.toBe(true);

    expect(calls).toEqual([`deleteProject:${project.id}`]);
    await expect(store.getProject(project.id)).resolves.toBeNull();
  });

  test("delete_project failure keeps the project and records a retryable deletion error", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Retryable Delete Agent",
      importKind: "zip",
      sourcePath: "/tmp/retry-delete",
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.requestProjectDeletion(project.id);
    const failingStore: Store = {
      ...store,
      async deleteProject() {
        throw new Error("storage unavailable");
      },
    };

    await expect(processNextJob(failingStore, "worker-a")).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deletionStatus: "failed",
      deletionError: "storage unavailable",
      status: "import_pending",
    });
  });

  test("delete_project is idempotent: a re-run against an already-gone project returns silently", async () => {
    const calls: string[] = [];
    const store = createTestStore();
    const project = await store.createProject({
      name: "Already Gone Agent",
      importKind: "zip",
      sourcePath: "/tmp/already-gone",
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "delete_project");

    // Simulates a half-finished delete_project retry: the project row is
    // already gone (e.g. a prior run got as far as store.deleteProject before
    // crashing), but nothing else about the store is touched.
    const storeWithProjectGone: Store = {
      ...store,
      async getProject(projectId) {
        calls.push(`getProject:${projectId}`);
        return null;
      },
      async getCurrentDeployment(projectId) {
        calls.push(`getCurrentDeployment:${projectId}`);
        return store.getCurrentDeployment(projectId);
      },
      async deleteProject(projectId) {
        calls.push(`deleteProject:${projectId}`);
        return store.deleteProject(projectId);
      },
    };

    await expect(processNextJob(storeWithProjectGone, "worker-a")).resolves.toBe(true);

    // The handler must return immediately after the missing getProject check --
    // it must never call getCurrentDeployment or deleteProject again.
    expect(calls).toEqual([`getProject:${project.id}`]);
  });
});
