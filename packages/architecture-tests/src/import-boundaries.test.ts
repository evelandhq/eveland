import { describe, expect, test } from "vitest";
import { importSpecifiers, listSourceFiles, listWorkspaces, readSource } from "./scan-support.js";

// The dependency direction from AGENTS.md, enforced instead of documented.
// The matrix is TOTAL over packages/: a workspace missing here fails the
// suite, so a new package is born constrained instead of unratcheted.
const PACKAGE_DEPENDENCY_MATRIX: Record<string, string[]> = {
  "@eveland/core": [],
  "@eveland/db": ["@eveland/core"],
  "@eveland/agent-observer": ["@eveland/core"],
  "@eveland/agent-scheduler": ["@eveland/core"],
  "@eveland/architecture-tests": [],
  "@eveland/platform-observability": [],
  "@eveland/sandbox-bwrap": [],
  "@eveland/session-collector": ["@eveland/core", "@eveland/db"],
  "@eveland/agent-auth": ["@eveland/core", "@eveland/db"],
  "@eveland/identity-broker": ["@eveland/core", "@eveland/db"],
  // Published to npm and installed *into agent deployments* at build time, so
  // it must not reach back into the platform: no @eveland/core, no @eveland/db.
  // Its only contract is @workflow/*.
  "@eveland/workflow-world": [],
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

describe("workspace import boundaries", () => {
  test("no app imports another app, and nothing imports the published sdk", () => {
    const violations: string[] = [];
    for (const workspace of workspaces) {
      for (const file of listSourceFiles(`${workspace.directory}/src`)) {
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
          if (/^@eveland\/[^/]+\/src\//.test(specifier)) {
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

  test("every @eveland import is a declared dependency, and declared package edges follow the matrix", () => {
    const violations: string[] = [];
    for (const workspace of workspaces) {
      const declared = declaredWorkspaceDependencies(workspace.manifest);
      for (const file of listSourceFiles(`${workspace.directory}/src`)) {
        for (const specifier of importSpecifiers(readSource(file))) {
          if (!specifier.startsWith("@eveland/")) continue;
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
          if (dependency.startsWith("@eveland/") && !allowed.includes(dependency)) {
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
    const core = workspaces.find((workspace) => workspace.name === "@eveland/core");
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
    const db = workspaces.find((workspace) => workspace.name === "@eveland/db");
    expect(db).toBeDefined();
    expect(db!.manifest.exports).toMatchObject({
      ".": "./src/store.ts",
      "./factory": "./src/store-factory.ts",
      "./schema": "./src/schema.ts",
    });
  });
});
