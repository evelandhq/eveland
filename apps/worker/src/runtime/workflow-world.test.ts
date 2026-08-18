import { describe, expect, test } from "vitest";

import { deriveWorkflowWorldAttestation, resolveWorkflowRunnerMode } from "./workflow-world.js";

/**
 * Capabilities are version facts: the shared world only scopes every enqueue
 * to the per-run queue since 0.5.0, so a classified historical artifact from
 * before that must attest `unscoped` and be managed-terminated, never resumed.
 */
describe("deriveWorkflowWorldAttestation", () => {
  test("a current shared world attests per_run_queue_v1", () => {
    expect(
      deriveWorkflowWorldAttestation({
        packageName: "@evelandhq/workflow-world",
        packageVersion: "0.11.0",
      }),
    ).toMatchObject({
      worldKind: "shared",
      enqueueCapability: "per_run_queue_v1",
      dispatchProtocol: 1,
    });
  });

  test("an early shared world attests unscoped, not per-run capable", () => {
    expect(
      deriveWorkflowWorldAttestation({
        packageName: "@evelandhq/workflow-world",
        packageVersion: "0.4.0",
      }),
    ).toMatchObject({
      worldKind: "shared",
      enqueueCapability: "unscoped",
      dispatchProtocol: null,
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
