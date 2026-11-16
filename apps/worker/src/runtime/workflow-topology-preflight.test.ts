import { describe, expect, test } from "vitest";

import { assertWorkflowTopologyPreflight } from "./workflow-topology-preflight.js";

/**
 * The shared workflow World is the only topology new builds get, so production
 * requires its URL and fails closed without it.
 */
describe("assertWorkflowTopologyPreflight", () => {
  test("production without the shared world URL fails closed", () => {
    expect(() => assertWorkflowTopologyPreflight({ NODE_ENV: "production" })).toThrow(
      /WORKFLOW_WORLD_URL/,
    );
  });

  test("production with the shared world URL passes", () => {
    expect(() =>
      assertWorkflowTopologyPreflight({
        NODE_ENV: "production",
        WORKFLOW_WORLD_URL: "postgres://world@host:5432/eveland_workflow",
      }),
    ).not.toThrow();
  });

  test("development without any workflow database configured passes", () => {
    expect(() => assertWorkflowTopologyPreflight({})).not.toThrow();
  });
});
