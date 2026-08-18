import { describe, expect, test } from "vitest";

import { resolveWorkflowRunnerMode } from "./workflow-world.js";

/**
 * The external-only runner contract (issue #278 cutover): every new build is
 * dispatched by the single external dispatcher. `embedded` let multiple
 * deployments of one project claim and replay each other's runs, so an
 * explicit request for it is a configuration error, never a silent fallback.
 */
describe("resolveWorkflowRunnerMode", () => {
  test("defaults to the external dispatcher when no runner is configured", () => {
    expect(resolveWorkflowRunnerMode({})).toBe("external");
    expect(resolveWorkflowRunnerMode({ EVELAND_WORKFLOW_RUNNER: "" })).toBe("external");
  });

  test("accepts an explicit external runner", () => {
    expect(resolveWorkflowRunnerMode({ EVELAND_WORKFLOW_RUNNER: "external" })).toBe("external");
  });

  test("fails closed on an explicit embedded runner instead of silently falling back", () => {
    expect(() => resolveWorkflowRunnerMode({ EVELAND_WORKFLOW_RUNNER: "embedded" })).toThrow(
      /embedded.*not supported|no longer supported.*embedded|embedded/i,
    );
  });

  test("rejects unknown runner modes", () => {
    expect(() => resolveWorkflowRunnerMode({ EVELAND_WORKFLOW_RUNNER: "sideways" })).toThrow(
      /sideways/,
    );
  });
});
