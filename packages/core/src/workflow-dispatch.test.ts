import { describe, expect, test } from "vitest";
import type { WorkflowDispatcherRegistration } from "./contracts.js";
import {
  assessDispatcherReadiness,
  clusterWorldIdentity,
  isSupportedWorkflowStorageSpec,
  permanentDeploymentActivationRefusal,
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
  test("admits the single orchestrator (9) the shared World serves, nothing else", () => {
    expect(isSupportedWorkflowStorageSpec(9)).toBe(true);
    expect(isSupportedWorkflowStorageSpec(8)).toBe(false);
    expect(isSupportedWorkflowStorageSpec(6)).toBe(false);
    expect(isSupportedWorkflowStorageSpec(10)).toBe(false);
    expect(isSupportedWorkflowStorageSpec(null)).toBe(false);
  });
});

describe("permanentDeploymentActivationRefusal", () => {
  test("refuses a missing, archiving, or archived Deployment", () => {
    expect(permanentDeploymentActivationRefusal(null)).toBe("Deployment no longer exists.");
    expect(permanentDeploymentActivationRefusal(undefined)).toBe("Deployment no longer exists.");
    for (const status of ["archiving", "archived"]) {
      expect(permanentDeploymentActivationRefusal({ id: "dep_x", status })).toContain(
        `dep_x is ${status}`,
      );
    }
  });

  test("a transiently failed or stopped Deployment is NOT permanent: its next activation restarts it", () => {
    for (const status of ["failed", "stopped", "running"]) {
      expect(permanentDeploymentActivationRefusal({ id: "dep_x", status })).toBeNull();
    }
  });
});
