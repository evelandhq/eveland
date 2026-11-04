import type { AgentEventObservation } from "@evelandhq/core/observability";
import { describe, expect, test } from "vitest";
import { isUniqueConstraint } from "./postgres-store-support.js";
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
          definitionHash: "a".repeat(64),
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
          definitionHash: "a".repeat(64),
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
          definitionHash: "a".repeat(64),
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

  test.each([
    { arrival: "before", label: "its Observer boundary arrived before dispatch completion" },
    { arrival: "after", label: "dispatch completion came first" },
  ])(
    "parks a ScheduleRun on an Eve 0.69 question inside a running call when $label",
    async ({ arrival }) => {
      // 0.69 parks the turn with `turn.waiting` instead of ending it with
      // `session.waiting` when a call it runs asks a question.
      const { store, projectId, deploymentId } = await createStore();
      const revision = await store.getCurrentSourceRevision(projectId);
      if (!revision) throw new Error("Expected source revision fixture.");
      const [recorded] = await store.recordScheduleVersions({
        projectId,
        sourceRevisionId: revision.id,
        definitions: [
          {
            key: "asks-first",
            kind: "handler",
            cron: "0 2 * * *",
            sourcePath: "agent/schedules/asks-first.ts",
            definitionHash: "b".repeat(64),
          },
        ],
      });
      if (!recorded) throw new Error("Expected schedule fixture.");
      await store.setProjectSchedulerTarget(projectId, deploymentId);
      const run = await store.createManualScheduleRun(
        projectId,
        recorded.schedule.id,
        new Date("2026-10-02T02:00:00.000Z"),
      );
      await store.claimScheduleRunActivation(run.id);
      await store.redeemScheduleRunDispatch(run.id, deploymentId);
      const ingestQuestion = async () => {
        await store.ingestAgentEvent(
          envelope(deploymentId, {
            eveSessionId: "eve_asks_first",
            telemetryEventId: "asks-started",
            event: { type: "turn.started", data: { turnId: "turn_ask" } },
          }),
        );
        await store.ingestAgentEvent(
          envelope(deploymentId, {
            eveSessionId: "eve_asks_first",
            telemetryEventId: "asks-requested",
            sourceSequence: 2,
            event: {
              type: "input.requested",
              data: { turnId: "turn_ask", requests: [{ requestId: "run_1-ask-0" }] },
            },
          }),
        );
        await store.ingestAgentEvent(
          envelope(deploymentId, {
            eveSessionId: "eve_asks_first",
            telemetryEventId: "asks-waiting",
            sourceSequence: 3,
            event: { type: "turn.waiting", data: { turnId: "turn_ask", sequence: 3 } },
          }),
        );
      };

      if (arrival === "before") await ingestQuestion();
      const completed = await store.completeScheduleRun(run.id, {
        status: "succeeded",
        eveSessionIds: ["eve_asks_first"],
      });
      if (arrival === "after") {
        expect(completed).toMatchObject({ status: "running", completedAt: null });
        await ingestQuestion();
      }

      await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({
        status: "succeeded",
        completedAt: expect.any(String),
      });
      const [session] = await store.listSessions(projectId);
      expect(session).toMatchObject({ status: "waiting_approval" });
    },
  );

  test("keeps a held turn waiting for approval after a partial answer", async () => {
    // Answering one of two pending requests resolves only that one; eve then
    // re-parks the same turn with `turn.waiting { on: "input" }`.
    const { store, projectId, deploymentId } = await createStore();
    const events = [
      { type: "turn.started", data: { turnId: "turn_two" } },
      { type: "input.requested", data: { turnId: "turn_two", requests: [{ requestId: "q_1" }] } },
      { type: "input.requested", data: { turnId: "turn_two", requests: [{ requestId: "q_2" }] } },
      {
        type: "input.resolved",
        data: { turnId: "turn_two", resolutions: [{ requestId: "q_1", outcome: "answered" }] },
      },
      { type: "turn.waiting", data: { on: "input", turnId: "turn_two", sequence: 5 } },
    ];
    for (const [index, event] of events.entries()) {
      await store.ingestAgentEvent(
        envelope(deploymentId, {
          telemetryEventId: `partial-${index}`,
          sourceSequence: index + 1,
          event,
        }),
      );
    }

    const [session] = await store.listSessions(projectId);
    expect(session).toMatchObject({ status: "waiting_approval", completedAt: null });
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

  test.each([
    {
      eve: "0.74",
      event: {
        type: "subagent.called",
        data: {
          childSessionId: "eve_remote",
          name: "remote-researcher",
          remote: { url: "https://agents.example.test/eve/v1/session" },
        },
      },
    },
    {
      eve: "0.69",
      event: {
        type: "agent.started",
        data: {
          callId: "call_remote",
          name: "remote-researcher",
          sessionId: "eve_remote",
          streamPath: "/eve/v1/session/eve_root/subagents/call_remote/eve_remote/stream",
          taskId: "task_remote",
          turnId: "turn_1",
          remote: {
            resolverId: "remote-researcher",
            url: "https://agents.example.test/eve/v1/session",
          },
        },
      },
    },
  ])(
    "records a remote subagent URL from Eve $eve as unresolved until its own stream is observed",
    async ({ event }) => {
      const { store, projectId, deploymentId } = await createStore();
      await store.ingestAgentEvent(envelope(deploymentId, { event }));

      let [session] = await store.listSessions(projectId);
      let remote = (await store.listSessionNodes(session!.id)).find(
        (node) => node.eveSessionId === "eve_remote",
      );
      expect(remote).toMatchObject({
        agentName: "remote-researcher",
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
    },
  );

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

  test("the schema refuses a second live Session for one Eve session id", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.createSession({
      projectId,
      deploymentId,
      eveSessionId: "eve_root",
      trigger: "playground",
    });

    // Session identity is enforced by `sessions_project_eve_session_idx`, not
    // by merge logic after the fact: a second live row for the pair is refused.
    await expect(
      store.createSession({
        projectId,
        deploymentId,
        eveSessionId: "eve_root",
        trigger: "playground",
      }),
    ).rejects.toSatisfy((error) => isUniqueConstraint(error, "sessions_project_eve_session_idx"));
    // NULL stays multi-valued: Sessions that have not learned their Eve id yet
    // are the legitimate transient overlap and must not be constrained.
    await store.createSession({ projectId, deploymentId, trigger: "playground" });
    await store.createSession({ projectId, deploymentId, trigger: "playground" });
    await expect(store.listSessions(projectId)).resolves.toHaveLength(3);
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

  test("stores the agent-reported failure message on the failed Session", async () => {
    const { store, deploymentId } = await createStore();
    const started = await store.ingestAgentEvent(envelope(deploymentId));
    await store.ingestAgentEvent(
      envelope(deploymentId, {
        telemetryEventId: "evt_2",
        sourceSequence: 2,
        event: { type: "session.failed", data: { message: "Tool crashed: boom" } },
      }),
    );

    await expect(store.getSession(started.session.id)).resolves.toMatchObject({
      status: "failed",
      error: "Tool crashed: boom",
    });
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
        error: reason,
      });
      expect(projectId).toBeTruthy();
    }
  });

  test("failing Sessions for the observing instance also fails the owning ScheduleRun and releases its lease", async () => {
    // The #270 shape: the ScheduleRun's activation lease points at one
    // Deployment's instance while a previous Deployment's process actually
    // executes (and observes) the turn. When the observing process dies, the
    // Session must not leave its ScheduleRun running and its lease pinning the
    // leased Deployment until the 24 h TTL.
    const {
      store,
      projectId,
      deploymentId: observedDeploymentId,
      revisionId,
    } = await createStore();
    const importJob = await store.claimNextJob("fixture-import");
    if (importJob) await store.completeJob(importJob.id);
    const [recorded] = await store.recordScheduleVersions({
      projectId,
      sourceRevisionId: revisionId,
      definitions: [
        {
          key: "daily-stolen-turn",
          kind: "markdown",
          cron: "0 2 * * *",
          sourcePath: "agent/schedules/daily-stolen-turn.md",
          definitionHash: "a".repeat(64),
        },
      ],
    });
    if (!recorded) throw new Error("Expected schedule fixture.");
    const leasedDeployment = await store.recordDeployment({
      projectId,
      sourceRevisionId: revisionId,
      imageTag: "fixture:leased",
      containerName: "fixture-leased",
      internalPort: 3000,
      hostPort: 41001,
      runtimeKind: "docker",
    });
    await store.setProjectSchedulerTarget(projectId, leasedDeployment.id);
    const dispatchedAt = new Date("2026-08-05T09:13:04.000Z");
    const run = await store.createManualScheduleRun(projectId, recorded.schedule.id, dispatchedAt);
    await store.claimScheduleRunActivation(run.id);
    await store.redeemScheduleRunDispatch(run.id, leasedDeployment.id);
    await store.acquireActivationLease({
      deploymentId: leasedDeployment.id,
      kind: "schedule_run",
      ownerId: run.id,
      expiresAt: new Date("2026-08-06T09:13:04.000Z"),
      now: dispatchedAt,
    });
    await store.completeScheduleRun(run.id, {
      status: "succeeded",
      eveSessionIds: ["eve_stolen_turn"],
    });

    const observing = await store.acquireActivationLease({
      deploymentId: observedDeploymentId,
      kind: "turn",
      ownerId: "turn_stolen",
      expiresAt: new Date("2026-08-05T10:13:04.000Z"),
      now: dispatchedAt,
    });
    await store.updateRuntimeInstance(observing.runtimeInstance.id, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: 41_051,
    });
    await store.ingestAgentEvent(
      envelope(observedDeploymentId, {
        eveSessionId: "eve_stolen_turn",
        runtimeInstanceId: observing.runtimeInstance.id,
      }),
    );
    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({ status: "running" });

    await store.failRunningSessionsForRuntimeInstance(
      observing.runtimeInstance.id,
      `RuntimeInstance ${observing.runtimeInstance.id} stopped before its active Sessions reached a terminal boundary.`,
      new Date("2026-08-05T09:16:35.000Z"),
    );

    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({ status: "failed" });
    await expect(
      store.hasActiveActivationLeases(leasedDeployment.id, new Date("2026-08-05T09:16:36.000Z")),
    ).resolves.toBe(false);
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

describe("v27 (eve 0.84+) observations", () => {
  function v27(
    deploymentId: string,
    line: number,
    index: number,
    event: Record<string, unknown>,
    overrides: Partial<AgentEventObservation> = {},
  ): AgentEventObservation {
    return envelope(deploymentId, {
      telemetryEventId: `v27_${line}_${index}`,
      eventFingerprint: `position:${line}:${index}`,
      sourceSequence: line * 1000 + index,
      channelKind: "channel:eve",
      event: { ...event, meta: { position: { line, index } } },
      ...overrides,
    });
  }

  test("projects status, usage, children, and the terminal outcome from v27 facts", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const usage = (runId: string, inputTokens: number) => ({
      type: "usage.recorded",
      scope: { turnId: "turn_1", runId },
      data: {
        kind: "model",
        owner: { runId },
        usage: {
          inputTokens,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          costUsd: 0.5,
        },
      },
    });
    const events: Array<[number, number, Record<string, unknown>]> = [
      [
        0,
        0,
        {
          type: "session.started",
          data: { runtime: { agentId: "a", agentName: "root", eveVersion: "1.0.0-rc.1" } },
        },
      ],
      [1, 0, { type: "turn.started", scope: { turnId: "turn_1" }, data: { turnId: "turn_1" } }],
      [
        2,
        0,
        {
          type: "model.started",
          scope: { turnId: "turn_1", runId: "run_1" },
          data: { runId: "run_1", modelId: "anthropic/claude-sonnet-5", attempt: 1 },
        },
      ],
      [
        3,
        0,
        {
          type: "model.settled",
          scope: { turnId: "turn_1", runId: "run_1" },
          data: { runId: "run_1", outcome: "completed" },
        },
      ],
      [3, 1, usage("run_1", 100)],
      [
        4,
        0,
        {
          type: "interaction.opened",
          scope: { turnId: "turn_1" },
          data: { interactionId: "int_1", request: { kind: "approval", prompt: "ok?" } },
        },
      ],
    ];
    for (const [line, index, event] of events) {
      await store.ingestAgentEvent(v27(deploymentId, line, index, event));
    }
    let [session] = await store.listSessions(projectId);
    expect(session).toMatchObject({ trigger: "direct_http", status: "waiting_approval" });

    // A redelivered record is a duplicate; a call-owned record re-reports a
    // child's spend and is left to the child.
    expect(
      (await store.ingestAgentEvent(v27(deploymentId, 3, 1, usage("run_1", 100)))).duplicate,
    ).toBe(true);
    await store.ingestAgentEvent(
      v27(deploymentId, 5, 0, {
        type: "usage.recorded",
        scope: { turnId: "turn_1" },
        data: {
          kind: "model",
          owner: { callId: "call_1" },
          usage: { inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      }),
    );
    for (const [line, index, event] of [
      [
        6,
        0,
        {
          type: "interaction.settled",
          scope: { turnId: "turn_1" },
          data: { interactionId: "int_1", outcome: "accepted" },
        },
      ],
      [
        7,
        0,
        {
          type: "child.opened",
          scope: { turnId: "turn_1" },
          data: {
            sessionId: "eve_child",
            owner: { callId: "call_1" },
            name: "researcher",
            stream: "s",
          },
        },
      ],
      [8, 0, usage("run_2", 50)],
      [
        9,
        0,
        {
          type: "turn.settled",
          scope: { turnId: "turn_1" },
          data: { turnId: "turn_1", outcome: "completed" },
        },
      ],
    ] as const) {
      await store.ingestAgentEvent(v27(deploymentId, line, index, event));
    }
    [session] = await store.listSessions(projectId);
    expect(session).toMatchObject({
      status: "waiting",
      usage: {
        inputTokens: 150,
        outputTokens: 10,
        cacheReadTokens: 2,
        reportedSteps: 2,
        costUsd: 1,
      },
    });
    const usageRows = await store.listModelUsageEvents(session!.id);
    expect(usageRows.map((row) => [row.turnId, row.stepIndex, row.runKey])).toEqual(
      expect.arrayContaining([
        ["turn_1", null, "run:run_1"],
        ["turn_1", null, "run:run_2"],
      ]),
    );
    expect(usageRows).toHaveLength(2);
    const nodes = await store.listSessionNodes(session!.id);
    expect(nodes.find((node) => node.eveSessionId === "eve_root")).toMatchObject({
      modelId: "anthropic/claude-sonnet-5",
      eveVersion: "1.0.0-rc.1",
    });
    expect(nodes.find((node) => node.eveSessionId === "eve_child")).toMatchObject({
      agentName: "researcher",
      resolutionStatus: "unresolved",
      remoteUrl: null,
    });

    await store.ingestAgentEvent(
      v27(deploymentId, 10, 0, {
        type: "session.ended",
        data: { outcome: "failed", error: { code: "X", message: "agent gave up" } },
      }),
    );
    [session] = await store.listSessions(projectId);
    expect(session).toMatchObject({ status: "failed", error: "agent gave up" });
  });

  test("attributes each v27 run's usage to its observed model, not the configured one", async () => {
    // Two runs on one node, each answered by a different real model, neither
    // of which is the configured one: the configured-model fallback must not
    // be what makes the usage rows look right.
    const { store, projectId, deploymentId } = await createStore();
    const scope = (runId: string) => ({ turnId: "turn_1", runId });
    await store.ingestAgentEvent(
      v27(deploymentId, 0, 0, {
        type: "session.started",
        data: { runtime: { agentId: "a", agentName: "root", eveVersion: "1.0.0-rc.1" } },
      }),
    );
    let line = 1;
    for (const [runId, observed] of [
      ["run_1", "actual/first"],
      ["run_2", "actual/second"],
    ] as const) {
      await store.ingestAgentEvent(
        v27(deploymentId, line++, 0, {
          type: "model.started",
          scope: scope(runId),
          data: { runId, modelId: "manifest/model" },
        }),
      );
      await store.ingestAgentEvent(
        v27(
          deploymentId,
          line++,
          0,
          {
            type: "usage.recorded",
            scope: scope(runId),
            data: {
              kind: "model",
              owner: { runId },
              usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          },
          { observedModel: { modelId: observed, responseModelId: `${observed}-2026` } },
        ),
      );
    }

    const [session] = await store.listSessions(projectId);
    const usage = await store.listModelUsageEvents(session!.id);
    expect(usage.map((row) => row.modelId).sort()).toEqual(["actual/first", "actual/second"]);
    const [node] = await store.listSessionNodes(session!.id);
    expect(node?.observedModelId).toBe("actual/second");
  });

  test("counts a v27 model run with no usage record as missing", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const scope = (runId: string) => ({ turnId: "t", runId });
    const events = [
      { type: "model.started", scope: scope("r1"), data: { runId: "r1", modelId: "openai/test" } },
      { type: "model.settled", scope: scope("r1"), data: { runId: "r1", outcome: "completed" } },
      {
        type: "usage.recorded",
        scope: scope("r1"),
        data: {
          kind: "model",
          owner: { runId: "r1" },
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
      { type: "model.started", scope: scope("r2"), data: { runId: "r2", modelId: "openai/test" } },
      { type: "model.settled", scope: scope("r2"), data: { runId: "r2", outcome: "completed" } },
      { type: "turn.settled", scope: { turnId: "t" }, data: { turnId: "t", outcome: "completed" } },
    ];
    for (const [line, event] of events.entries()) {
      await store.ingestAgentEvent(v27(deploymentId, line, 0, event));
    }
    const [session] = await store.listSessions(projectId);
    expect(session?.usage).toMatchObject({ status: "partial", reportedSteps: 1, missingSteps: 1 });
  });

  test("reconciles v27 missing usage with late, early, and replayed records without double counting", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const scope = (runId: string) => ({ turnId: "t", runId });
    const settled = (runId: string) => ({
      type: "model.settled",
      scope: scope(runId),
      data: { runId, outcome: "completed", finishReason: "stop" },
    });
    const recorded = (runId: string, inputTokens: number) => ({
      type: "usage.recorded",
      scope: scope(runId),
      data: {
        kind: "model",
        owner: { runId },
        usage: { inputTokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
    const usageOf = async () => (await store.listSessions(projectId))[0]?.usage;

    // r1 settles and is counted missing until its record arrives late.
    await store.ingestAgentEvent(v27(deploymentId, 1, 0, settled("r1")));
    expect(await usageOf()).toMatchObject({ status: "missing", reportedSteps: 0, missingSteps: 1 });
    await store.ingestAgentEvent(
      v27(deploymentId, 9, 0, recorded("r1", 10), {
        observedModel: { modelId: "actual/model", responseModelId: null },
      }),
    );
    expect(await usageOf()).toMatchObject({
      status: "reported",
      reportedSteps: 1,
      missingSteps: 0,
      inputTokens: 10,
    });

    // r2's record arrives before its settlement: the settlement adds nothing.
    await store.ingestAgentEvent(v27(deploymentId, 10, 0, recorded("r2", 20)));
    await store.ingestAgentEvent(v27(deploymentId, 11, 0, settled("r2")));
    expect(await usageOf()).toMatchObject({ reportedSteps: 2, missingSteps: 0, inputTokens: 30 });

    // Replays (new delivery ids for the same facts) change nothing.
    for (const [line, event] of [
      [1, settled("r1")],
      [9, recorded("r1", 10)],
      [11, settled("r2")],
    ] as const) {
      await store.ingestAgentEvent(
        v27(deploymentId, line, 0, event, { telemetryEventId: `replay_${line}` }),
      );
    }
    expect(await usageOf()).toMatchObject({ reportedSteps: 2, missingSteps: 0, inputTokens: 30 });

    const [session] = await store.listSessions(projectId);
    const rows = await store.listModelUsageEvents(session!.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.runKey === "run:r1")).toMatchObject({
      usageReported: true,
      modelId: "actual/model",
      finishReason: "stop",
      inputTokens: 10,
    });
  });

  test("classifies the v27 scheduler channel as a scheduled trigger", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestAgentEvent(
      v27(
        deploymentId,
        0,
        0,
        { type: "session.started", data: {} },
        { channelKind: "channel:eveland-scheduler", eveSessionId: "eve_sched" },
      ),
    );
    await store.ingestAgentEvent(
      v27(
        deploymentId,
        0,
        0,
        { type: "session.started", data: {} },
        { channelKind: "channel:slack", eveSessionId: "eve_slack" },
      ),
    );
    const sessions = await store.listSessions(projectId);
    expect(
      Object.fromEntries(sessions.map((session) => [session.eveSessionId, session.trigger])),
    ).toMatchObject({
      eve_sched: "cron",
      eve_slack: "channel",
    });
  });
});

describe("session binding pinning", () => {
  async function boundSession(input: { bound: string; observed: string }) {
    const { store, projectId, revisionId } = await createStore();
    const deploy = (eveVersionResolved: string, hostPort: number) =>
      store.recordDeployment({
        projectId,
        sourceRevisionId: revisionId,
        imageTag: `fixture-${hostPort}`,
        containerName: `fixture-${hostPort}`,
        internalPort: 3000,
        hostPort,
        runtimeKind: "docker",
        summary: { eveVersionResolved },
      });
    const bound = await deploy(input.bound, 41001);
    const observed = await deploy(input.observed, 41002);
    const [route] = await store.ensureDeploymentRoutes(projectId, bound.id, "agent.localhost");
    await store.ingestAgentEvent(
      envelope(bound.id, { telemetryEventId: "start", eveSessionId: "eve_moved" }),
    );
    await store.bindSession({
      projectId,
      eveSessionId: "eve_moved",
      routeId: route!.id,
      deploymentId: bound.id,
      trigger: "playground",
      variantName: null,
      experimentId: null,
      requestId: "request_moved",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
    });
    return { store, projectId, bound, observed };
  }

  test("an observation from another Deployment does not move a session's binding", async () => {
    // A session stays on the Deployment that created it; the Agent Gateway
    // pins its continuations and streams there, so a report of the same Eve
    // session from another Deployment (a late event, or an unpinned delivery)
    // must not re-point the binding.
    const { store, projectId, bound, observed } = await boundSession({
      bound: "1.0.0-rc.2",
      observed: "1.0.0-rc.2",
    });
    await store.ingestAgentEvent(
      envelope(observed.id, {
        telemetryEventId: "other",
        eveSessionId: "eve_moved",
        event: { type: "turn.started", data: { turnId: "turn_2" } },
      }),
    );
    await expect(store.findSessionBinding(projectId, "eve_moved")).resolves.toMatchObject({
      deploymentId: bound.id,
    });
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
