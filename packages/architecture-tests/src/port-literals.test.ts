import { describe, expect, test } from "vitest";
import { listSourceFiles, listWorkspaces, readSource } from "./scan-support.js";

/**
 * Port-literal ratchet: every default port the platform binds or dials lives
 * in @evelandhq/core/ports, and product code must import it from there. Bare
 * literals are how the pre-17300 defaults (3000/4000/4080/5432/...) crept
 * into a dozen files each — and how a collision becomes a silent
 * wrong-service connection instead of a startup failure (#167). The scan
 * covers the retired legacy ports too, so none of them can creep back in.
 */
const PORT_LITERAL =
  /(?<!\d)(3000|3001|4000|4080|4090|4317|4318|4327|4328|5432|41000|55432|17300|17301|17302|17303|17310|17311|17312|17313|17314|17350|18000)(?!\d)/;

const EXEMPT_FILES = new Set([
  // The single source of truth these literals are required to live in.
  "packages/core/src/ports.ts",
]);

/** Smoke/e2e harnesses pin environment-specific fixture addresses (for
 * example a natively installed PostgreSQL on its stock 5432). */
const EXEMPT_DIRECTORIES = [/\/integration\//];

describe("port literals", () => {
  test("product code imports ports from @evelandhq/core/ports instead of repeating literals", () => {
    const violations: string[] = [];
    for (const workspace of listWorkspaces()) {
      for (const file of listSourceFiles(`${workspace.directory}/src`)) {
        if (EXEMPT_FILES.has(file)) continue;
        if (EXEMPT_DIRECTORIES.some((pattern) => pattern.test(file))) continue;
        const lines = readSource(file).split("\n");
        for (const [index, line] of lines.entries()) {
          if (PORT_LITERAL.test(line)) violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
