import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

type FixtureModule = {
  materializeEveFixturePackageJson?: (packageJson: string, eveVersion?: string) => string;
  materializeEveFixtureDirectory?: (
    sourceDirectory: string,
    destinationDirectory: string,
    eveVersion?: string,
  ) => Promise<string>;
};

async function materializer() {
  const fixtureModule = (await import("./eve-fixture.js")) as FixtureModule;
  expect(fixtureModule.materializeEveFixturePackageJson).toBeTypeOf("function");
  return fixtureModule.materializeEveFixturePackageJson!;
}

async function directoryMaterializer() {
  const fixtureModule = (await import("./eve-fixture.js")) as FixtureModule;
  expect(fixtureModule.materializeEveFixtureDirectory).toBeTypeOf("function");
  return fixtureModule.materializeEveFixtureDirectory!;
}

describe("Eve integration fixture materialization", () => {
  test("replaces the catalog marker with the requested verified patch", async () => {
    const materialize = await materializer();
    const source = `${JSON.stringify(
      {
        name: "fixture",
        private: true,
        dependencies: { ai: "^7.0.0", eve: "catalog:" },
      },
      null,
      2,
    )}\n`;

    expect(materialize(source, "0.32.999")).toBe(
      source.replace('"eve": "catalog:"', '"eve": "0.32.999"'),
    );
  });

  test("is stable when the fixture is already materialized", async () => {
    const materialize = await materializer();
    const source = `${JSON.stringify(
      { name: "fixture", dependencies: { eve: "0.32.999" } },
      null,
      2,
    )}\n`;

    expect(materialize(source, "0.32.999")).toBe(source);
  });

  test("rejects an unmanaged Eve dependency instead of overwriting it", async () => {
    const materialize = await materializer();
    const source = `${JSON.stringify(
      { name: "fixture", dependencies: { eve: "^0.32.0" } },
      null,
      2,
    )}\n`;

    expect(() => materialize(source, "0.32.999")).toThrow(/must declare the Eve catalog marker/);
  });

  test("copies a fixture and materializes only its Eve dependency", async () => {
    const materializeDirectory = await directoryMaterializer();
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-eve-fixture-test-"));
    const sourceDirectory = path.join(temporaryRoot, "source");
    const destinationDirectory = path.join(temporaryRoot, "materialized");
    await mkdir(path.join(sourceDirectory, "agent"), { recursive: true });
    await writeFile(
      path.join(sourceDirectory, "package.json"),
      `${JSON.stringify({ name: "fixture", dependencies: { eve: "catalog:" } }, null, 2)}\n`,
    );
    await writeFile(path.join(sourceDirectory, "agent", "agent.ts"), "export default {};\n");

    try {
      await expect(
        materializeDirectory(sourceDirectory, destinationDirectory, "0.32.999"),
      ).resolves.toBe(destinationDirectory);
      await expect(
        readFile(path.join(destinationDirectory, "package.json"), "utf8"),
      ).resolves.toContain('"eve": "0.32.999"');
      await expect(
        readFile(path.join(destinationDirectory, "agent", "agent.ts"), "utf8"),
      ).resolves.toBe("export default {};\n");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
