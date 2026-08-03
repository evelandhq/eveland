import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("semantic links", () => {
  test("does not render a Link through Button", () => {
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    const violations = globSync("**/*.tsx", { cwd: sourceRoot }).filter((path) =>
      /<Button\b[^>]*render=\{<Link\b/s.test(readFileSync(resolve(sourceRoot, path), "utf8")),
    );

    expect(violations).toEqual([]);
  });
});
