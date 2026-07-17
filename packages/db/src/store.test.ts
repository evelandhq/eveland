import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./store.js";

describe("memory store jobs", () => {
  test("lists a project's jobs newest first", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Visible Jobs Agent", importKind: "git", gitUrl: "https://example.com/agent.git" });
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
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Filtered Jobs Agent", importKind: "git", gitUrl: "https://example.com/agent.git" });
    const importJob = await store.claimNextJob("worker-a");
    await store.completeJob(importJob!.id);
    for (let index = 0; index < 25; index += 1) await store.enqueueJob(project.id, "build_deploy");

    await expect(store.listProjectJobs(project.id, { type: "import_source", limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id: importJob!.id, type: "import_source" }),
    ]);
  });

  test("marks a project as deleting and replaces queued work with one deletion job", async () => {
    const store = createMemoryStore();
    const pendingSourcePath = "/data/uploads/zip-pending/source";
    const project = await store.createProject({ name: "Delete Agent", importKind: "zip", sourcePath: pendingSourcePath });
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
    await expect(store.getProject(project.id)).resolves.toMatchObject({ deletionStatus: "deleting", deletionError: null });
    await expect(store.claimNextJob("worker-a")).resolves.toMatchObject({ type: "delete_project" });
    await expect(store.claimNextJob("worker-b")).resolves.toBeNull();
  });

  test("rejects a duplicate deletion request without enqueueing another job", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Delete Once Agent", importKind: "zip" });

    await store.requestProjectDeletion(project.id);
    const duplicate = await store.requestProjectDeletion(project.id);

    expect(duplicate).toEqual({ outcome: "already_deleting" });
    await expect(store.claimNextJob("worker-a")).resolves.toMatchObject({ type: "delete_project" });
    await expect(store.claimNextJob("worker-b")).resolves.toBeNull();
  });

  test("records deletion failure details and clears them when deletion is retried", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Retry Delete Agent", importKind: "zip" });
    await store.requestProjectDeletion(project.id);

    const setProjectDeletionFailed = Reflect.get(store, "setProjectDeletionFailed");

    expect(setProjectDeletionFailed).toBeTypeOf("function");
    await setProjectDeletionFailed.call(store, project.id, "runtime unavailable");
    await expect(store.getProject(project.id)).resolves.toMatchObject({
      deletionStatus: "failed",
      deletionError: "runtime unavailable",
    });

    await expect(store.requestProjectDeletion(project.id)).resolves.toMatchObject({ outcome: "queued" });
    await expect(store.getProject(project.id)).resolves.toMatchObject({ deletionStatus: "deleting", deletionError: null });
  });

  test("waits for running project work before claiming its deletion job", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Busy Delete Agent", importKind: "zip" });
    const running = await store.claimNextJob("worker-a");
    await store.requestProjectDeletion(project.id);
    const otherProject = await store.createProject({ name: "Other Agent", importKind: "zip" });

    const whileBusy = await store.claimNextJob("worker-b");

    expect(whileBusy).toMatchObject({ projectId: otherProject.id, type: "import_source" });
    await store.completeJob(running!.id);
    await expect(store.claimNextJob("worker-c")).resolves.toMatchObject({ projectId: project.id, type: "delete_project" });
  });

  test("claims queued jobs once and tracks completion", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Worker Agent", importKind: "zip" });
    await store.enqueueJob(project.id, "build_deploy");

    const first = await store.claimNextJob("worker-a");
    const second = await store.claimNextJob("worker-b");

    expect(first).toMatchObject({ type: "import_source", status: "running", attempts: 1 });
    expect(second).toMatchObject({ type: "build_deploy", status: "running", attempts: 1 });
    await store.completeJob(first!.id);

    const none = await store.claimNextJob("worker-c");
    expect(none).toBeNull();
  });

  test("records failure details on a claimed job", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Fail Agent", importKind: "zip" });
    const job = await store.claimNextJob("worker-a");

    await store.failJob(job!.id, "boom");

    const next = await store.enqueueJob(project.id, "restart_deployment");
    expect(next.status).toBe("queued");
  });

  test("updates project state and appends logs for worker processors", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Import Agent", importKind: "zip" });

    const updated = await store.updateProjectState(project.id, { status: "imported" });
    const log = await store.appendLog({ projectId: project.id, type: "build", line: "source imported" });

    expect(updated).toMatchObject({ id: project.id, status: "imported" });
    await expect(store.listLogs(project.id)).resolves.toEqual([log]);
  });

  test("records current source revision, source files, and schedules", async () => {
    const store = createMemoryStore();
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

    await expect(store.getProject(project.id)).resolves.toMatchObject({ sourceRevisionId: revision.id, status: "imported" });
    await expect(store.getCurrentSourceRevision(project.id)).resolves.toMatchObject({ id: revision.id, commitSha: "abc123" });
    await expect(store.getSourceFile(project.id, "agent/instructions.md")).resolves.toMatchObject({ content: "You are concise." });
    await expect(store.listSchedules(project.id)).resolves.toEqual([expect.objectContaining({ name: "daily" })]);
  });

  test("advances current source without replacing an existing deployment", async () => {
    const store = createMemoryStore();
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
    const store = createMemoryStore();
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
    const store = createMemoryStore();
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
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({ runtimeKind: "systemd" });
  });

  test("resolves Eve version from the deployment's immutable source revision", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Versioned Agent", importKind: "zip" });
    const oldRevision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/source-old",
      summary: {},
      envVars: [],
      files: [{ path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.22.6" } }) }],
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
      summary: { eveVersion: "0.24.4" },
      envVars: [],
      files: [{ path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.24.4" } }) }],
      schedules: [],
    });

    await expect(store.getDeploymentEveVersion(oldDeployment.id)).resolves.toEqual({
      version: "0.22.6",
      expected: "0.24.x",
      supported: false,
      sourceRevisionId: oldRevision.id,
    });
  });

  test("getRelease returns the release by id and null when absent", async () => {
    const store = createMemoryStore();
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
    const store = createMemoryStore();
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
    const store = createMemoryStore();
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
    const store = createMemoryStore();
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
      continuationToken: "continue_123",
    });

    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        id: session.id,
        status: "completed",
        eveSessionId: "eve_123",
        continuationToken: "continue_123",
        completedAt: expect.any(String),
      }),
    ]);
    await expect(store.listSessionEvents(session.id)).resolves.toEqual([
      expect.objectContaining({ index: 0, type: "message", payload: { role: "user", content: "Hello" } }),
      expect.objectContaining({ index: 1, type: "model_response", payload: { content: "Hi" } }),
    ]);
    await expect(store.getProject(project.id)).resolves.toMatchObject({ latestSessionStatus: "completed" });
    expect(completed).toMatchObject({ id: session.id, status: "completed" });
  });

  test("records a model step and updates the session token totals", async () => {
    const store = createMemoryStore();
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

    expect(usageEvent).toMatchObject({ sessionId: session.id, turnId: "turn_0", stepIndex: 0, inputTokens: 120 });
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
    const store = createMemoryStore();
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
      expect.objectContaining({ usage: expect.objectContaining({ inputTokens: 12, outputTokens: 4, reportedSteps: 1 }) }),
    ]);
  });

  test("tracks completed steps whose provider omitted token usage", async () => {
    const store = createMemoryStore();
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
