import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { listWorkspaces } from "./scan-support.js";

/**
 * `@eveland/workflow-world` is the one package that is both published to npm
 * *and* imported by workspace TypeScript. Those two consumers want different
 * entry points:
 *
 *   * the workspace needs source, because nothing builds it before `pnpm -r
 *     typecheck` runs — pointing `exports` at `dist/` made every worker test
 *     fail to resolve it in CI;
 *   * the tarball needs `dist/`, because `src/` is not in `files`.
 *
 * pnpm bridges this by substituting `publishConfig.exports` at pack time. That
 * substitution is invisible day to day, so this test is what stops a newly
 * added export from shipping a path that does not exist in the tarball.
 */
const repoRoot = path.resolve(import.meta.dirname, "../../..");

type Manifest = {
  name: string;
  private?: boolean;
  files?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { exports?: Record<string, unknown> };
};

function readManifest(directory: string): Manifest {
  return JSON.parse(
    readFileSync(path.join(repoRoot, directory, "package.json"), "utf8"),
  ) as Manifest;
}

function collectPaths(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectPaths(entry, into);
  }
  return into;
}

describe("publishable packages that workspace code imports", () => {
  const published = listWorkspaces()
    .map((workspace) => ({ workspace, manifest: readManifest(workspace.directory) }))
    .filter(({ manifest }) => manifest.private !== true && manifest.exports);

  test("there is at least one such package to check", () => {
    expect(published.length).toBeGreaterThan(0);
  });

  for (const { workspace, manifest } of published) {
    describe(manifest.name, () => {
      const sourceExports = collectPaths(manifest.exports);
      const importsSource = sourceExports.some((entry) => entry.includes("/src/"));

      test.skipIf(!importsSource)("declares publishConfig.exports for every export key", () => {
        // Only relevant for packages whose workspace exports point at src: a
        // package already exporting dist needs no substitution.
        expect(Object.keys(manifest.publishConfig?.exports ?? {}).sort()).toEqual(
          Object.keys(manifest.exports ?? {}).sort(),
        );
      });

      test.skipIf(!importsSource)("publishConfig.exports never points at src", () => {
        for (const entry of collectPaths(manifest.publishConfig?.exports)) {
          expect(entry, `${manifest.name} publishes ${entry}`).not.toContain("/src/");
        }
      });

      test.skipIf(!importsSource)("ships every directory its published exports use", () => {
        const shipped = new Set(manifest.files ?? []);
        for (const entry of collectPaths(manifest.publishConfig?.exports)) {
          const topLevel = entry.replace(/^\.\//, "").split("/")[0];
          expect(shipped.has(topLevel!), `${entry} is not covered by "files"`).toBe(true);
        }
      });

      test("builds before packing", () => {
        // dist only exists because prepack made it; without this the tarball
        // would ship a package.json pointing at files that are not there.
        const scripts = (
          JSON.parse(
            readFileSync(path.join(repoRoot, workspace.directory, "package.json"), "utf8"),
          ) as { scripts?: Record<string, string> }
        ).scripts;
        if (!importsSource) return;
        expect(scripts?.prepack, `${manifest.name} needs a prepack that builds`).toBeTruthy();
      });
    });
  }
});
