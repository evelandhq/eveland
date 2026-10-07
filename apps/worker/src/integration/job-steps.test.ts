import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test } from "vitest";
import { createFixtureEveProject } from "../jobs/process.test-support.js";
import { runExpectedJob } from "./job-steps.test-support.js";

describe("runExpectedJob", () => {
  test("runs the expected job and its worker-queued follow-up by parent", async () => {
    const store = createTestStore();
    const sourcePath = await createFixtureEveProject();
    const project = await store.createProject({
      name: "Steps Agent",
      importKind: "zip",
      sourcePath,
    });
    await runExpectedJob(store, "w", { projectId: project.id, type: "import_source" });

    const resync = await store.enqueueJob(project.id, "import_source", {
      importKind: "zip",
      sourcePath,
      deployAfterImport: true,
    });
    await expect(
      runExpectedJob(store, "w", { projectId: project.id, type: "import_source", id: resync.id }),
    ).resolves.toMatchObject({ id: resync.id, status: "completed" });

    // The queued build is not the follow-up of some other import.
    await expect(
      runExpectedJob(store, "w", {
        projectId: project.id,
        type: "build_deploy",
        parentJobId: "job_someoneelse",
      }),
    ).rejects.toThrow(
      new RegExp(
        `claimed build_deploy \\S+ \\(project ${project.id}, parent ${resync.id}\\) instead`,
      ),
    );
  });

  test("names the job that was claimed instead and prints the job table", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Wrong Claim Agent", importKind: "zip" });

    const failure = runExpectedJob(store, "w", { projectId: project.id, type: "build_deploy" });

    await expect(failure).rejects.toThrow(/claimed import_source job_\S+ .*instead\./);
    await expect(failure).rejects.toThrow(
      /Jobs for project \S+:\n  job_\S+ import_source status=running/,
    );
  });

  test("surfaces a failed job's lastError instead of reporting that it ran", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Failed Build Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const build = await store.enqueueJob(project.id, "build_deploy");

    const failure = runExpectedJob(store, "w", {
      projectId: project.id,
      type: "build_deploy",
      id: build.id,
    });

    await expect(failure).rejects.toThrow(`settled failed, expected completed.`);
    await expect(failure).rejects.toThrow(
      `${build.id} build_deploy status=failed attempts=1 created=${build.createdAt} lastError="Project ${project.id} has no source revision to deploy."`,
    );
    await expect(failure).rejects.toThrow(/\[runtime\] Job \S+ failed: Project \S+ has no source/);
  });

  test("returns an expected failure for a harness proving a failure path", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Expected Failure Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "build_deploy");

    await expect(
      runExpectedJob(store, "w", { projectId: project.id, type: "build_deploy", status: "failed" }),
    ).resolves.toMatchObject({ status: "failed", lastError: expect.stringContaining("no source") });
  });

  test("reports an empty queue with the job table", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Empty Queue Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);

    await expect(
      runExpectedJob(store, "w", { projectId: project.id, type: "build_deploy" }),
    ).rejects.toThrow(
      /no claimable job\.\nJobs for project \S+:\n  \S+ import_source status=completed/,
    );
  });
});
