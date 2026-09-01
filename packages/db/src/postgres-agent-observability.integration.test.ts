import type { AgentEventObservation } from "@evelandhq/core/observability";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";
import { resolvePostgresTestUrl } from "./postgres-integration.test-support.js";

const databaseUrl = resolvePostgresTestUrl();
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => {
  await database?.close();
});

describe.skipIf(!database)("Postgres Agent observability ingestion", () => {
  test("binds the derived-telemetry retention cutoff as timestamptz", async () => {
    const store = createPostgresStore(database!);

    await expect(
      store.pruneDerivedAgentTelemetry(new Date("2000-01-01T00:00:00.000Z")),
    ).resolves.toEqual({
      sessions: 0,
      nodes: 0,
      events: 0,
      usageEvents: 0,
    });
  });

  test("merges provenance, child lineage, and replay-safe usage on the real schema", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({
      name: `Observer integration ${Date.now()}`,
      importKind: "zip",
    });
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
      telemetryEventId: "root-step",
      eventFingerprint: "root-step-fingerprint",
      event: {
        type: "step.completed",
        data: { turnId: "turn_1", stepIndex: 0, usage: { inputTokens: 12, outputTokens: 3 } },
      },
    });
    await store.ingestAgentEvent(
      envelope(deployment.id, {
        telemetryEventId: "child-step",
        eventFingerprint: "child-step-fingerprint",
        eveSessionId: "eve_child",
        parentEveSessionId: "eve_root",
        event: {
          type: "step.completed",
          data: { turnId: "turn_child", stepIndex: 0, usage: { inputTokens: 7, outputTokens: 2 } },
        },
      }),
    );
    await store.ingestAgentEvent(
      envelope(deployment.id, {
        telemetryEventId: "remote-called",
        eventFingerprint: "remote-called-fingerprint",
        sourceSequence: 2,
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
    await store.ingestAgentEvent(
      envelope(deployment.id, {
        telemetryEventId: "approval",
        eventFingerprint: "approval-fingerprint",
        sourceSequence: 3,
        event: { type: "input.requested", data: { requestId: "approval_1" } },
      }),
    );
    const first = await store.ingestAgentEvent(step);
    const replay = await store.ingestAgentEvent(step);

    expect(first.session.id).toBe(gatewaySession.id);
    expect(replay.duplicate).toBe(true);
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        trigger: "playground",
        status: "waiting_approval",
        usage: expect.objectContaining({ inputTokens: 19, outputTokens: 5, reportedSteps: 2 }),
      }),
    ]);
    const nodes = await store.listSessionNodes(gatewaySession.id);
    expect(nodes).toHaveLength(3);
    expect(nodes.find((node) => node.eveSessionId === "eve_remote")).toMatchObject({
      remoteUrl: "https://agents.example.test/eve/v1/session",
      resolutionStatus: "unresolved",
    });
    await expect(store.listModelUsageEvents(gatewaySession.id)).resolves.toHaveLength(2);
  }, 30_000);

  test("serializes concurrent out-of-order projection updates", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({
      name: `Observer ordering ${Date.now()}`,
      importKind: "zip",
    });
    let releaseSessionLock = () => {};
    let sessionLockHeld = () => {};
    const waitForSessionLock = new Promise<void>((resolve) => {
      sessionLockHeld = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      releaseSessionLock = resolve;
    });
    let lockTransaction: Promise<void> | null = null;

    try {
      const revision = await store.recordSourceRevision({
        projectId: project.id,
        kind: "zip",
        sourcePath: "/tmp/observer-ordering-integration",
        summary: {},
        envVars: [],
        files: [],
        schedules: [],
      });
      const deployment = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: "observer-ordering-integration",
        containerName: `observer-ordering-${Date.now()}`,
        internalPort: 3000,
        hostPort: 41998,
        runtimeKind: "docker",
      });
      const started = await store.ingestAgentEvent(
        envelope(deployment.id, {
          telemetryEventId: "ordering-started",
          eventFingerprint: "ordering-started-fingerprint",
          sourceSequence: 1,
        }),
      );

      // Hold the parent Session lock used by event append so the newer
      // transaction reaches that boundary first, while the older transaction
      // can still read the stale max(source_sequence). The old implementation
      // then lets both transactions project and the late lower sequence wins.
      lockTransaction = database!.db.transaction(async (tx) => {
        await tx.execute(sql`select id from sessions where id = ${started.session.id} for update`);
        sessionLockHeld();
        await waitForRelease;
      });
      await waitForSessionLock;

      const newer = store.ingestAgentEvent(
        envelope(deployment.id, {
          telemetryEventId: "ordering-completed",
          eventFingerprint: "ordering-completed-fingerprint",
          sourceSequence: 10,
          event: { type: "session.completed", data: {} },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const older = store.ingestAgentEvent(
        envelope(deployment.id, {
          telemetryEventId: "ordering-late-turn",
          eventFingerprint: "ordering-late-turn-fingerprint",
          sourceSequence: 5,
          event: { type: "turn.started", data: {} },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseSessionLock();

      await Promise.all([lockTransaction, newer, older]);

      await expect(store.listSessions(project.id)).resolves.toEqual([
        expect.objectContaining({ status: "completed" }),
      ]);
      await expect(store.listSessionEvents(started.session.id)).resolves.toHaveLength(3);
    } finally {
      releaseSessionLock();
      await lockTransaction?.catch(() => undefined);
      await store.deleteProject(project.id);
    }
  }, 30_000);
});

function envelope(
  deploymentId: string,
  overrides: Partial<AgentEventObservation> = {},
): AgentEventObservation {
  return {
    telemetryEventId: "evt_1",
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
