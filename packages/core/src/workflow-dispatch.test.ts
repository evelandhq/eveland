import { describe, expect, test } from "vitest";
import type { WorkflowDispatcherRegistration } from "./contracts.js";
import { assessDispatcherReadiness, clusterWorldIdentity } from "./workflow-dispatch.js";

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
    worldDatabaseIdentity: clusterWorldIdentity("7234567890123456789", "eveland_workflow"),
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
    // Identity is the database's own cluster fingerprint — never a URL, whose
    // host/port comparison fails open across unrelated servers.
    const decision = assessDispatcherReadiness(
      registration({
        worldDatabaseIdentity: clusterWorldIdentity("999", "eveland_workflow"),
      }),
      {
        expectedWorldDatabaseIdentity: clusterWorldIdentity(
          "7234567890123456789",
          "eveland_workflow",
        ),
      },
    );
    expect(decision.ready).toBe(false);
    if (!decision.ready) expect(decision.reason).toContain("claiming from");

    // A non-cluster (URL-shaped or unknown) identity never satisfies the gate.
    const urlShaped = assessDispatcherReadiness(
      registration({ worldDatabaseIdentity: "localhost:5432/eveland_workflow" }),
      { expectedWorldDatabaseIdentity: "localhost:5432/eveland_workflow" },
    );
    expect(urlShaped.ready).toBe(false);

    expect(
      assessDispatcherReadiness(registration(), {
        expectedWorldDatabaseIdentity: clusterWorldIdentity(
          "7234567890123456789",
          "eveland_workflow",
        ),
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

describe("clusterWorldIdentity", () => {
  test("cluster identity is stable across network views by construction", () => {
    expect(clusterWorldIdentity("7234", "wf")).toBe("cluster:7234/wf");
    expect(clusterWorldIdentity("7234", "wf")).not.toBe(clusterWorldIdentity("9999", "wf"));
    expect(clusterWorldIdentity("7234", "wf")).not.toBe(clusterWorldIdentity("7234", "other"));
  });
});
