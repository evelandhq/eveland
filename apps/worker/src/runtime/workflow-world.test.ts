import { describe, expect, test } from "vitest";

import { deriveWorkflowWorldAttestation, resolveWorkflowRunnerMode } from "./workflow-world.js";

describe("deriveWorkflowWorldAttestation", () => {
  test("the shared world attests spec 9 over the per-run queue protocol", () => {
    expect(
      deriveWorkflowWorldAttestation({
        packageName: "@evelandhq/workflow-world",
        packageVersion: "1.0.0",
      }),
    ).toEqual({
      worldKind: "shared",
      worldPackage: "@evelandhq/workflow-world",
      worldVersion: "1.0.0",
      storageSpec: 9,
      dispatchProtocol: 1,
      enqueueCapability: "per_run_queue_v1",
    });
  });

  test("the legacy world is legacy_project/unscoped and anything else unknown", () => {
    expect(
      deriveWorkflowWorldAttestation({
        packageName: "@workflow/world-postgres",
        packageVersion: "5.0.0-beta.34",
      }),
    ).toMatchObject({ worldKind: "legacy_project", enqueueCapability: "unscoped" });
    expect(
      deriveWorkflowWorldAttestation({ packageName: "something-else", packageVersion: "1.0.0" }),
    ).toMatchObject({ worldKind: "unknown", enqueueCapability: "unknown" });
  });
});

/**
 * The external-only runner contract (issue #278): every new build is
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
