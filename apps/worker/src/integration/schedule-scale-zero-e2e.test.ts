import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("schedule scale-to-zero integration harness", () => {
  test("pins the real fixture to Eve 0.27.3 and runs it in the Linux smoke", async () => {
    const [fixturePackage, integrationScript, e2eScript] = await Promise.all([
      readFile(new URL("../../../../infra/integration/fixtures/schedule-scale-zero/package.json", import.meta.url), "utf8"),
      readFile(new URL("../../../../infra/integration/run.sh", import.meta.url), "utf8"),
      readFile(new URL("../../../../infra/integration/schedule-scale-zero-e2e.mts", import.meta.url), "utf8"),
    ]);

    expect(JSON.parse(fixturePackage)).toMatchObject({ dependencies: { eve: "0.27.3" } });
    expect(integrationScript).toContain("schedule-scale-zero-e2e.mts");
    expect(e2eScript).toContain("SCHEDULE SCALE TO ZERO E2E OK");
    for (const proof of [
      "dormant=1",
      "cronRuns=1",
      "sessions=2",
      "nativeDuplicates=0",
      "idleStopped=1",
      "continuationWoke=1",
    ]) {
      expect(e2eScript).toContain(proof);
    }
  });
});
