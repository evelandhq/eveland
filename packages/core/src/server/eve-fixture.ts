import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LATEST_VERIFIED_EVE_VERSION } from "../eve-compatibility.js";

const EVE_CATALOG_MARKER = "catalog:";

type FixturePackageJson = {
  dependencies?: Record<string, unknown>;
};

export function materializeEveFixturePackageJson(
  packageJson: string,
  eveVersion = LATEST_VERIFIED_EVE_VERSION,
): string {
  const manifest = JSON.parse(packageJson) as FixturePackageJson;
  const currentSpecifier = manifest.dependencies?.eve;
  if (currentSpecifier === eveVersion) return packageJson;
  if (currentSpecifier !== EVE_CATALOG_MARKER) {
    throw new Error(
      `Eve integration fixtures must declare the Eve catalog marker (${EVE_CATALOG_MARKER}).`,
    );
  }

  manifest.dependencies = {
    ...manifest.dependencies,
    eve: eveVersion,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function materializeEveFixtureDirectory(
  sourceDirectory: string,
  destinationDirectory: string,
  eveVersion = LATEST_VERIFIED_EVE_VERSION,
): Promise<string> {
  await cp(sourceDirectory, destinationDirectory, { recursive: true });
  const packagePath = path.join(destinationDirectory, "package.json");
  const packageJson = await readFile(packagePath, "utf8");
  await writeFile(
    packagePath,
    materializeEveFixturePackageJson(packageJson, eveVersion),
  );
  return destinationDirectory;
}
