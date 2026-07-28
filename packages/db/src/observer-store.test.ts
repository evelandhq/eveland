import type { ObserverEnvelopeV1 } from "@eveland/core/observer";
import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("observer ingestion repository", () => {
  test("discovers a direct private-port session and projects provider usage once", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestObserverEnvelope(envelope(deploymentId, { observerEventId: "started", event: { type: "session.started", data: {} } }));
    const completedStep = envelope(deploymentId, {
      observerEventId: "step",
      sourceSequence: 2,
      event: {
        type: "step.completed",
        data: { turnId: "turn_1", stepIndex: 0, usage: { inputTokens: 12, outputTokens: 3 } },
      },
    });

    await store.ingestObserverEnvelope(completedStep);
    const replay = await store.ingestObserverEnvelope(completedStep);

    expect(replay.duplicate).toBe(true);
    const [session] = await store.listSessions(projectId);
    expect(session).toMatchObject({ trigger: "direct_http", status: "running", usage: { inputTokens: 12, outputTokens: 3, reportedSteps: 1 } });
    expect(await store.listSessionNodes(session!.id)).toHaveLength(1);
    expect(await store.listSessionEvents(session!.id)).toHaveLength(2);
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

    const ingested = await store.ingestObserverEnvelope(
      envelope(deploymentId, {
        runtimeInstanceId: activation.runtimeInstance.id,
      }),
    );
    await store.ingestObserverEnvelope(
      envelope(deploymentId, {
        observerEventId: "legacy-envelope",
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
    await store.ingestObserverEnvelope(envelope(deploymentId, { event: { type: "turn.completed", data: {} } }));
    let [session] = await store.listSessions(projectId);
    expect(session?.status).toBe("running");

    await store.ingestObserverEnvelope(
      envelope(deploymentId, { observerEventId: "waiting", sourceSequence: 2, event: { type: "session.waiting", data: {} } }),
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
      definitions: [{
        key: "daily-topics",
        kind: "markdown",
        cron: "0 2 * * *",
        sourcePath: "agent/schedules/daily-topics.md",
        definitionHash: "observer-boundary-v1",
      }],
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

    await store.ingestObserverEnvelope(envelope(deploymentId));
    await store.ingestObserverEnvelope(envelope(deploymentId, {
      observerEventId: "waiting",
      sourceSequence: 2,
      event: { type: "session.waiting", data: {} },
    }));

    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({
      status: "succeeded",
      completedAt: expect.any(String),
    });
    await expect(
      store.hasActiveActivationLeases(
        deploymentId,
        new Date("2026-07-28T02:22:00.000Z"),
      ),
    ).resolves.toBe(false);
  });

  test("waits for every returned Session turn before completing a ScheduleRun", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const revision = await store.getCurrentSourceRevision(projectId);
    if (!revision) throw new Error("Expected source revision fixture.");
    const [recorded] = await store.recordScheduleVersions({
      projectId,
      sourceRevisionId: revision.id,
      definitions: [{
        key: "parallel-topics",
        kind: "handler",
        cron: "0 2 * * *",
        sourcePath: "agent/schedules/parallel-topics.ts",
        definitionHash: "parallel-boundary-v1",
      }],
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

    await store.ingestObserverEnvelope(envelope(deploymentId, {
      eveSessionId: "eve_topic_product",
      observerEventId: "product-completed",
      event: { type: "turn.completed", data: { turnId: "turn_product" } },
    }));
    await expect(store.getScheduleRun(run.id)).resolves.toMatchObject({
      status: "running",
      completedAt: null,
    });

    await store.ingestObserverEnvelope(envelope(deploymentId, {
      eveSessionId: "eve_topic_customer",
      observerEventId: "customer-completed",
      event: { type: "turn.completed", data: { turnId: "turn_customer" } },
    }));
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
      definitions: [{
        key: "fast-topic",
        kind: "handler",
        cron: "0 2 * * *",
        sourcePath: "agent/schedules/fast-topic.ts",
        definitionHash: "observer-race-v1",
      }],
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

    await store.ingestObserverEnvelope(envelope(deploymentId, {
      eveSessionId: "eve_fast_topic",
      observerEventId: "fast-completed",
      event: { type: "turn.completed", data: { turnId: "turn_fast" } },
    }));

    await expect(store.completeScheduleRun(run.id, {
      status: "succeeded",
      eveSessionIds: ["eve_fast_topic"],
    })).resolves.toMatchObject({
      status: "succeeded",
      completedAt: expect.any(String),
    });
  });

  test("projects an unresolved HITL request as waiting for approval", async () => {
    const { store, projectId, deploymentId } = await createStore();

    await store.ingestObserverEnvelope(
      envelope(deploymentId, { event: { type: "input.requested", data: { requestId: "approval_1", prompt: "Allow deploy?" } } }),
    );
    await store.ingestObserverEnvelope(
      envelope(deploymentId, { observerEventId: "waiting", sourceSequence: 2, event: { type: "session.waiting", data: {} } }),
    );

    const [session] = await store.listSessions(projectId);
    expect(session).toMatchObject({ status: "waiting_approval", completedAt: null });
    await expect(store.listSessionNodes(session!.id)).resolves.toEqual([
      expect.objectContaining({ status: "waiting_approval" }),
    ]);
  });

  test("records a remote subagent URL as unresolved until its own stream is observed", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestObserverEnvelope(
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
    let remote = (await store.listSessionNodes(session!.id)).find((node) => node.eveSessionId === "eve_remote");
    expect(remote).toMatchObject({
      remoteUrl: "https://agents.example.test/eve/v1/session",
      resolutionStatus: "unresolved",
    });

    await store.ingestObserverEnvelope(
      envelope(deploymentId, {
        observerEventId: "remote-started",
        eveSessionId: "eve_remote",
        parentEveSessionId: "eve_root",
        event: { type: "session.started", data: {} },
      }),
    );

    [session] = await store.listSessions(projectId);
    remote = (await store.listSessionNodes(session!.id)).find((node) => node.eveSessionId === "eve_remote");
    expect(remote).toMatchObject({
      remoteUrl: "https://agents.example.test/eve/v1/session",
      resolutionStatus: "observed",
    });
  });

  test("links child-before-parent delivery into one root session tree", async () => {
    const { store, projectId, deploymentId } = await createStore();
    await store.ingestObserverEnvelope(
      envelope(deploymentId, {
        observerEventId: "child",
        eveSessionId: "eve_child",
        parentEveSessionId: "eve_parent",
        agent: { id: null, name: "researcher", nodeId: "subagents/researcher" },
        event: { type: "session.started", data: {} },
      }),
    );
    await store.ingestObserverEnvelope(
      envelope(deploymentId, {
        observerEventId: "parent-started",
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

  test("rejects an envelope whose deployment cannot be mapped to a project", async () => {
    const { store, deploymentId } = await createStore();
    await expect(store.ingestObserverEnvelope(envelope(deploymentId, { deploymentId: "attacker-project" }))).rejects.toMatchObject({
      code: "OBSERVER_ENVELOPE_REJECTED",
      message: expect.stringMatching(/not managed/),
    });
  });

  test("merges observer data into a pre-existing Playground session without weakening provenance", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const gatewaySession = await store.createSession({
      projectId,
      deploymentId,
      eveSessionId: "eve_root",
      trigger: "playground",
    });

    const ingested = await store.ingestObserverEnvelope(envelope(deploymentId));

    expect(ingested.session.id).toBe(gatewaySession.id);
    await expect(store.listSessions(projectId)).resolves.toEqual([
      expect.objectContaining({ id: gatewaySession.id, trigger: "playground", rootNodeId: ingested.node.id }),
    ]);
  });

  test("merges an observer-first session when the Playground learns the Eve session id", async () => {
    const { store, projectId, deploymentId } = await createStore();
    const gatewaySession = await store.createSession({ projectId, deploymentId, trigger: "playground" });
    await store.appendSessionEvent(gatewaySession.id, "message", { role: "user" });
    const observed = await store.ingestObserverEnvelope(envelope(deploymentId));
    expect(observed.session.id).not.toBe(gatewaySession.id);

    const completed = await store.completeSession(gatewaySession.id, { status: "completed", eveSessionId: "eve_root" });

    expect(completed).toMatchObject({ id: gatewaySession.id, trigger: "playground", rootNodeId: observed.node.id });
    await expect(store.listSessions(projectId)).resolves.toHaveLength(1);
    await expect(store.listSessionNodes(gatewaySession.id)).resolves.toHaveLength(1);
    await expect(store.listSessionEvents(gatewaySession.id)).resolves.toHaveLength(2);
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
  return { store, projectId: project.id, deploymentId: deployment.id };
}

function envelope(deploymentId: string, overrides: Partial<ObserverEnvelopeV1> = {}): ObserverEnvelopeV1 {
  return {
    schemaVersion: 1,
    observerEventId: "evt_1",
    eventFingerprint: `fingerprint_${overrides.observerEventId ?? "evt_1"}`,
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
