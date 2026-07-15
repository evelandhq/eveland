import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("published Eve compatibility", () => {
  test("pins development coverage to Eve 0.24.2 and advertises only the verified 0.24 range", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as {
      devDependencies: { eve: string };
      peerDependencies: { eve: string };
    };

    expect(packageJson.devDependencies.eve).toBe("0.24.2");
    expect(packageJson.peerDependencies.eve).toBe(">=0.24.0 <0.25.0");
  });
});
