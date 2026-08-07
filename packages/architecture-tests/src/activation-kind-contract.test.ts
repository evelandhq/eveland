import { describe, expect, test } from "vitest";
import { readSource } from "./scan-support.js";

/**
 * An activation kind has to be spelled the same way in four places, and nothing
 * connects them at compile time:
 *
 *   * the `ActivationLeaseKind` union in core's contracts;
 *   * the request schema the internal API validates against;
 *   * the check constraint on `activation_leases`;
 *   * the literal each caller sends.
 *
 * The workflow dispatcher first shipped asking for `kind: "workflow"`, which
 * the last two rejected — no activation could succeed, so no step could ever
 * run, and every unit test passed because the client was faked. This asserts
 * the places agree for each kind that is requested over the internal API.
 *
 * The fourth place for `workflow_step` is `@evelandhq/workflow-world`'s
 * dispatcher. Its literal joins this suite once the worker depends on the
 * package; until then `sentFrom` records where the request comes from.
 */
const REQUESTED_KINDS: Array<{ kind: string; sentFrom: string; literalSource?: string }> = [
  { kind: "workflow_step", sentFrom: "@evelandhq/workflow-world dispatcher.ts" },
];

describe("activation lease kinds", () => {
  const contracts = readSource("packages/core/src/contracts.ts");
  const apiSchema = readSource("apps/api/src/app-schemas.ts");
  const dbSchema = readSource("packages/db/src/schema.ts");

  const constraint = /activation_leases_kind_check[\s\S]{0,200}?in \(([^)]*)\)/.exec(dbSchema);
  const requestEnum = /runtimeActivationSchema[\s\S]{0,300}?kind: z\.enum\(\[([^\]]*)\]\)/.exec(
    apiSchema,
  );

  test("the sources this test scans still look the way it expects", () => {
    // A silent regex miss would turn every assertion below into a no-op.
    expect(constraint, "could not find activation_leases_kind_check").not.toBeNull();
    expect(requestEnum, "could not find runtimeActivationSchema's kind enum").not.toBeNull();
    expect(contracts).toContain("ActivationLeaseKind");
  });

  for (const { kind, sentFrom, literalSource } of REQUESTED_KINDS) {
    describe(kind, () => {
      test(`is a declared ActivationLeaseKind (requested by ${sentFrom})`, () => {
        expect(contracts).toContain(`"${kind}"`);
      });

      test("is accepted by the internal API's request schema", () => {
        expect(requestEnum?.[1]).toContain(`"${kind}"`);
      });

      test("is permitted by the activation_leases check constraint", () => {
        expect(constraint?.[1]).toContain(`'${kind}'`);
      });

      if (literalSource !== undefined) {
        test("is actually the literal the caller sends", () => {
          expect(readSource(literalSource)).toContain(`kind: "${kind}"`);
        });
      }
    });
  }
});
