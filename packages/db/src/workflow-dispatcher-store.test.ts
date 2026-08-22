import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

const heartbeat = {
  instanceId: "wfd_test_1",
  generation: "eveland-workflow-dispatcher 1.2.3",
  state: "recovering" as const,
  ownershipAcquired: true,
  bootRecoveryCompleted: false,
  reenqueuedRuns: null,
  worldDatabaseIdentity: "cluster:7234567890123456789/eveland_workflow",
  schemaGeneration: "0013_run_quarantines.sql",
  protocolMin: 1,
  protocolMax: 1,
  startedAt: "2026-08-18T00:00:00.000Z",
  readyAt: null,
};

describe("workflow dispatcher registration", () => {
  test("heartbeats upsert by instance and the newest heartbeat is the registration", async () => {
    const store = createTestStore();

    const first = await store.recordWorkflowDispatcherHeartbeat(heartbeat);
    expect(first.state).toBe("recovering");
    expect(first.lastHeartbeatAt).toBeTruthy();

    const second = await store.recordWorkflowDispatcherHeartbeat({
      ...heartbeat,
      state: "ready",
      bootRecoveryCompleted: true,
      reenqueuedRuns: 4,
      readyAt: "2026-08-18T00:01:00.000Z",
    });
    expect(second.state).toBe("ready");
    expect(second.reenqueuedRuns).toBe(4);
    expect(second.readyAt).toBe("2026-08-18T00:01:00.000Z");

    const registration = await store.getWorkflowDispatcherRegistration();
    expect(registration).toMatchObject({
      instanceId: "wfd_test_1",
      state: "ready",
      worldDatabaseIdentity: "cluster:7234567890123456789/eveland_workflow",
      protocolMin: 1,
      protocolMax: 1,
    });
  });
});
