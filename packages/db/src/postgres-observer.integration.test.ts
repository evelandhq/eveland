import type { ObserverEnvelopeV1 } from "@eveland/core/observer";
import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => {
  await database?.close();
});

describe.skipIf(!database)("Postgres observer ingestion", () => {
  test("merges provenance, child lineage, and replay-safe usage on the real schema", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({ name: `Observer integration ${Date.now()}`, importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/observer-integration",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "observer-integration",
      containerName: `observer-integration-${Date.now()}`,
      internalPort: 3000,
      hostPort: 41999,
      runtimeKind: "docker",
    });
    const gatewaySession = await store.createSession({
      projectId: project.id,
      deploymentId: deployment.id,
      eveSessionId: "eve_root",
      trigger: "playground",
    });

    const step = envelope(deployment.id, {
      observerEventId: "root-step",
      eventFingerprint: "root-step-fingerprint",
      event: { type: "step.completed", data: { turnId: "turn_1", stepIndex: 0, usage: { inputTokens: 12, outputTokens: 3 } } },
    });
    await store.ingestObserverEnvelope(
      envelope(deployment.id, {
        observerEventId: "child-step",
        eventFingerprint: "child-step-fingerprint",
        eveSessionId: "eve_child",
        parentEveSessionId: "eve_root",
        event: { type: "step.completed", data: { turnId: "turn_child", stepIndex: 0, usage: { inputTokens: 7, outputTokens: 2 } } },
      }),
    );
    const first = await store.ingestObserverEnvelope(step);
    const replay = await store.ingestObserverEnvelope(step);

    expect(first.session.id).toBe(gatewaySession.id);
    expect(replay.duplicate).toBe(true);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ trigger: "playground", usage: expect.objectContaining({ inputTokens: 19, outputTokens: 5, reportedSteps: 2 }) }),
    ]);
    await expect(store.listSessionNodes(gatewaySession.id)).resolves.toHaveLength(2);
    await expect(store.listModelUsageEvents(gatewaySession.id)).resolves.toHaveLength(2);
  }, 30_000);
});

function envelope(deploymentId: string, overrides: Partial<ObserverEnvelopeV1> = {}): ObserverEnvelopeV1 {
  return {
    schemaVersion: 1,
    observerEventId: "evt_1",
    eventFingerprint: "evt_1-fingerprint",
    deploymentId,
    eveSessionId: "eve_root",
    parentEveSessionId: null,
    sourceSequence: 1,
    agent: { id: "agent_root", name: "root", nodeId: "root" },
    channelKind: "http",
    eventAt: new Date().toISOString(),
    event: { type: "session.started", data: {} },
    ...overrides,
  };
}
