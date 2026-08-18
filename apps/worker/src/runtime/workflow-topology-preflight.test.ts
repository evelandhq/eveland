import { describe, expect, test } from "vitest";

import { assertWorkflowTopologyPreflight } from "./workflow-topology-preflight.js";

/**
 * External-only production preflight: the shared workflow World is the only
 * topology new builds get, so production requires its URL and no longer
 * requires the legacy `WORKFLOW_POSTGRES_URL` at all. Both directions fail
 * closed rather than degrading into a topology nothing provisions.
 */
describe("assertWorkflowTopologyPreflight", () => {
  test("production without the shared world URL fails closed", () => {
    expect(() => assertWorkflowTopologyPreflight({ NODE_ENV: "production" })).toThrow(
      /EVELAND_WORKFLOW_WORLD_URL/,
    );
  });

  test("the legacy database URL no longer satisfies the production requirement", () => {
    expect(() =>
      assertWorkflowTopologyPreflight({
        NODE_ENV: "production",
        WORKFLOW_POSTGRES_URL: "postgres://legacy@host:5432/eveland",
      }),
    ).toThrow(/EVELAND_WORKFLOW_WORLD_URL/);
  });

  test("production with the shared world URL passes without a legacy URL", () => {
    expect(() =>
      assertWorkflowTopologyPreflight({
        NODE_ENV: "production",
        EVELAND_WORKFLOW_WORLD_URL: "postgres://world@host:5432/eveland_workflow",
      }),
    ).not.toThrow();
  });

  test("development without any workflow database configured passes", () => {
    expect(() => assertWorkflowTopologyPreflight({})).not.toThrow();
  });

  test("an embedded runner is a configuration error in any environment", () => {
    expect(() =>
      assertWorkflowTopologyPreflight({
        EVELAND_WORKFLOW_WORLD_URL: "postgres://world@host:5432/eveland_workflow",
        EVELAND_WORKFLOW_RUNNER: "embedded",
      }),
    ).toThrow(/embedded/i);
    expect(() =>
      assertWorkflowTopologyPreflight({
        NODE_ENV: "production",
        EVELAND_WORKFLOW_WORLD_URL: "postgres://world@host:5432/eveland_workflow",
        EVELAND_WORKFLOW_RUNNER: "embedded",
      }),
    ).toThrow(/embedded/i);
  });
});
