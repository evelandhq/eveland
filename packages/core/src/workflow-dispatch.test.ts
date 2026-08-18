import { describe, expect, test } from "vitest";
import type { WorkflowDispatcherRegistration } from "./contracts.js";
import {
  assessDispatcherReadiness,
  worldDatabaseIdentitiesCompatible,
  worldDatabaseIdentity,
} from "./workflow-dispatch.js";

function registration(
  overrides: Partial<WorkflowDispatcherRegistration> = {},
): WorkflowDispatcherRegistration {
  return {
    instanceId: "wfd_test",
    generation: "test",
    state: "ready",
    ownershipAcquired: true,
    bootRecoveryCompleted: true,
    reenqueuedRuns: 0,
    worldDatabaseIdentity: "localhost:5432/eveland_workflow",
    schemaGeneration: null,
    protocolMin: 1,
    protocolMax: 1,
    cutoverOperationId: null,
    unscopedRunnableJobs: 0,
    unresolvedQuarantines: 0,
    desiredState: "ready",
    startedAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("assessDispatcherReadiness", () => {
  test("a fresh, owned, recovered, zero-unscoped ready dispatcher is ready", () => {
    expect(assessDispatcherReadiness(registration())).toEqual({ ready: true });
  });

  test("rejects a dispatcher claiming from the wrong World database", () => {
    // The Worker would inject database A while the dispatcher claims B —
    // durable turns would never be consumed no matter how fresh the heartbeat.
    const decision = assessDispatcherReadiness(
      registration({ worldDatabaseIdentity: "localhost:5432/eveland" }),
      { expectedWorldDatabaseIdentity: "host.docker.internal:5432/eveland_workflow" },
    );
    expect(decision.ready).toBe(false);
    if (!decision.ready) expect(decision.reason).toContain("claiming from");

    // Hosts may differ between network views of one server; name and port may not.
    expect(
      assessDispatcherReadiness(registration(), {
        expectedWorldDatabaseIdentity: "host.docker.internal:5432/eveland_workflow",
      }),
    ).toEqual({ ready: true });
  });

  test("rejects a dispatcher serving the wrong cutover operation", () => {
    const decision = assessDispatcherReadiness(
      registration({ cutoverOperationId: "cut_other", state: "ready_paused" }),
      { allowPaused: true, expectedOperationId: "cut_current" },
    );
    expect(decision.ready).toBe(false);
    if (!decision.ready) expect(decision.reason).toContain("cut_other");
  });

  test("claimable or uncounted unscoped jobs block readiness", () => {
    expect(assessDispatcherReadiness(registration({ unscopedRunnableJobs: 3 })).ready).toBe(false);
    expect(assessDispatcherReadiness(registration({ unscopedRunnableJobs: null })).ready).toBe(
      false,
    );
  });
});

describe("worldDatabaseIdentity", () => {
  test("keeps host, port and database; drops credentials", () => {
    expect(worldDatabaseIdentity("postgres://user:secret@db:6432/wf")).toBe("db:6432/wf");
    expect(worldDatabaseIdentity("postgres://db/wf")).toBe("db:5432/wf");
    expect(worldDatabaseIdentity("not a url")).toBe("unknown");
  });

  test("compatibility compares database name and port, never the host view", () => {
    expect(
      worldDatabaseIdentitiesCompatible("localhost:5432/wf", "host.docker.internal:5432/wf"),
    ).toBe(true);
    expect(worldDatabaseIdentitiesCompatible("localhost:5432/wf", "localhost:5432/other")).toBe(
      false,
    );
    expect(worldDatabaseIdentitiesCompatible("localhost:5432/wf", "localhost:6432/wf")).toBe(false);
    expect(worldDatabaseIdentitiesCompatible("unknown", "localhost:5432/wf")).toBe(false);
  });
});
