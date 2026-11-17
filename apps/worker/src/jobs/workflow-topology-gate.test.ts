import { describe, expect, test } from "vitest";

import { assessWorkflowLaunch } from "./workflow-topology-gate.js";

function release(worldKind: "shared" | "unknown") {
  return {
    id: "rel_gate",
    workflow: {
      worldKind,
      worldPackage: worldKind === "shared" ? "@evelandhq/workflow-world" : null,
      worldVersion: worldKind === "shared" ? "2.0.0" : null,
      storageSpec: worldKind === "shared" ? 9 : null,
      dispatchProtocol: worldKind === "shared" ? 2 : null,
    },
  };
}

describe("assessWorkflowLaunch", () => {
  test("a shared build launches on the shared world", () => {
    expect(assessWorkflowLaunch(release("shared"))).toEqual({ allowed: true });
  });

  test("an unattested release fails closed with a managed reason", () => {
    const decision = assessWorkflowLaunch(release("unknown"));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("workflow_unavailable");
      expect(decision.reason).toContain("rel_gate");
    }
  });
});
