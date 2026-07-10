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
    });
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
