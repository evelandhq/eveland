import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("published Eve compatibility", () => {
  test("tracks the Eve 0.24.x line in development and advertises only the verified 0.24 range", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as {
      devDependencies: { eve: string };
      peerDependencies: { eve: string };
    };

    expect(packageJson.devDependencies.eve).toBe("0.24.x");
    expect(packageJson.peerDependencies.eve).toBe(">=0.24.0 <0.25.0");
  });
});
