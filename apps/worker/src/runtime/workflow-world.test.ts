import { describe, expect, test } from "vitest";

import { deriveWorkflowWorldAttestation } from "./workflow-world.js";

describe("deriveWorkflowWorldAttestation", () => {
  test("the shared world attests spec 9 and dispatch protocol 2", () => {
    expect(
      deriveWorkflowWorldAttestation({
        packageName: "@evelandhq/workflow-world",
        packageVersion: "2.0.0",
      }),
    ).toEqual({
      worldKind: "shared",
      worldPackage: "@evelandhq/workflow-world",
      worldVersion: "2.0.0",
      storageSpec: 9,
      dispatchProtocol: 2,
    });
  });

  test("any other world package is unknown", () => {
    expect(
      deriveWorkflowWorldAttestation({ packageName: "something-else", packageVersion: "2.0.0" }),
    ).toMatchObject({ worldKind: "unknown", storageSpec: null, dispatchProtocol: null });
  });
});
