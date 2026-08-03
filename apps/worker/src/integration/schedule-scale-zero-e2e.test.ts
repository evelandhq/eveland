import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_VERIFIED_EVE_VERSION } from "@eveland/core/eve-compatibility";
import { materializeEveFixtureDirectory } from "@eveland/core/server/eve-fixture";
import { describe, expect, test } from "vitest";

describe("schedule scale-to-zero integration harness", () => {
  test("materializes the latest verified Eve fixture before the Linux smoke", async () => {
    const fixtureTemplate = new URL(
      "../../../../infra/integration/fixtures/schedule-scale-zero",
      import.meta.url,
    );
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-schedule-harness-test-"));
    const materializedFixture = path.join(temporaryRoot, "source");
    try {
      await materializeEveFixtureDirectory(fileURLToPath(fixtureTemplate), materializedFixture);
      const [fixturePackage, integrationScript, e2eScript] = await Promise.all([
        readFile(path.join(materializedFixture, "package.json"), "utf8"),
        readFile(new URL("../../../../infra/integration/run.sh", import.meta.url), "utf8"),
        readFile(
          new URL("../../../../infra/integration/schedule-scale-zero-e2e.mts", import.meta.url),
          "utf8",
        ),
      ]);

      expect(JSON.parse(fixturePackage)).toMatchObject({
        dependencies: { eve: LATEST_VERIFIED_EVE_VERSION },
      });
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
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
