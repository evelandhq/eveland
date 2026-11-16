import { describe, expect, test } from "vitest";

import { deriveWorkflowWorldAttestation } from "./workflow-world.js";

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

  test("any other world package is unknown", () => {
    expect(
      deriveWorkflowWorldAttestation({ packageName: "something-else", packageVersion: "1.0.0" }),
    ).toMatchObject({ worldKind: "unknown", enqueueCapability: "unknown" });
  });
});
