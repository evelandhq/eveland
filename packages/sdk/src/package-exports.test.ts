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
