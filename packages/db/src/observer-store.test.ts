import type { DeploymentRecord, Project, ReleaseRecord } from "@eveland/core/contracts";
import type { ObserverEnvelopeV1 } from "@eveland/core/observer";
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./store.js";

describe("observer ingestion repository", () => {
  test("discovers a direct private-port session and projects provider usage once", async () => {
    const store = createStore();
    await store.ingestObserverEnvelope(envelope({ observerEventId: "started", event: { type: "session.started", data: {} } }));
    const completedStep = envelope({
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
    const [session] = await store.listSessions("proj_1");
    expect(session).toMatchObject({ trigger: "direct_http", status: "running", usage: { inputTokens: 12, outputTokens: 3, reportedSteps: 1 } });
    expect(await store.listSessionNodes(session!.id)).toHaveLength(1);
    expect(await store.listSessionEvents(session!.id)).toHaveLength(2);
  });

  test("turn.completed is not terminal and session.waiting is the durable turn boundary", async () => {
    const store = createStore();
    await store.ingestObserverEnvelope(envelope({ event: { type: "turn.completed", data: {} } }));
    let [session] = await store.listSessions("proj_1");
    expect(session?.status).toBe("running");

    await store.ingestObserverEnvelope(
      envelope({ observerEventId: "waiting", sourceSequence: 2, event: { type: "session.waiting", data: {} } }),
    );
    [session] = await store.listSessions("proj_1");
    expect(session?.status).toBe("waiting");
    expect(session?.completedAt).toBeNull();
  });

  test("links child-before-parent delivery into one root session tree", async () => {
    const store = createStore();
    await store.ingestObserverEnvelope(
      envelope({
        observerEventId: "child",
        eveSessionId: "eve_child",
        parentEveSessionId: "eve_parent",
        agent: { id: null, name: "researcher", nodeId: "subagents/researcher" },
        event: { type: "session.started", data: {} },
      }),
    );
    await store.ingestObserverEnvelope(
      envelope({
        observerEventId: "parent-started",
        eveSessionId: "eve_parent",
        event: { type: "session.started", data: {} },
      }),
    );

    const sessions = await store.listSessions("proj_1");
    expect(sessions).toHaveLength(1);
    const nodes = await store.listSessionNodes(sessions[0]!.id);
    expect(nodes).toHaveLength(2);
    expect(nodes.find((node) => node.eveSessionId === "eve_child")).toMatchObject({
      parentEveSessionId: "eve_parent",
      agentName: "researcher",
    });
  });

  test("rejects an envelope whose deployment cannot be mapped to a project", async () => {
    const store = createStore();
    await expect(store.ingestObserverEnvelope(envelope({ deploymentId: "attacker-project" }))).rejects.toThrow(/not managed/);
  });

  test("merges observer data into a pre-existing Playground session without weakening provenance", async () => {
    const store = createStore();
    const gatewaySession = await store.createSession({
      projectId: "proj_1",
      deploymentId: "dep_1",
      eveSessionId: "eve_root",
      trigger: "playground",
    });

    const ingested = await store.ingestObserverEnvelope(envelope());

    expect(ingested.session.id).toBe(gatewaySession.id);
    await expect(store.listSessions("proj_1")).resolves.toEqual([
      expect.objectContaining({ id: gatewaySession.id, trigger: "playground", rootNodeId: ingested.node.id }),
    ]);
  });

  test("merges an observer-first session when the Playground learns the Eve session id", async () => {
    const store = createStore();
    const gatewaySession = await store.createSession({ projectId: "proj_1", deploymentId: "dep_1", trigger: "playground" });
    await store.appendSessionEvent(gatewaySession.id, "message", { role: "user" });
    const observed = await store.ingestObserverEnvelope(envelope());
    expect(observed.session.id).not.toBe(gatewaySession.id);

    const completed = await store.completeSession(gatewaySession.id, { status: "completed", eveSessionId: "eve_root" });

    expect(completed).toMatchObject({ id: gatewaySession.id, trigger: "playground", rootNodeId: observed.node.id });
    await expect(store.listSessions("proj_1")).resolves.toHaveLength(1);
    await expect(store.listSessionNodes(gatewaySession.id)).resolves.toHaveLength(1);
    await expect(store.listSessionEvents(gatewaySession.id)).resolves.toHaveLength(2);
  });
});

function createStore() {
  const now = "2026-07-13T00:00:00.000Z";
  const project: Project = {
    id: "proj_1",
    name: "Fixture",
    importKind: "zip",
    gitUrl: null,
    status: "deployed",
    deploymentStatus: "running",
    sourceRevisionId: "src_1",
    releaseId: "rel_1",
    deploymentId: "dep_1",
    latestSessionStatus: null,
    nextScheduleAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const release: ReleaseRecord = { id: "rel_1", projectId: "proj_1", sourceRevisionId: "src_1", imageTag: "fixture", createdAt: now };
  const deployment: DeploymentRecord = {
    id: "dep_1",
    projectId: "proj_1",
    releaseId: "rel_1",
    containerName: "fixture",
    internalPort: 3000,
    hostPort: 41000,
    status: "running",
    runtimeKind: "docker",
    createdAt: now,
    updatedAt: now,
  };
  return createMemoryStore({ projects: [project], releases: [release], deployments: [deployment] });
}

function envelope(overrides: Partial<ObserverEnvelopeV1> = {}): ObserverEnvelopeV1 {
  return {
    schemaVersion: 1,
    observerEventId: "evt_1",
    eventFingerprint: `fingerprint_${overrides.observerEventId ?? "evt_1"}`,
    deploymentId: "dep_1",
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
