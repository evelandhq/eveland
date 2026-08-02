import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { configurationDefinitions } from "@eveland/core/config-diagnostics";

/**
 * `docs/environment-variables.md` is the operator-facing reference, and the
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
    path.resolve(import.meta.dirname, "../../../docs/environment-variables.md"),
    "utf8",
  );

  test("documents every variable the configuration registry reads", () => {
    const undocumented = configurationDefinitions
      .map((definition) => definition.name)
      .filter((name) => !reference.includes(`\`${name}\``))
      .sort();

    expect(undocumented).toEqual([]);
  });
});
