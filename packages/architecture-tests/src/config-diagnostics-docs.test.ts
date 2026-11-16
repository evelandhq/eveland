import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { configurationDefinitions } from "@evelandhq/core/config-diagnostics";

/**
 * `docs/en/reference/environment-variables.md` is the operator-facing reference, and the
 * configuration registry is what the platform actually reads. Nothing tied the
 * two together, so the reference silently fell 24 variables behind -- including
 * every activation and scheduler tunable, and the admin bootstrap credentials.
 *
 * This is deliberately one-directional: the doc may describe things the
 * registry does not know about (test-only variables, Postgres role privileges
 * mentioned in prose), but a variable the platform reads must be documented.
 */
describe("environment variable reference", () => {
  const reference = readFileSync(
    path.resolve(import.meta.dirname, "../../../docs/en/reference/environment-variables.md"),
    "utf8",
  );

  test("documents every variable the configuration registry reads", () => {
    const undocumented = configurationDefinitions
      .map((definition) => definition.name)
      .filter((name) => !reference.includes(`\`${name}\``))
      .sort();

    expect(undocumented).toEqual([]);
  });

  // Not in the registry (no platform process reads them) but set by operators
  // and agent authors: the appliance root and the CLI's headless token.
  test("documents the host tooling variables operators set", () => {
    for (const name of ["EVELAND_HOME", "EVELAND_TOKEN"]) {
      expect(reference, name).toContain(`\`${name}\``);
    }
  });
});
