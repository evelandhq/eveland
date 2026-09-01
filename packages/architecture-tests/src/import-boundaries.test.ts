import { describe, expect, test } from "vitest";
import { importSpecifiers, listSourceFiles, listWorkspaces, readSource } from "./scan-support.js";

// The dependency direction from AGENTS.md, enforced instead of documented.
// The matrix is TOTAL over packages/: a workspace missing here fails the
// suite, so a new package is born constrained instead of unratcheted.
const PACKAGE_DEPENDENCY_MATRIX: Record<string, string[]> = {
  "@evelandhq/core": [],
  "@evelandhq/db": ["@evelandhq/core"],
  "@evelandhq/agent-observer": ["@evelandhq/core"],
  "@evelandhq/agent-scheduler": ["@evelandhq/core"],
  "@evelandhq/architecture-tests": [],
  "@evelandhq/platform-observability": [],
  "@evelandhq/session-collector": ["@evelandhq/core", "@evelandhq/db"],
  "@evelandhq/agent-auth": ["@evelandhq/core", "@evelandhq/db"],
  "@evelandhq/identity-broker": ["@evelandhq/core", "@evelandhq/db"],
  // The CLI is a thin client of the public /api contract: it depends on no
  // workspace package so it stays runnable anywhere the source tree lands.
  "@evelandhq/cli": [],
  eveland: [],
};

const workspaces = listWorkspaces();
const appNames = new Set(
  workspaces.filter((workspace) => workspace.directory.startsWith("apps/")).map((w) => w.name),
);

function declaredWorkspaceDependencies(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const key of ["dependencies", "peerDependencies"]) {
    for (const dependency of Object.keys((manifest[key] as Record<string, string>) ?? {})) {
      names.add(dependency);
    }
  }
  return names;
}

// Standalone e2e fixtures are imported eve PROJECTS embedded as data, not
// workspace source: each declares its own `eve` (and identity-e2e the
// published `eveland`) exactly the way a customer project does, and the
// worker's tsconfig excludes them from compilation for the same reason. Their
// imports are the customer's imports, so the workspace boundary rules do not
// apply to them; the compatibility ratchet pins their dependency shape
// instead (eve-compatibility-consistency.test.ts).
function isStandaloneFixtureFile(file: string): boolean {
  return file.includes("/integration/fixtures/");
}

describe("workspace import boundaries", () => {
  test("no app imports another app, and nothing imports the published sdk", () => {
    const violations: string[] = [];
    for (const workspace of workspaces) {
      for (const file of listSourceFiles(`${workspace.directory}/src`)) {
        if (isStandaloneFixtureFile(file)) continue;
        for (const specifier of importSpecifiers(readSource(file))) {
          const packageName = specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : specifier.split("/")[0]!;
          if (appNames.has(packageName) && packageName !== workspace.name) {
            violations.push(`${file} imports app ${specifier}`);
          }
          if (packageName === "eveland" && workspace.name !== "eveland") {
            violations.push(`${file} imports the published sdk ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("no deep imports into another workspace's src", () => {
    // Production files only: test files may carry fixture import strings
    // (e.g. the scheduler injector's rewrite tests).
    const violations: string[] = [];
    for (const workspace of workspaces) {
      for (const file of listSourceFiles(`${workspace.directory}/src`)) {
        for (const specifier of importSpecifiers(readSource(file))) {
          if (/^@evelandhq\/[^/]+\/src\//.test(specifier)) {
            violations.push(`${file} deep-imports ${specifier}`);
          }
          if (specifier.startsWith(".")) {
            // A relative import must stay inside its own workspace.
            const resolved = new URL(specifier, `file:///${file}`).pathname.slice(1);
            if (!resolved.startsWith(`${workspace.directory}/`)) {
              violations.push(`${file} escapes its workspace via ${specifier}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("every @evelandhq import is a declared dependency, and declared package edges follow the matrix", () => {
    const violations: string[] = [];
    for (const workspace of workspaces) {
      const declared = declaredWorkspaceDependencies(workspace.manifest);
      for (const file of listSourceFiles(`${workspace.directory}/src`)) {
        for (const specifier of importSpecifiers(readSource(file))) {
          if (!specifier.startsWith("@evelandhq/")) continue;
          const packageName = specifier.split("/").slice(0, 2).join("/");
          if (packageName === workspace.name) continue;
          if (!declared.has(packageName)) {
            violations.push(`${file} imports undeclared ${packageName}`);
          }
        }
      }
      const allowed = PACKAGE_DEPENDENCY_MATRIX[workspace.name];
      if (!allowed && !workspace.directory.startsWith("apps/")) {
        violations.push(
          `${workspace.name} is not in the dependency matrix; add its allowed edges instead of leaving it unratcheted`,
        );
      }
      if (allowed) {
        for (const dependency of declaredWorkspaceDependencies(workspace.manifest)) {
          if (dependency.startsWith("@evelandhq/") && !allowed.includes(dependency)) {
            violations.push(
              `${workspace.name} declares ${dependency}, outside its allowed dependency direction`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("core exposes explicit browser-safe and Node-only subpaths without a root barrel", () => {
    const core = workspaces.find((workspace) => workspace.name === "@evelandhq/core");
    expect(core).toBeDefined();
    expect(core!.manifest.exports).toMatchObject({
      "./contracts": "./src/contracts.ts",
      "./discovery": "./src/discovery.ts",
      "./eve": "./src/eve.ts",
      "./ids": "./src/ids.ts",
      "./schedules": "./src/schedules.ts",
      "./source": "./src/source.ts",
      "./server/archive": "./src/server/archive.ts",
      "./server/secrets": "./src/server/secrets.ts",
    });
    expect(Object.hasOwn(core!.manifest.exports as object, ".")).toBe(false);
  });

  test("db owns the store, store factory, and schema entrypoints", () => {
    const db = workspaces.find((workspace) => workspace.name === "@evelandhq/db");
    expect(db).toBeDefined();
    expect(db!.manifest.exports).toMatchObject({
      ".": "./src/store.ts",
      "./factory": "./src/store-factory.ts",
      "./schema": "./src/schema.ts",
    });
  });
});
