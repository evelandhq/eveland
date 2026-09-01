import { eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { projects } from "./schema.js";
import { JOB_QUEUE_CHANNEL } from "./job-queue-listener.js";
import { createPgliteTestStore } from "./test-store.js";
import { createTestStore } from "./vitest-store.js";

describe("SQL Store project creation", () => {
  test("lists newest-created projects first with deterministic name and id tie-breakers", async () => {
    const database = await createPgliteTestStore();

    try {
      const beta = await database.store.createProject({
        name: "beta-agent",
        importKind: "zip",
      });
      const alpha = await database.store.createProject({
        name: "alpha-agent",
        importKind: "zip",
      });
      const recent = await database.store.createProject({
        name: "recent-agent",
        importKind: "zip",
      });
      const firstDuplicate = await database.store.createProject({
        name: "duplicate-one",
        importKind: "zip",
      });
      const secondDuplicate = await database.store.createProject({
        name: "duplicate-two",
        importKind: "zip",
      });
      const sharedCreatedAt = new Date("2026-07-29T08:00:00.000Z");
      const duplicateIds = [firstDuplicate.id, secondDuplicate.id].sort();

      await database.db.update(projects).set({
        createdAt: sharedCreatedAt,
        updatedAt: sharedCreatedAt,
      });
      await database.db
        .update(projects)
        .set({ name: "duplicate-agent" })
        .where(inArray(projects.id, duplicateIds));
      await database.db
        .update(projects)
        .set({
          createdAt: new Date("2026-07-30T08:00:00.000Z"),
          updatedAt: new Date("2026-07-30T08:00:00.000Z"),
        })
        .where(eq(projects.id, recent.id));
      await database.db
        .update(projects)
        .set({ updatedAt: new Date("2026-07-31T08:00:00.000Z") })
        .where(eq(projects.id, beta.id));

      const listedProjects = await database.store.listProjects();

      expect(listedProjects.map((project) => project.id)).toEqual([
        recent.id,
        alpha.id,
        beta.id,
        ...duplicateIds,
      ]);
    } finally {
      await database.close();
    }
  });

  test("reserves an exact slug and carries the initial auto-deploy intent into the import job", async () => {
    const store = createTestStore();

    const project = await store.createProject({
      name: "first-deploy",
      importKind: "git",
      gitUrl: "https://github.com/example/first-deploy.git",
      requireExactSlug: true,
      deployAfterImport: true,
    });

    await expect(store.claimNextJob("worker-a")).resolves.toMatchObject({
      projectId: project.id,
      type: "import_source",
      payload: { deployAfterImport: true },
    });
    await expect(
      store.createProject({
        name: "first-deploy",
        importKind: "git",
        gitUrl: "https://github.com/example/first-deploy.git",
        requireExactSlug: true,
      }),
    ).rejects.toThrow("Project name is already in use.");
  });

  test("checks exact project slug availability", async () => {
    const store = createTestStore();

    await expect(store.isProjectSlugAvailable("available-agent")).resolves.toBe(true);
    await store.createProject({ name: "available-agent", importKind: "zip" });
    await expect(store.isProjectSlugAvailable("available-agent")).resolves.toBe(false);
  });
});

describe("SQL Store Git credentials", () => {
  test("keeps one encrypted credential per user and normalized host", async () => {
    const store = createTestStore();

    const created = await store.upsertGitCredential(
      "user_one",
      "gitlab.example.com",
      "encrypted-one",
    );
    await store.upsertGitCredential("user_two", "gitlab.example.com", "encrypted-two");
    const updated = await store.upsertGitCredential(
      "user_one",
      "gitlab.example.com",
      "encrypted-new",
    );

    expect(updated.id).toBe(created.id);
    await expect(store.getGitCredential("user_one", "gitlab.example.com")).resolves.toMatchObject({
      encryptedToken: "encrypted-new",
    });
    await expect(store.listGitCredentials("user_one")).resolves.toEqual([
      expect.objectContaining({ host: "gitlab.example.com" }),
    ]);
    expect(JSON.stringify(await store.listGitCredentials("user_one"))).not.toContain(
      "encrypted-new",
    );
    await expect(store.deleteGitCredential("user_one", created.id)).resolves.toBe(true);
    await expect(store.getGitCredential("user_one", "gitlab.example.com")).resolves.toBeNull();
    await expect(store.getGitCredential("user_two", "gitlab.example.com")).resolves.toMatchObject({
      encryptedToken: "encrypted-two",
    });
  });
});

describe("SQL Store jobs", () => {
  test("lists a project's jobs newest first", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Visible Jobs Agent",
      importKind: "git",
      gitUrl: "https://example.com/agent.git",
    });
    const initialImport = await store.claimNextJob("worker-a");
    await store.completeJob(initialImport!.id);
    const latest = await store.enqueueJob(project.id, "build_deploy");
    await store.createProject({ name: "Other Jobs Agent", importKind: "zip" });

    await expect(store.listProjectJobs(project.id)).resolves.toEqual([
      latest,
      expect.objectContaining({ id: initialImport!.id, projectId: project.id }),
    ]);
  });

  test("filters project jobs before applying the result limit", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Filtered Jobs Agent",
      importKind: "git",
      gitUrl: "https://example.com/agent.git",
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    for (let index = 0; index < 25; index += 1) await store.enqueueJob(project.id, "build_deploy");

    await expect(
      store.listProjectJobs(project.id, { type: "import_source", limit: 1 }),
    ).resolves.toEqual([expect.objectContaining({ id: importJob!.id, type: "import_source" })]);
  });

  test("enqueues at most one active archive job for a deployment", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Archive Once Agent",
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/archive-once",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "archive-once:release",
      containerName: "archive-once-release",
      internalPort: 3000,
      hostPort: 41910,
      runtimeKind: "systemd",
    });

    const first = await store.enqueueDeploymentArchive(project.id, deployment.id);
    const duplicate = await store.enqueueDeploymentArchive(project.id, deployment.id);

    expect(first).toMatchObject({ created: true });
    expect(duplicate).toMatchObject({
      created: false,
      job: { id: first.job.id },
    });
    await expect(
      store.listProjectJobs(project.id, {
        type: "archive_deployment",
        limit: 10,
      }),
    ).resolves.toHaveLength(1);
  });

  test("marks a project as deleting and replaces queued work with one deletion job", async () => {
    const store = createTestStore();
    const pendingSourcePath = "/data/uploads/zip-pending/source";
    const project = await store.createProject({
      name: "Delete Agent",
      importKind: "zip",
      sourcePath: pendingSourcePath,
    });
    await store.enqueueJob(project.id, "build_deploy");

    const requestProjectDeletion = Reflect.get(store, "requestProjectDeletion");

    expect(requestProjectDeletion).toBeTypeOf("function");
    const result = await requestProjectDeletion.call(store, project.id);
    expect(result).toMatchObject({
      outcome: "queued",
      job: {
        projectId: project.id,
        type: "delete_project",
        status: "queued",
        payload: { sourcePaths: [pendingSourcePath] },
      },
    });
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deletionStatus: "deleting",
      deletionError: null,
    });
    await expect(store.claimNextJob("worker-a")).resolves.toMatchObject({ type: "delete_project" });
    await expect(store.claimNextJob("worker-b")).resolves.toBeNull();
  });

  test("rejects a duplicate deletion request without enqueueing another job", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Delete Once Agent", importKind: "zip" });

    await store.requestProjectDeletion(project.id);
    const duplicate = await store.requestProjectDeletion(project.id);

    expect(duplicate).toEqual({ outcome: "already_deleting" });
    await expect(store.claimNextJob("worker-a")).resolves.toMatchObject({ type: "delete_project" });
    await expect(store.claimNextJob("worker-b")).resolves.toBeNull();
  });

  test("records deletion failure details and clears them when deletion is retried", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Retry Delete Agent", importKind: "zip" });
    await store.requestProjectDeletion(project.id);

    const setProjectDeletionFailed = Reflect.get(store, "setProjectDeletionFailed");

    expect(setProjectDeletionFailed).toBeTypeOf("function");
    await setProjectDeletionFailed.call(store, project.id, "runtime unavailable");
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deletionStatus: "failed",
      deletionError: "runtime unavailable",
    });

    await expect(store.requestProjectDeletion(project.id)).resolves.toMatchObject({
      outcome: "queued",
    });
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deletionStatus: "deleting",
      deletionError: null,
    });
  });

  test("waits for running project work before claiming its deletion job", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Busy Delete Agent", importKind: "zip" });
    const running = await store.claimNextJob("worker-a");
    await store.requestProjectDeletion(project.id);
    const otherProject = await store.createProject({ name: "Other Agent", importKind: "zip" });

    const whileBusy = await store.claimNextJob("worker-b");

    expect(whileBusy).toMatchObject({ projectId: otherProject.id, type: "import_source" });
    await store.completeJob(running!.id);
    await expect(store.claimNextJob("worker-c")).resolves.toMatchObject({
      projectId: project.id,
      type: "delete_project",
    });
  });

  test("serializes the source-and-release lane and unknown-target restarts per project", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Serial Agent", importKind: "zip" });
    const running = await store.claimNextJob("worker-a");
    expect(running).toMatchObject({ projectId: project.id, type: "import_source" });
    await store.enqueueJob(project.id, "build_deploy");
    // No deploymentId: the restart resolves the production Deployment at run
    // time, so its target is unknown at claim time and it stays exclusive.
    await store.enqueueJob(project.id, "restart_deployment");

    // The queued build waits for the running import; the unknown-target
    // restart waits for any running job in the project.
    await expect(store.claimNextJob("worker-b")).resolves.toBeNull();

    // A different project is not blocked by this project's running job.
    const otherProject = await store.createProject({ name: "Parallel Agent", importKind: "zip" });
    await expect(store.claimNextJob("worker-b")).resolves.toMatchObject({
      projectId: otherProject.id,
      type: "import_source",
    });

    // Completion unblocks the oldest queued job for the project -- one at a time.
    await store.completeJob(running!.id);
    const next = await store.claimNextJob("worker-c");
    expect(next).toMatchObject({ projectId: project.id, type: "build_deploy" });
    await expect(store.claimNextJob("worker-d")).resolves.toBeNull();
  });

  test("claims session-critical Deployment jobs past the same project's running build", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Cold Session Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "build_deploy");
    const build = await store.claimNextJob("worker-a");
    expect(build).toMatchObject({ projectId: project.id, type: "build_deploy" });

    // The idle-reaped stable Deployment's activation and a schedule dispatch
    // target existing Deployments the build never touches, so neither waits
    // out the minutes-long build (issue #448).
    await store.enqueueJob(project.id, "ensure_deployment_running", {
      deploymentId: "dep_stable",
      runtimeInstanceId: "ri_session",
    });
    await store.enqueueJob(project.id, "trigger_schedule", {
      scheduleRunId: "srun_due",
      deploymentId: "dep_preview",
    });
    await expect(store.claimNextJob("worker-b")).resolves.toMatchObject({
      type: "ensure_deployment_running",
    });
    await expect(store.claimNextJob("worker-c")).resolves.toMatchObject({
      type: "trigger_schedule",
    });

    // The source-and-release lane itself still serializes behind the build.
    await store.enqueueJob(project.id, "build_deploy");
    await expect(store.claimNextJob("worker-d")).resolves.toBeNull();
  });

  test("serializes jobs targeting the same Deployment", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Same Target Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "ensure_deployment_running", {
      deploymentId: "dep_a",
      runtimeInstanceId: "ri_a",
    });
    const activation = await store.claimNextJob("worker-a");
    expect(activation).toMatchObject({ type: "ensure_deployment_running" });

    // Same Deployment: archive and restart wait for the running activation.
    await store.enqueueJob(project.id, "archive_deployment", { deploymentId: "dep_a" });
    await store.enqueueJob(project.id, "restart_deployment", { deploymentId: "dep_a" });
    await expect(store.claimNextJob("worker-b")).resolves.toBeNull();

    // A different Deployment of the same project is not blocked.
    await store.enqueueJob(project.id, "archive_deployment", { deploymentId: "dep_b" });
    await expect(store.claimNextJob("worker-b")).resolves.toMatchObject({
      type: "archive_deployment",
      payload: { deploymentId: "dep_b" },
    });

    // Completion unblocks the oldest queued job for dep_a -- one at a time.
    await store.completeJob(activation!.id);
    await expect(store.claimNextJob("worker-c")).resolves.toMatchObject({
      type: "archive_deployment",
      payload: { deploymentId: "dep_a" },
    });
    await expect(store.claimNextJob("worker-d")).resolves.toBeNull();
  });

  test("treats a Deployment job without a claim-time target as project-exclusive", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Unknown Target Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "restart_deployment");
    const restart = await store.claimNextJob("worker-a");
    expect(restart).toMatchObject({ type: "restart_deployment" });

    // The running restart's target is unknown, so even a Deployment-scoped
    // activation waits.
    await store.enqueueJob(project.id, "ensure_deployment_running", {
      deploymentId: "dep_a",
      runtimeInstanceId: "ri_a",
    });
    await expect(store.claimNextJob("worker-b")).resolves.toBeNull();
    await store.completeJob(restart!.id);
    const activation = await store.claimNextJob("worker-b");
    expect(activation).toMatchObject({ type: "ensure_deployment_running" });

    // And the reverse: an unknown-target candidate waits for any running job.
    await store.enqueueJob(project.id, "restart_deployment");
    await expect(store.claimNextJob("worker-c")).resolves.toBeNull();
  });

  test("keeps a legacy trigger_schedule without a denormalized target project-exclusive", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Legacy Trigger Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    await store.enqueueJob(project.id, "build_deploy");
    const build = await store.claimNextJob("worker-a");
    expect(build).toMatchObject({ type: "build_deploy" });

    // Enqueued before deploymentId was denormalized into the payload: the
    // claim SQL cannot see its target, so it conservatively waits.
    await store.enqueueJob(project.id, "trigger_schedule", { scheduleRunId: "srun_legacy" });
    await expect(store.claimNextJob("worker-b")).resolves.toBeNull();
    await store.completeJob(build!.id);
    await expect(store.claimNextJob("worker-b")).resolves.toMatchObject({
      type: "trigger_schedule",
    });
  });

  test("a running delete_project blocks every candidate without the deletion-status gate", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Direct Delete Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    // Enqueued directly, without requestProjectDeletion marking the project
    // deleting, so only the running-job exclusion arm is in play.
    await store.enqueueJob(project.id, "delete_project");
    const deletion = await store.claimNextJob("worker-a");
    expect(deletion).toMatchObject({ type: "delete_project" });

    await store.enqueueJob(project.id, "ensure_deployment_running", {
      deploymentId: "dep_a",
      runtimeInstanceId: "ri_a",
    });
    await expect(store.claimNextJob("worker-b")).resolves.toBeNull();
  });

  test("claims queued jobs once and tracks completion", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Worker Agent", importKind: "zip" });
    await store.enqueueJob(project.id, "build_deploy");

    const first = await store.claimNextJob("worker-a");

    expect(first).toMatchObject({ type: "import_source", status: "running", attempts: 1 });
    // Same project: the queued build_deploy waits for the running import.
    await expect(store.claimNextJob("worker-b")).resolves.toBeNull();
    await store.completeJob(first!.id);

    const second = await store.claimNextJob("worker-b");
    expect(second).toMatchObject({ type: "build_deploy", status: "running", attempts: 1 });
    await store.completeJob(second!.id);

    const none = await store.claimNextJob("worker-c");
    expect(none).toBeNull();
  });

  test("stops claiming builds at the heavy-job cap while light jobs stay claimable", async () => {
    const store = createTestStore();
    const buildProjects = [];
    for (const name of ["Heavy Agent One", "Heavy Agent Two"]) {
      const project = await store.createProject({ name, importKind: "zip" });
      const importJob = await store.claimNextJob("worker-a");
      await store.completeJob(importJob!.id);
      buildProjects.push(project);
    }
    const lightProject = await store.createProject({ name: "Light Agent", importKind: "zip" });
    const lightImport = await store.claimNextJob("worker-a");
    await store.completeJob(lightImport!.id);
    await store.enqueueJob(buildProjects[0]!.id, "build_deploy");
    await store.enqueueJob(buildProjects[1]!.id, "build_deploy");
    await store.enqueueJob(lightProject.id, "restart_deployment");

    const capped = { maxConcurrentHeavyJobs: 1 };
    const firstBuild = await store.claimNextJob("worker-a", undefined, capped);
    expect(firstBuild).toMatchObject({ projectId: buildProjects[0]!.id, type: "build_deploy" });

    // The cap is reached: the older queued build is skipped, the light job is not.
    await expect(store.claimNextJob("worker-b", undefined, capped)).resolves.toMatchObject({
      projectId: lightProject.id,
      type: "restart_deployment",
    });
    await expect(store.claimNextJob("worker-c", undefined, capped)).resolves.toBeNull();

    // Completing the running build releases the budget for the next one.
    await store.completeJob(firstBuild!.id);
    await expect(store.claimNextJob("worker-c", undefined, capped)).resolves.toMatchObject({
      projectId: buildProjects[1]!.id,
      type: "build_deploy",
    });
  });

  test("an unset heavy-job cap leaves builds unlimited", async () => {
    const store = createTestStore();
    const projects = [];
    for (const name of ["Uncapped Agent One", "Uncapped Agent Two"]) {
      const project = await store.createProject({ name, importKind: "zip" });
      const importJob = await store.claimNextJob("worker-a");
      await store.completeJob(importJob!.id);
      projects.push(project);
    }
    for (const project of projects) {
      await store.enqueueJob(project.id, "build_deploy");
    }

    await expect(store.claimNextJob("worker-a")).resolves.toMatchObject({
      projectId: projects[0]!.id,
      type: "build_deploy",
    });
    await expect(store.claimNextJob("worker-b")).resolves.toMatchObject({
      projectId: projects[1]!.id,
      type: "build_deploy",
    });
  });

  test("enqueues notify the job-queue channel so an idle worker wakes immediately", async () => {
    const database = await createPgliteTestStore();
    try {
      const payloads: string[] = [];
      await database.client.listen(JOB_QUEUE_CHANNEL, (payload) => payloads.push(payload));

      const project = await database.store.createProject({
        name: "Notify Agent",
        importKind: "zip",
      });
      await database.store.enqueueJob(project.id, "build_deploy");
      await new Promise((resolve) => setTimeout(resolve, 0));

      // createProject enqueues the initial import_source; both inserts notify.
      expect(payloads).toEqual(["import_source", "build_deploy"]);
    } finally {
      await database.close();
    }
  });

  test("claims latency-sensitive jobs ahead of older queued work from other projects", async () => {
    const store = createTestStore();
    const settled = [];
    for (const name of ["Backlog Agent", "Session Agent", "Schedule Agent"]) {
      const project = await store.createProject({ name, importKind: "zip" });
      const importJob = await store.claimNextJob("worker-a");
      await store.completeJob(importJob!.id);
      settled.push(project);
    }
    const [backlogProject, sessionProject, scheduleProject] = settled;
    // Oldest first: a build backlog, then the session-critical jobs behind it.
    await store.enqueueJob(backlogProject!.id, "build_deploy");
    await store.enqueueJob(sessionProject!.id, "ensure_deployment_running", {
      deploymentId: "dep_session",
      runtimeInstanceId: "ri_session",
    });
    await store.enqueueJob(scheduleProject!.id, "trigger_schedule", {
      scheduleRunId: "srun_priority",
    });

    // Activation and schedule dispatch race Eve's 30-second command-hook wait,
    // so they jump the created_at queue; among themselves FIFO still holds.
    await expect(store.claimNextJob("worker-a")).resolves.toMatchObject({
      projectId: sessionProject!.id,
      type: "ensure_deployment_running",
    });
    await expect(store.claimNextJob("worker-b")).resolves.toMatchObject({
      projectId: scheduleProject!.id,
      type: "trigger_schedule",
    });
    await expect(store.claimNextJob("worker-c")).resolves.toMatchObject({
      projectId: backlogProject!.id,
      type: "build_deploy",
    });
  });

  test("rejects a non-positive heavy-job cap instead of silently uncapping", async () => {
    const store = createTestStore();

    await expect(
      store.claimNextJob("worker-a", undefined, { maxConcurrentHeavyJobs: 0 }),
    ).rejects.toThrow("Heavy-job concurrency cap must be a positive integer.");
    await expect(
      store.claimNextJob("worker-a", undefined, { maxConcurrentHeavyJobs: Number.NaN }),
    ).rejects.toThrow("Heavy-job concurrency cap must be a positive integer.");
  });

  test("recovers a running job after its lease becomes stale", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Recover Job Agent", importKind: "zip" });
    const startedAt = new Date("2026-07-17T00:00:00.000Z");
    const firstClaim = await store.claimNextJob("worker-a", startedAt);

    await expect(
      store.recoverStaleJobs(new Date("2026-07-17T00:01:00.000Z"), 30_000),
    ).resolves.toBe(1);
    await expect(
      store.claimNextJob("worker-b", new Date("2026-07-17T00:01:01.000Z")),
    ).resolves.toMatchObject({
      id: firstClaim!.id,
      projectId: project.id,
      status: "running",
      attempts: 2,
    });
  });

  test("keeps a running job leased when its current attempt heartbeats", async () => {
    const store = createTestStore();
    await store.createProject({ name: "Heartbeat Job Agent", importKind: "zip" });
    const job = await store.claimNextJob("worker-a", new Date("2026-07-17T00:00:00.000Z"));

    await expect(
      store.heartbeatJob(job!.id, job!.attempts, new Date("2026-07-17T00:00:20.000Z")),
    ).resolves.toBe(true);
    await expect(
      store.recoverStaleJobs(new Date("2026-07-17T00:00:40.000Z"), 30_000),
    ).resolves.toBe(0);
  });

  test("rejects completion from an attempt that lost its lease", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Fenced Job Agent", importKind: "zip" });
    const first = await store.claimNextJob("worker-a", new Date("2026-07-17T00:00:00.000Z"));
    const firstAttempt = first!.attempts;
    await store.recoverStaleJobs(new Date("2026-07-17T00:01:00.000Z"), 30_000);
    const second = await store.claimNextJob("worker-b", new Date("2026-07-17T00:01:01.000Z"));

    await expect(store.completeJob(first!.id, firstAttempt)).resolves.toBe(false);
    await expect(store.listProjectJobs(project.id)).resolves.toContainEqual(
      expect.objectContaining({ id: second!.id, status: "running", attempts: 2 }),
    );
    await expect(store.completeJob(second!.id, second!.attempts)).resolves.toBe(true);
  });

  test("rejects failure from an attempt that lost its lease", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Fenced Failure Agent", importKind: "zip" });
    const first = await store.claimNextJob("worker-a", new Date("2026-07-17T00:00:00.000Z"));
    const firstAttempt = first!.attempts;
    await store.recoverStaleJobs(new Date("2026-07-17T00:01:00.000Z"), 30_000);
    await store.claimNextJob("worker-b", new Date("2026-07-17T00:01:01.000Z"));

    await expect(store.failJob(first!.id, "late failure", firstAttempt)).resolves.toBe(false);
    await expect(store.listProjectJobs(project.id)).resolves.toContainEqual(
      expect.objectContaining({ id: first!.id, status: "running", attempts: 2, lastError: null }),
    );
  });

  test("records failure details on a claimed job", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Fail Agent", importKind: "zip" });
    const job = await store.claimNextJob("worker-a");

    await store.failJob(job!.id, "boom");

    const next = await store.enqueueJob(project.id, "restart_deployment");
    expect(next.status).toBe("queued");
  });

  test("updates project state and appends logs for worker processors", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Import Agent", importKind: "zip" });

    const updated = await store.updateProjectState(project.id, { status: "imported" });
    const log = await store.appendLog({
      projectId: project.id,
      type: "build",
      line: "source imported",
    });

    expect(updated).toMatchObject({ id: project.id, status: "imported" });
    await expect(store.listLogs(project.id)).resolves.toEqual([log]);

    // Bounded reads: a tail without `after`, forward pages with it — always
    // in insertion order.
    const second = await store.appendLog({
      projectId: project.id,
      type: "build",
      line: "second line",
    });
    const third = await store.appendLog({
      projectId: project.id,
      type: "build",
      line: "third line",
    });

    const tail = await store.listLogsPage(project.id, undefined, { limit: 2 });
    expect(tail.logs).toEqual([second, third]);

    const fromStart = await store.listLogsPage(project.id, undefined, { limit: 1, after: "0" });
    expect(fromStart.logs).toEqual([log]);
    const nextPage = await store.listLogsPage(project.id, undefined, {
      limit: 10,
      after: fromStart.cursor,
    });
    expect(nextPage.logs).toEqual([second, third]);
    // Caught up: the cursor stays put and pages come back empty, not replayed.
    const caughtUp = await store.listLogsPage(project.id, undefined, {
      limit: 10,
      after: nextPage.cursor,
    });
    expect(caughtUp.logs).toEqual([]);
    expect(caughtUp.cursor).toBe(nextPage.cursor);

    // EVERY page hands back a usable cursor, including an empty one: a
    // follower that starts before any log exists gets a watermark, and lines
    // written afterwards are all visible from it — never silently skipped,
    // never an unbounded re-read (the review case where more than one page
    // of lines lands between the empty first poll and the next).
    const fresh = await store.createProject({ name: "Fresh Agent", importKind: "zip" });
    const empty = await store.listLogsPage(fresh.id, "build", { limit: 5 });
    expect(empty.logs).toEqual([]);
    // Constant 0, not a max(seq) snapshot: a separate watermark query could
    // race a commit landing between the two reads and skip it forever.
    expect(empty.cursor).toBe("0");
    const later = await store.appendLog({ projectId: fresh.id, type: "build", line: "born" });
    const sinceEmpty = await store.listLogsPage(fresh.id, "build", {
      limit: 10,
      after: empty.cursor,
    });
    expect(sinceEmpty.logs).toEqual([later]);
  });

  test("records current source revision, source files, and schedules", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Source Agent", importKind: "git" });

    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      commitSha: "abc123",
      sourcePath: "/tmp/source",
      summary: { tools: ["agent/tools/get_weather.ts"] },
      envVars: ["OPENAI_API_KEY"],
      files: [{ path: "agent/instructions.md", content: "You are concise." }],
      schedules: [
        {
          name: "daily",
          kind: "markdown",
          cron: "0 8 * * *",
          timezone: "UTC",
          enabled: true,
          executable: true,
          sourcePath: "agent/schedules/daily.md",
          nextRunAt: "2026-07-01T08:00:00.000Z",
        },
      ],
    });

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      sourceRevisionId: revision.id,
      status: "imported",
    });
    await expect(store.getCurrentSourceRevision(project.id)).resolves.toMatchObject({
      id: revision.id,
      commitSha: "abc123",
    });
    await expect(store.getSourceFile(project.id, "agent/instructions.md")).resolves.toMatchObject({
      content: "You are concise.",
    });
    await expect(store.listSchedules(project.id)).resolves.toEqual([
      expect.objectContaining({ name: "daily" }),
    ]);
  });

  test("leaves the previous revision and schedules intact when a later step fails", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Atomic Source Agent", importKind: "git" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      commitSha: "good-commit",
      sourcePath: "/tmp/source-good",
      summary: {},
      envVars: [],
      files: [{ path: "agent/instructions.md", content: "Keep me." }],
      schedules: [
        {
          name: "daily",
          kind: "markdown",
          cron: "0 8 * * *",
          timezone: "UTC",
          enabled: true,
          executable: true,
          sourcePath: "agent/schedules/daily.md",
          nextRunAt: "2026-07-01T08:00:00.000Z",
        },
      ],
    });

    // The import contract is all-or-nothing. Recording a revision deletes the
    // project's schedules before reinserting them, so a failure after that
    // point used to leave the project with no schedules and a source pointer
    // that disagrees with what is actually stored.
    await expect(
      store.recordSourceRevision({
        projectId: project.id,
        kind: "git",
        commitSha: "bad-commit",
        sourcePath: "/tmp/source-bad",
        summary: {},
        envVars: [],
        files: [],
        schedules: [
          {
            name: "broken",
            kind: "markdown",
            cron: "0 9 * * *",
            timezone: "UTC",
            enabled: true,
            executable: true,
            sourcePath: null as unknown as string,
            nextRunAt: null,
          },
        ],
      }),
    ).rejects.toThrow();

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      sourceRevisionId: revision.id,
    });
    await expect(store.getCurrentSourceRevision(project.id)).resolves.toMatchObject({
      commitSha: "good-commit",
    });
    await expect(store.listSchedules(project.id)).resolves.toEqual([
      expect.objectContaining({ name: "daily" }),
    ]);
    await expect(store.listSourceRevisions(project.id)).resolves.toHaveLength(1);
  });

  test("advances current source without replacing an existing deployment", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Resync Agent", importKind: "git" });
    const initialRevision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      commitSha: "old-commit",
      sourcePath: "/tmp/source-old",
      summary: {},
      envVars: [],
      files: [{ path: "agent/instructions.md", content: "Old instructions" }],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: initialRevision.id,
      imageTag: "eveland/resync:old",
      containerName: "eveland-resync-old",
      internalPort: 3000,
      hostPort: 41002,
      runtimeKind: "docker",
    });

    const nextRevision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      commitSha: "new-commit",
      sourcePath: "/tmp/source-new",
      summary: {},
      envVars: [],
      files: [{ path: "agent/instructions.md", content: "New instructions" }],
      schedules: [],
    });

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "deployed",
      deploymentStatus: "running",
      deploymentId: deployment.id,
      sourceRevisionId: nextRevision.id,
    });
    await expect(store.getCurrentSourceRevision(project.id)).resolves.toMatchObject({
      id: nextRevision.id,
      commitSha: "new-commit",
    });
    await expect(store.getSourceFile(project.id, "agent/instructions.md")).resolves.toMatchObject({
      content: "New instructions",
    });
  });

  test("records the current release and deployment for a project", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Deploy Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });

    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_123",
      containerName: "eveland-proj-dep_123",
      internalPort: 3000,
      hostPort: 41001,
      runtimeKind: "docker",
    });

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      status: "deployed",
      deploymentStatus: "running",
      releaseId: deployment.releaseId,
      deploymentId: deployment.id,
    });
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({
      id: deployment.id,
      releaseId: deployment.releaseId,
      containerName: "eveland-proj-dep_123",
      hostPort: 41001,
      runtimeKind: "docker",
    });
  });

  test("round-trips runtimeKind through recordDeployment for the systemd adapter", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Systemd Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });

    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_456",
      containerName: "eveland-proj-dep_456",
      internalPort: 3000,
      hostPort: 41002,
      runtimeKind: "systemd",
    });

    expect(deployment.runtimeKind).toBe("systemd");
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({
      runtimeKind: "systemd",
    });
  });

  test("resolves Eve version from the deployment's immutable source revision", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Versioned Agent", importKind: "zip" });
    const oldRevision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source-old",
      summary: {},
      envVars: [],
      files: [
        { path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.22.6" } }) },
      ],
      schedules: [],
    });
    const oldDeployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: oldRevision.id,
      imageTag: "eveland/proj:old",
      containerName: "eveland-proj-old",
      internalPort: 3000,
      hostPort: 41004,
      runtimeKind: "docker",
    });
    await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source-new",
      summary: { eveVersion: "0.34.5" },
      envVars: [],
      files: [
        { path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.34.5" } }) },
      ],
      schedules: [],
    });

    await expect(store.getDeploymentEveVersion(oldDeployment.id)).resolves.toEqual({
      version: "0.22.6",
      expected: "0.45.x or 0.47.x",
      supportedRanges: ["0.45.x", "0.47.x"],
      supported: false,
      sourceRevisionId: oldRevision.id,
    });
  });

  test("prefers the release's resolved Eve version over the revision's declared specifier", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Resolved Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: { eveVersion: "~0.37.0" },
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:resolved",
      summary: { summarySource: "build-manifest", eveVersionResolved: "0.45.2" },
      containerName: "eveland-proj-resolved",
      internalPort: 3000,
      hostPort: 41014,
      runtimeKind: "docker",
    });

    // The build installed a concrete version; the gate reads it instead of
    // the declared range the import scan captured.
    await expect(store.getDeploymentEveVersion(deployment.id)).resolves.toMatchObject({
      version: "0.45.2",
      supported: true,
      sourceRevisionId: revision.id,
    });
  });

  test("getRelease returns the release by id and null when absent", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Release Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_789",
      containerName: "eveland-proj-dep_789",
      internalPort: 3000,
      hostPort: 41003,
      runtimeKind: "docker",
    });

    await expect(store.getRelease(deployment.releaseId)).resolves.toMatchObject({
      id: deployment.releaseId,
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "eveland/proj:rel_789",
    });
    await expect(store.getRelease("rel_does_not_exist")).resolves.toBeNull();
  });

  test("getSourceRevision returns the revision by id and null when absent", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Revision Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });

    await expect(store.getSourceRevision(revision.id)).resolves.toMatchObject({
      id: revision.id,
      projectId: project.id,
      sourcePath: "/tmp/source",
    });
    await expect(store.getSourceRevision("src_does_not_exist")).resolves.toBeNull();
  });

  test("deleteProject cascades to the project's source revision, source files, session events, and usage events", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Deletable Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source",
      summary: {},
      envVars: [],
      files: [{ path: "agent/instructions.md", content: "You are concise." }],
      schedules: [],
    });
    const session = await store.createSession({
      projectId: project.id,
      deploymentId: null,
      trigger: "playground",
      scheduleId: null,
    });
    await store.appendSessionEvent(session.id, "message", { role: "user", content: "Hello" });
    await store.recordModelUsage(session.id, {
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      costUsd: 0.0042,
      usageReported: true,
    });

    await expect(store.deleteProject(project.id)).resolves.toBe(true);

    await expect(store.getProject(project.id)).resolves.toBeNull();
    // The behavioral divergence this guards against: getSourceRevision looks
    // revisions up directly by id (unlike getCurrentSourceRevision, which
    // requires the project row), so a deleted project's revision must not
    // still be findable here the way it would be in Postgres.
    await expect(store.getSourceRevision(revision.id)).resolves.toBeNull();
    await expect(store.listSessionEvents(session.id)).resolves.toEqual([]);
    await expect(store.listModelUsageEvents(session.id)).resolves.toEqual([]);
  });

  test("records a playground session timeline in event order", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Session Agent", importKind: "zip" });

    const session = await store.createSession({
      projectId: project.id,
      deploymentId: "dep_123",
      trigger: "playground",
      scheduleId: null,
    });
    await store.appendSessionEvent(session.id, "message", { role: "user", content: "Hello" });
    await store.appendSessionEvent(session.id, "model_response", { content: "Hi" });
    const completed = await store.completeSession(session.id, {
      status: "completed",
      eveSessionId: "eve_123",
    });

    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        id: session.id,
        status: "completed",
        eveSessionId: "eve_123",
        completedAt: expect.any(String),
      }),
    ]);
    await expect(store.listSessionEvents(session.id)).resolves.toEqual([
      expect.objectContaining({
        index: 0,
        type: "message",
        payload: { role: "user", content: "Hello" },
      }),
      expect.objectContaining({ index: 1, type: "model_response", payload: { content: "Hi" } }),
    ]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      latestSessionStatus: "completed",
    });
    expect(completed).toMatchObject({ id: session.id, status: "completed" });
  });

  test("stores a failure reason with `failed`, preserves it when omitted, clears it on recovery", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Failure Reason Agent", importKind: "zip" });
    const session = await store.createSession({ projectId: project.id, trigger: "playground" });

    await store.completeSession(session.id, {
      status: "failed",
      error: "The turn never reached the agent: connect ECONNREFUSED \u0000 127.0.0.1:4080",
    });
    await expect(store.getSession(session.id)).resolves.toMatchObject({
      status: "failed",
      // NUL sanitized on the way in, like every externally-fed error column.
      error: "The turn never reached the agent: connect ECONNREFUSED � 127.0.0.1:4080",
    });

    // A failed write without a reason must not erase one recorded earlier.
    await store.completeSession(session.id, { status: "failed" });
    await expect(store.getSession(session.id)).resolves.toMatchObject({
      error: "The turn never reached the agent: connect ECONNREFUSED � 127.0.0.1:4080",
    });

    // A later successful turn clears the stale reason with the status.
    await store.completeSession(session.id, { status: "running", eveSessionId: "eve_retry" });
    await expect(store.getSession(session.id)).resolves.toMatchObject({
      status: "running",
      error: null,
    });
  });

  test("records a model step and updates the session token totals", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Usage Agent", importKind: "zip" });
    const session = await store.createSession({
      projectId: project.id,
      deploymentId: "dep_usage",
      trigger: "playground",
    });

    const usageEvent = await store.recordModelUsage(session.id, {
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      costUsd: 0.0042,
      usageReported: true,
    });

    expect(usageEvent).toMatchObject({
      sessionId: session.id,
      turnId: "turn_0",
      stepIndex: 0,
      inputTokens: 120,
    });
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        usage: {
          status: "reported",
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          costUsd: 0.0042,
          reportedSteps: 1,
          missingSteps: 0,
        },
      }),
    ]);
    await expect(store.listModelUsageEvents(session.id)).resolves.toEqual([usageEvent]);
  });

  test("does not count the same completed model step twice", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Replay Agent", importKind: "zip" });
    const session = await store.createSession({ projectId: project.id, trigger: "playground" });
    const step = {
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: true,
    };

    const first = await store.recordModelUsage(session.id, step);
    const replayed = await store.recordModelUsage(session.id, step);

    expect(replayed.id).toBe(first.id);
    await expect(store.listModelUsageEvents(session.id)).resolves.toHaveLength(1);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        usage: expect.objectContaining({ inputTokens: 12, outputTokens: 4, reportedSteps: 1 }),
      }),
    ]);
  });

  test("tracks completed steps whose provider omitted token usage", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Missing Usage Agent", importKind: "zip" });
    const session = await store.createSession({ projectId: project.id, trigger: "playground" });

    await store.recordModelUsage(session.id, {
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: false,
    });

    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        usage: {
          status: "missing",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
          reportedSteps: 0,
          missingSteps: 1,
        },
      }),
    ]);
  });
});
