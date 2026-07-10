import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./store.js";

describe("memory store jobs", () => {
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
});
