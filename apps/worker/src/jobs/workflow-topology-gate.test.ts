import { describe, expect, test } from "vitest";

import { assessWorkflowLaunch } from "./workflow-topology-gate.js";

function release(worldKind: "shared" | "legacy_project" | "unknown") {
  return {
    id: "rel_gate",
    workflow: {
      worldKind,
      worldPackage: worldKind === "shared" ? "@evelandhq/workflow-world" : null,
      worldVersion: worldKind === "shared" ? "0.11.0" : null,
      storageSpec: worldKind === "shared" ? 6 : null,
      dispatchProtocol: worldKind === "shared" ? 1 : null,
      enqueueCapability:
        worldKind === "shared" ? ("per_run_queue_v1" as const) : ("unknown" as const),
    },
  };
}

describe("assessWorkflowLaunch", () => {
  test("a shared build launches on the shared world", () => {
    expect(assessWorkflowLaunch(release("shared"))).toEqual({
      allowed: true,
      workflowWorldKind: "shared",
    });
  });

  test("an unattested historical release fails closed with a managed reason", () => {
    const decision = assessWorkflowLaunch(release("unknown"));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("workflow_migration_required");
      expect(decision.reason).toContain("rel_gate");
    }
  });

  test("a legacy release is never launched again", () => {
    const decision = assessWorkflowLaunch(release("legacy_project"));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("workflow_unavailable");
  });
});
