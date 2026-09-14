import { describe, expect, test } from "vitest";
import type { WorkflowDispatcherRegistration } from "./contracts.js";
import {
  assessDispatcherReadiness,
  clusterWorldIdentity,
  isSupportedWorkflowStorageSpec,
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
    worldDatabaseIdentity: clusterWorldIdentity("7234567890123456789", "eveland_workflow"),
    schemaGeneration: null,
    protocolMin: 1,
    protocolMax: 1,
    startedAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("assessDispatcherReadiness", () => {
  test("a fresh, owned, recovered ready dispatcher is ready", () => {
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

  test("a dispatcher that is not ready blocks readiness no matter how fresh", () => {
    for (const state of ["recovering", "draining", "failed", "stopped"] as const) {
      const decision = assessDispatcherReadiness(registration({ state }));
      expect(decision.ready).toBe(false);
      if (!decision.ready) expect(decision.reason).toContain(state);
    }
  });
});

describe("clusterWorldIdentity", () => {
  test("cluster identity is stable across network views by construction", () => {
    expect(clusterWorldIdentity("7234", "wf")).toBe("cluster:7234/wf");
    expect(clusterWorldIdentity("7234", "wf")).not.toBe(clusterWorldIdentity("9999", "wf"));
    expect(clusterWorldIdentity("7234", "wf")).not.toBe(clusterWorldIdentity("7234", "other"));
  });
});

describe("isSupportedWorkflowStorageSpec", () => {
  test("admits slot identity (6) and the sealed log (7), nothing older or unknown", () => {
    // 6 is what shared builds 0.5.0 through 0.17.0 attest and what a 0.18.0+
    // Deployment declares under WORKFLOW_SEALED_LOG=0; 7 is the 0.18.0 default.
    // Every Eve line in the window reads both, so a Release on either must
    // still activate. Spec 5 predates per-run queues and is retired.
    expect(isSupportedWorkflowStorageSpec(6)).toBe(true);
    expect(isSupportedWorkflowStorageSpec(7)).toBe(true);
    expect(isSupportedWorkflowStorageSpec(5)).toBe(false);
    expect(isSupportedWorkflowStorageSpec(8)).toBe(false);
    expect(isSupportedWorkflowStorageSpec(null)).toBe(false);
  });
});
