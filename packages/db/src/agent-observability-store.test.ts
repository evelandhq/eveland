import type { AgentEventObservation } from "@evelandhq/core/observability";
import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("Agent observability ingestion repository", () => {
  test("discovers a direct private-port session and projects provider usage once", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "started",
        event: { type: "session.started", data: {} },
      }),
    );
    const completedStep = envelope(deploymentId, {
      telemetryEventId: "step",
      sourceSequence: 2,
      event: {
        type: "step.completed",
        data: { turnId: "turn_1", stepIndex: 0, usage: { inputTokens: 12, outputTokens: 3 } },
      },
    });

    await store.ingestAgentEvent(completedStep);
    const replay = await store.ingestAgentEvent(completedStep);

    expect(replay.duplicate).toBe(true);
    const [session] = await store.listSessions(projectId);
    expect(session).toMatchObject({
      trigger: "direct_http",
      status: "running",
      usage: { inputTokens: 12, outputTokens: 3, reportedSteps: 1 },
    });
    expect(await store.listSessionNodes(session!.id)).toHaveLength(1);
    expect(await store.listSessionEvents(session!.id)).toHaveLength(2);
  });

  test("records the observed model on the usage event and the session node", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "started",
        event: { type: "session.started", data: { runtime: { modelId: "openai/gpt-5" } } },
      }),
    );

    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "step",
        sourceSequence: 2,
        observedModel: { modelId: "openai/gpt-6", responseModelId: "gpt-6-2026-01-01" },
        event: {
          type: "step.completed",
          data: { turnId: "turn_1", stepIndex: 0, usage: { inputTokens: 12, outputTokens: 3 } },
        },
      }),
    );

    const [session] = await store.listSessions(projectId);
    const [node] = await store.listSessionNodes(session!.id);
    expect(node).toMatchObject({ modelId: "openai/gpt-5", observedModelId: "openai/gpt-6" });
    expect(await store.listModelUsageEvents(session!.id)).toMatchObject([
      { modelId: "openai/gpt-6", inputTokens: 12, outputTokens: 3 },
    ]);
  });

  test("records the RuntimeInstance generation that emitted each observer event", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const activation = await store.acquireActivationLease({
      deploymentId,
      kind: "turn",
      ownerId: "turn_runtime_provenance",
      expiresAt: new Date("2026-07-28T03:00:00.000Z"),
      now: new Date("2026-07-28T02:00:00.000Z"),
    });
    await store.updateRuntimeInstance(activation.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: 41000,
    });

    const ingested = await store.ingestAgentEvent(
      envelope(deploymentId, {
        runtimeInstanceId: activation.runtimeInstance.id,
      }),
    );
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "legacy-envelope",
        sourceSequence: 2,
        event: { type: "turn.started", data: {} },
      }),
    );

    await expect(store.listSessionNodes(ingested.session.id)).resolves.toEqual([
      expect.objectContaining({
        startedRuntimeInstanceId: activation.runtimeInstance.id,
        lastObservedRuntimeInstanceId: activation.runtimeInstance.id,
      }),
    ]);
    await expect(store.listSessionEvents(ingested.session.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observedRuntimeInstanceId: activation.runtimeInstance.id,
        }),
      ]),
    );
    await expect(store.listSessions(projectId)).resolves.toHaveLength(1);
  });

  test("turn.completed is not terminal and session.waiting is the durable turn boundary", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestAgentEvent(
      envelope(deploymentId, { event: { type: "turn.completed", data: {} } }),
    );
    let [session] = await store.listSessions(projectId);
    expect(session?.status).toBe("running");

    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "waiting",
        sourceSequence: 2,
        event: { type: "session.waiting", data: {} },
      }),
    );
    [session] = await store.listSessions(projectId);
    expect(session?.status).toBe("waiting");
    expect(session?.completedAt).toBeNull();
  });

  test("settles a running ScheduleRun and releases its lease at the returned Session boundary", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const revision = await store.getCurrentSourceRevision(projectId);
    if (!revision) throw new Error("Expected source revision fixture.");
    const [recorded] = await store.recordScheduleVersions({
      projectId,
      sourceRevisionId: revision.id,
      definitions: [
        {
          key: "daily-topics",
          kind: "markdown",
          cron: "0 2 * * *",
          sourcePath: "agent/schedules/daily-topics.md",
          definitionHash: "observer-boundary-v1",
        },
      ],
    });
    if (!recorded) throw new Error("Expected schedule fixture.");
    await store.setProjectSchedulerTarget(projectId, deploymentId);
    const run = await store.createManualScheduleRun(
      projectId,
      recorded.schedule.id,
      new Date("2026-07-28T02:21:14.000Z"),
    );
    await store.claimScheduleRunActivation(run.id);
    const activation = await store.acquireActivationLease({
      deploymentId,
      kind: "schedule_run",
      ownerId: run.id,
      expiresAt: new Date("2026-07-28T03:21:14.000Z"),
      now: new Date("2026-07-28T02:21:14.000Z"),
    });
    await store.updateRuntimeInstance(
      activation.runtimeInstance.id,
      {
        status: "ready",
        endpointHost: "127.0.0.1",
        endpointPort: 41000,
      },
      new Date("2026-07-28T02:21:15.000Z"),
    );
    await store.redeemScheduleRunDispatch(run.id, deploymentId);
    await store.completeScheduleRun(run.id, {
      status: "succeeded",
      eveSessionIds: ["eve_root"],
    });

    await store.ingestAgentEvent(envelope(deploymentId));
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "waiting",
        sourceSequence: 2,
        event: { type: "session.waiting", data: {} },
      }),
    );

    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({
      status: "succeeded",
      completedAt: expect.any(String),
    });
    await expect(
      store.hasActiveActivationLeases(deploymentId, new Date("2026-07-28T02:22:00.000Z")),
    ).resolves.toBe(false);
  });

  test("waits for every returned Session turn before completing a ScheduleRun", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const revision = await store.getCurrentSourceRevision(projectId);
    if (!revision) throw new Error("Expected source revision fixture.");
    const [recorded] = await store.recordScheduleVersions({
      projectId,
      sourceRevisionId: revision.id,
      definitions: [
        {
          key: "parallel-topics",
          kind: "handler",
          cron: "0 2 * * *",
          sourcePath: "agent/schedules/parallel-topics.ts",
          definitionHash: "parallel-boundary-v1",
        },
      ],
    });
    if (!recorded) throw new Error("Expected schedule fixture.");
    await store.setProjectSchedulerTarget(projectId, deploymentId);
    const run = await store.createManualScheduleRun(
      projectId,
      recorded.schedule.id,
      new Date("2026-07-28T02:21:14.000Z"),
    );
    await store.claimScheduleRunActivation(run.id);
    const activation = await store.acquireActivationLease({
      deploymentId,
      kind: "schedule_run",
      ownerId: run.id,
      expiresAt: new Date("2026-07-28T03:21:14.000Z"),
      now: new Date("2026-07-28T02:21:14.000Z"),
    });
    await store.updateRuntimeInstance(
      activation.runtimeInstance.id,
      {
        status: "ready",
        endpointHost: "127.0.0.1",
        endpointPort: 41000,
      },
      new Date("2026-07-28T02:21:15.000Z"),
    );
    await store.redeemScheduleRunDispatch(run.id, deploymentId);
    await store.completeScheduleRun(run.id, {
      status: "succeeded",
      eveSessionIds: ["eve_topic_product", "eve_topic_customer"],
    });

    await store.ingestAgentEvent(
      envelope(deploymentId, {
        eveSessionId: "eve_topic_product",
        telemetryEventId: "product-completed",
        event: { type: "turn.completed", data: { turnId: "turn_product" } },
      }),
    );
    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({
      status: "running",
      completedAt: null,
    });

    await store.ingestAgentEvent(
      envelope(deploymentId, {
        eveSessionId: "eve_topic_customer",
        telemetryEventId: "customer-completed",
        event: { type: "turn.completed", data: { turnId: "turn_customer" } },
      }),
    );
    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({
      status: "succeeded",
      completedAt: expect.any(String),
    });
    await expect(store.listSessions(projectId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eveSessionId: "eve_topic_product",
          status: "running",
        }),
        expect.objectContaining({
          eveSessionId: "eve_topic_customer",
          status: "running",
        }),
      ]),
    );
  });

  test("settles a ScheduleRun when its Observer boundary arrived before dispatch completion", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const revision = await store.getCurrentSourceRevision(projectId);
    if (!revision) throw new Error("Expected source revision fixture.");
    const [recorded] = await store.recordScheduleVersions({
      projectId,
      sourceRevisionId: revision.id,
      definitions: [
        {
          key: "fast-topic",
          kind: "handler",
          cron: "0 2 * * *",
          sourcePath: "agent/schedules/fast-topic.ts",
          definitionHash: "observer-race-v1",
        },
      ],
    });
    if (!recorded) throw new Error("Expected schedule fixture.");
    await store.setProjectSchedulerTarget(projectId, deploymentId);
    const run = await store.createManualScheduleRun(
      projectId,
      recorded.schedule.id,
      new Date("2026-07-28T02:21:14.000Z"),
    );
    await store.claimScheduleRunActivation(run.id);
    await store.redeemScheduleRunDispatch(run.id, deploymentId);

    await store.ingestAgentEvent(
      envelope(deploymentId, {
        eveSessionId: "eve_fast_topic",
        telemetryEventId: "fast-completed",
        event: { type: "turn.completed", data: { turnId: "turn_fast" } },
      }),
    );

    await expect(
      store.completeScheduleRun(run.id, {
        status: "succeeded",
        eveSessionIds: ["eve_fast_topic"],
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      completedAt: expect.any(String),
    });
  });

  test("projects an unresolved HITL request as waiting for approval", async () => {
    const { store, projectId, deploymentId } = await createStore();

    await store.ingestAgentEvent(
      envelope(deploymentId, {
        event: {
          type: "input.requested",
          data: { requestId: "approval_1", prompt: "Allow deploy?" },
        },
      }),
    );
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "waiting",
        sourceSequence: 2,
        event: { type: "session.waiting", data: {} },
      }),
    );

    const [session] = await store.listSessions(projectId);
    expect(session).toMatchObject({ status: "waiting_approval", completedAt: null });
    await expect(store.listSessionNodes(session!.id)).resolves.toEqual([
      expect.objectContaining({ status: "waiting_approval" }),
    ]);
  });

  test("records a remote subagent URL as unresolved until its own stream is observed", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        event: {
          type: "subagent.called",
          data: {
            childSessionId: "eve_remote",
            name: "remote-researcher",
            remote: { url: "https://agents.example.test/eve/v1/session" },
          },
        },
      }),
    );

    let [session] = await store.listSessions(projectId);
    let remote = (await store.listSessionNodes(session!.id)).find(
      (node) => node.eveSessionId === "eve_remote",
    );
    expect(remote).toMatchObject({
      remoteUrl: "https://agents.example.test/eve/v1/session",
      resolutionStatus: "unresolved",
    });

    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "remote-started",
        eveSessionId: "eve_remote",
        parentEveSessionId: "eve_root",
        event: { type: "session.started", data: {} },
      }),
    );

    [session] = await store.listSessions(projectId);
    remote = (await store.listSessionNodes(session!.id)).find(
      (node) => node.eveSessionId === "eve_remote",
    );
    expect(remote).toMatchObject({
      remoteUrl: "https://agents.example.test/eve/v1/session",
      resolutionStatus: "observed",
    });
  });

  test("links child-before-parent delivery into one root session tree", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "child",
        eveSessionId: "eve_child",
        parentEveSessionId: "eve_parent",
        agent: { id: null, name: "researcher", nodeId: "subagents/researcher" },
        event: { type: "session.started", data: {} },
      }),
    );
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "parent-started",
        eveSessionId: "eve_parent",
        event: { type: "session.started", data: {} },
      }),
    );

    const sessions = await store.listSessions(projectId);
    expect(sessions).toHaveLength(1);
    const nodes = await store.listSessionNodes(sessions[0]!.id);
    expect(nodes).toHaveLength(2);
    expect(nodes.find((node) => node.eveSessionId === "eve_child")).toMatchObject({
      parentEveSessionId: "eve_parent",
      agentName: "researcher",
    });
  });

  test("rejects telemetry whose deployment cannot be mapped to a project", async () => {
    const { store, deploymentId } = await createStore();
    await expect(
      store.ingestAgentEvent(envelope(deploymentId, { deploymentId: "attacker-project" })),
    ).rejects.toMatchObject({
      code: "UNMANAGED_TELEMETRY_RESOURCE",
      message: expect.stringMatching(/not managed/),
    });
  });

  test("merges Agent telemetry into a pre-existing Playground session without weakening provenance", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const gatewaySession = await store.createSession({
      projectId,
      deploymentId,
      eveSessionId: "eve_root",
      trigger: "playground",
    });

    const ingested = await store.ingestAgentEvent(envelope(deploymentId));

    expect(ingested.session.id).toBe(gatewaySession.id);
    await expect(store.listSessions(projectId)).resolves.toEqual([
      expect.objectContaining({
        id: gatewaySession.id,
        trigger: "playground",
        rootNodeId: ingested.node.id,
      }),
    ]);
  });

  test("merges a telemetry-first session when the Playground learns the Eve session id", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const gatewaySession = await store.createSession({
      projectId,
      deploymentId,
      trigger: "playground",
    });
    await store.appendSessionEvent(gatewaySession.id, "message", { role: "user" });
    const observed = await store.ingestAgentEvent(envelope(deploymentId));
    expect(observed.session.id).not.toBe(gatewaySession.id);

    const completed = await store.completeSession(gatewaySession.id, {
      status: "completed",
      eveSessionId: "eve_root",
    });

    expect(completed).toMatchObject({
      id: gatewaySession.id,
      trigger: "playground",
      rootNodeId: observed.node.id,
    });
    await expect(store.listSessions(projectId)).resolves.toHaveLength(1);
    await expect(store.listSessionNodes(gatewaySession.id)).resolves.toHaveLength(1);
    // A merge re-parents the observed Session's events onto the surviving one.
    // Both numbered their events from zero, so they must be renumbered rather
    // than merely re-pointed: `index` is the replay ordering key.
    const mergedEvents = await store.listSessionEvents(gatewaySession.id);
    expect(mergedEvents).toHaveLength(2);
    expect(mergedEvents.map((event) => event.index)).toEqual([0, 1]);
  });

  test("projects a lost RuntimeInstance exactly once regardless of pass order", async () => {
    const runtimeLostEvents = async (
      store: Awaited<ReturnType<typeof createStore>>["store"],
      sessionId: string,
    ) =>
      (await store.listSessionEvents(sessionId)).filter(
        (event) => event.type === "platform.runtime_lost",
      );

    // The schedule pass and the session pass run in separate transactions and
    // the worker calls them in one order today. Neither order may double-post
    // the loss event, so the projection stays correct if a caller ever swaps
    // them (or a crash replays one of the two).
    for (const reversed of [false, true]) {
      const { store, projectId, deploymentId } = await createStore();
      const activation = await store.acquireActivationLease({
        deploymentId,
        kind: "turn",
        ownerId: `turn_lost_${reversed}`,
        expiresAt: new Date("2026-07-28T03:00:00.000Z"),
        now: new Date("2026-07-28T02:00:00.000Z"),
      });
      const runtimeInstanceId = activation.runtimeInstance.id;
      await store.updateRuntimeInstance(runtimeInstanceId, {
        status: "ready",
        endpointHost: "127.0.0.1",
        endpointPort: 41_050,
      });
      const ingested = await store.ingestAgentEvent(envelope(deploymentId, { runtimeInstanceId }));
      expect(await store.getSession(ingested.session.id)).toMatchObject({
        status: "running",
      });

      const reason = `RuntimeInstance ${runtimeInstanceId} vanished.`;
      const passes = [
        () => store.failScheduleExecutionsForRuntimeInstance(runtimeInstanceId, reason),
        () => store.failRunningSessionsForRuntimeInstance(runtimeInstanceId, reason),
      ];
      for (const pass of reversed ? [...passes].reverse() : passes) {
        await pass();
      }
      // Both passes again: replaying a projection must not add a second event.
      for (const pass of passes) await pass();

      expect(await runtimeLostEvents(store, ingested.session.id)).toHaveLength(1);
      await expect(store.getSession(ingested.session.id)).resolves.toMatchObject({
        status: "failed",
      });
      expect(projectId).toBeTruthy();
    }
  });

  test("a placeholder merge folds every usage counter onto the surviving session", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const gatewaySession = await store.createSession({
      projectId,
      deploymentId,
      trigger: "playground",
    });
    await store.recordModelUsage(gatewaySession.id, {
      turnId: "turn_gateway",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      costUsd: 0.5,
      usageReported: true,
    });
    const observed = await store.ingestAgentEvent(envelope(deploymentId));
    await store.recordModelUsage(observed.session.id, {
      turnId: "turn_observed",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 10,
      cacheWriteTokens: 20,
      costUsd: 1.25,
      usageReported: false,
    });

    const completed = await store.completeSession(gatewaySession.id, {
      status: "completed",
      eveSessionId: "eve_root",
    });

    // Every counter the sessions schema carries must fold across the merge;
    // a counter missing from the fold silently loses usage here.
    expect(completed).toMatchObject({
      usage: {
        inputTokens: 110,
        outputTokens: 220,
        cacheReadTokens: 11,
        cacheWriteTokens: 22,
        reportedSteps: 1,
        missingSteps: 1,
      },
    });
    expect(completed?.usage.costUsd).toBeCloseTo(1.75);
  });
});

describe("out-of-order delivery", () => {
  test("a late lower-sequence event does not reopen a terminal Session", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestAgentEvent(
      envelope(deploymentId, { telemetryEventId: "started", sourceSequence: 1 }),
    );
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "completed",
        sourceSequence: 10,
        event: { type: "session.completed", data: {} },
      }),
    );
    const [terminal] = await store.listSessions(projectId);
    expect(terminal).toMatchObject({ status: "completed" });

    // The Collector retries with multiple consumers, so an older event can
    // legitimately arrive after a newer one. It must still be stored, but it
    // must not move the projection backwards -- a Session stuck in "running"
    // is also excluded from retention pruning, so the regression leaks.
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "late-turn",
        sourceSequence: 5,
        event: { type: "turn.started", data: {} },
      }),
    );

    const [session] = await store.listSessions(projectId);
    expect(session).toMatchObject({ status: "completed" });
    expect(session!.completedAt).not.toBeNull();
    // History stays complete even though the projection ignored it.
    await expect(store.listSessionEvents(session!.id)).resolves.toHaveLength(3);
  });

  test("a genuine continuation after completion still reopens the Session", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestAgentEvent(
      envelope(deploymentId, { telemetryEventId: "started", sourceSequence: 1 }),
    );
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "completed",
        sourceSequence: 10,
        event: { type: "session.completed", data: {} },
      }),
    );

    // Eve sessions resume: completed -> running is legitimate when the event
    // is genuinely newer. The guard must be about ordering, not stickiness.
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "resumed",
        sourceSequence: 11,
        event: { type: "turn.started", data: {} },
      }),
    );

    const [session] = await store.listSessions(projectId);
    expect(session).toMatchObject({ status: "running" });
    expect(session!.completedAt).toBeNull();
  });

  test("a late lower-sequence event does not rewrite last-observed provenance", async () => {
    const { store, projectId, deploymentId, revisionId } = await createStore();
    const redeployed = await store.recordDeployment({
      projectId,
      sourceRevisionId: revisionId,
      imageTag: "fixture-2",
      containerName: "fixture-2",
      internalPort: 3000,
      hostPort: 41001,
      runtimeKind: "docker",
    });
    await store.ingestAgentEvent(
      envelope(deploymentId, { telemetryEventId: "started", sourceSequence: 1 }),
    );
    await store.ingestAgentEvent(
      envelope(redeployed.id, {
        telemetryEventId: "newer",
        sourceSequence: 9,
        event: { type: "turn.started", data: {} },
      }),
    );

    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "stale-replay",
        sourceSequence: 4,
        event: { type: "turn.started", data: {} },
      }),
    );

    const [session] = await store.listSessions(projectId);
    await expect(store.listSessionNodes(session!.id)).resolves.toEqual([
      expect.objectContaining({ lastObservedDeploymentId: redeployed.id }),
    ]);
  });
});

async function createStore() {
  const store = createTestStore();
  const project = await store.createProject({ name: "fixture", importKind: "zip" });
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/observer-fixture",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "fixture",
    containerName: "fixture",
    internalPort: 3000,
    hostPort: 41000,
    runtimeKind: "docker",
  });
  return { store, projectId: project.id, deploymentId: deployment.id, revisionId: revision.id };
}

function envelope(
  deploymentId: string,
  overrides: Partial<AgentEventObservation> = {},
): AgentEventObservation {
  return {
    telemetryEventId: "evt_1",
    eventFingerprint: `fingerprint_${overrides.telemetryEventId ?? "evt_1"}`,
    deploymentId,
    eveSessionId: "eve_root",
    parentEveSessionId: null,
    sourceSequence: 1,
    agent: { id: null, name: "root", nodeId: "root" },
    channelKind: "http",
    eventAt: "2026-07-13T00:00:00.000Z",
    event: { type: "session.started", data: {} },
    ...overrides,
  };
}
