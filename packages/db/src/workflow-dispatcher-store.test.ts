import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

const heartbeat = {
  instanceId: "wfd_test_1",
  generation: "eveland-workflow-dispatcher 1.2.3",
  state: "ready_paused" as const,
  ownershipAcquired: true,
  bootRecoveryCompleted: true,
  reenqueuedRuns: 4,
  worldDatabaseIdentity: "localhost:5432/eveland_workflow",
  schemaGeneration: "0013_run_quarantines.sql",
  protocolMin: 1,
  protocolMax: 1,
  cutoverOperationId: null,
  unscopedRunnableJobs: 0,
  unresolvedQuarantines: 0,
  startedAt: "2026-08-18T00:00:00.000Z",
  readyAt: null,
};

describe("workflow dispatcher registration", () => {
  test("a paused dispatcher stays paused until an explicit desired-state change", async () => {
    const store = createTestStore();

    const first = await store.recordWorkflowDispatcherHeartbeat(heartbeat);
    // A ready_paused registration never grants itself permission to claim.
    expect(first.desiredState).toBe("paused");
    expect(first.state).toBe("ready_paused");
    expect(first.lastHeartbeatAt).toBeTruthy();

    // Repeat heartbeats update liveness but never the desired state.
    const second = await store.recordWorkflowDispatcherHeartbeat(heartbeat);
    expect(second.desiredState).toBe("paused");

    const resumed = await store.setWorkflowDispatcherDesiredState("wfd_test_1", "ready");
    expect(resumed?.desiredState).toBe("ready");

    // The next heartbeat — now reporting ready — sees the resumed desire.
    const third = await store.recordWorkflowDispatcherHeartbeat({
      ...heartbeat,
      state: "ready",
      readyAt: "2026-08-18T00:01:00.000Z",
    });
    expect(third.desiredState).toBe("ready");
    expect(third.readyAt).toBe("2026-08-18T00:01:00.000Z");

    expect(await store.setWorkflowDispatcherDesiredState("wfd_missing", "ready")).toBeNull();
  });

  test("an unpaused dispatcher registers ready and readable as the latest registration", async () => {
    const store = createTestStore();
    await store.recordWorkflowDispatcherHeartbeat({
      ...heartbeat,
      instanceId: "wfd_normal",
      state: "ready",
      readyAt: "2026-08-18T00:00:30.000Z",
    });

    const registration = await store.getWorkflowDispatcherRegistration();
    expect(registration).toMatchObject({
      instanceId: "wfd_normal",
      state: "ready",
      desiredState: "ready",
      worldDatabaseIdentity: "localhost:5432/eveland_workflow",
      protocolMin: 1,
      protocolMax: 1,
    });
  });
});
