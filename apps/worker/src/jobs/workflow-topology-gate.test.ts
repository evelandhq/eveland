import { describe, expect, test } from "vitest";

import { assessWorkflowArchive, assessWorkflowLaunch } from "./workflow-topology-gate.js";

function release(worldKind: "shared" | "legacy_project" | "unknown") {
  return {
    id: "rel_gate",
    workflow: {
      worldKind,
      worldPackage: worldKind === "shared" ? "@evelandhq/workflow-world" : null,
      worldVersion: worldKind === "shared" ? "0.10.0" : null,
      storageSpec: worldKind === "shared" ? 6 : null,
      dispatchProtocol: worldKind === "shared" ? 1 : null,
      enqueueCapability:
        worldKind === "shared" ? ("per_run_queue_v1" as const) : ("unknown" as const),
    },
  };
}

function deployment(
  conversionState: "unclassified" | "fenced" | "converting" | "external" | "blocked" | "terminated",
) {
  return {
    id: "dep_gate",
    workflowTopology: {
      runnerMode: conversionState === "external" ? ("external" as const) : ("unknown" as const),
      conversionState,
      conversionOperationId: null,
      runnerEvidence: null,
      convertedAt: null,
    },
  };
}

describe("assessWorkflowLaunch", () => {
  test("a converted shared deployment launches on the shared world", () => {
    expect(assessWorkflowLaunch(release("shared"), deployment("external"))).toEqual({
      allowed: true,
      workflowWorldKind: "shared",
    });
  });

  test("an unclassified historical deployment fails closed with a managed reason", () => {
    const decision = assessWorkflowLaunch(release("unknown"), deployment("unclassified"));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("workflow_migration_required");
      expect(decision.reason).toContain("rel_gate");
    }
  });

  test("a legacy release is never launched again", () => {
    const decision = assessWorkflowLaunch(release("legacy_project"), deployment("unclassified"));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("workflow_unavailable");
  });

  test("a shared deployment still mid-conversion may not start", () => {
    for (const state of ["unclassified", "fenced", "converting", "blocked"] as const) {
      const decision = assessWorkflowLaunch(release("shared"), deployment(state));
      expect(decision.allowed).toBe(false);
    }
  });
});

describe("assessWorkflowArchive", () => {
  test("shared deployments and completed terminations may archive", () => {
    expect(assessWorkflowArchive(release("shared"), deployment("external")).allowed).toBe(true);
    expect(assessWorkflowArchive(release("legacy_project"), deployment("terminated")).allowed).toBe(
      true,
    );
  });

  test("unknown and unterminated legacy topologies keep their artifact", () => {
    expect(assessWorkflowArchive(release("unknown"), deployment("unclassified")).allowed).toBe(
      false,
    );
    expect(
      assessWorkflowArchive(release("legacy_project"), deployment("unclassified")).allowed,
    ).toBe(false);
  });
});
