import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("publishes the authentication helper from eveland/auth", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    name?: string;
    exports?: Record<string, unknown>;
  };

  expect(packageJson.name).toBe("eveland");
  expect(packageJson.exports).toHaveProperty("./auth");
});

test("publishes the memory backend from eveland/memory", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    exports?: Record<string, unknown>;
  };

  expect(packageJson.exports).toHaveProperty("./memory");
});

// The CLI is the package's second published face. It is reached through `bin`,
// not through `exports`, so nothing else in the suite would notice a bin that
// points at a path `pnpm build` does not produce -- a defect that only shows up
// after publishing.
test("publishes the eveland CLI as the package bin, pointing into the build output", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { bin?: Record<string, string>; files?: string[] };

  expect(packageJson.bin?.eveland).toBe("./dist/cli/bin.js");
  expect(packageJson.files).toContain("dist");

  const buildConfig = JSON.parse(
    await readFile(new URL("../tsconfig.build.json", import.meta.url), "utf8"),
  ) as { include?: string[] };
  expect(buildConfig.include).toContain("src/cli/bin.ts");
});

// The CLI also runs straight from source (`pnpm eveland`, and eveland-ctl's
// first-boot seeding), which is only possible while the package stays
// type-strippable and its relative imports keep the `.ts` specifiers that
// rewriteRelativeImportExtensions turns into `.js` for dist/.
test("keeps the package runnable from source as well as from dist", async () => {
  const tsconfig = JSON.parse(
    await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
  ) as { compilerOptions?: Record<string, unknown> };

  expect(tsconfig.compilerOptions?.erasableSyntaxOnly).toBe(true);
  expect(tsconfig.compilerOptions?.allowImportingTsExtensions).toBe(true);
  expect(tsconfig.compilerOptions?.rewriteRelativeImportExtensions).toBe(true);
});
