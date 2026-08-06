import { describe, expect, test } from "vitest";
import { listSourceFiles, listWorkspaces, readSource } from "./scan-support.js";

// Ratchet, not aspiration: production modules that consume the full 173-member
// Store instead of a narrow domain port. The assertion is set EQUALITY --
// adding a file fails, and narrowing a listed file forces its removal, so the
// list can only shrink. New code takes the narrowest domain interface (or
// Pick<>) that covers what it actually calls; the providers in packages/db
// already implement per-domain interfaces.
const FULL_STORE_ALLOWLIST: string[] = [
  "apps/api/src/app-agent-catalog-routes.ts",
  "apps/api/src/app-identity-routes.ts",
  "apps/api/src/app-internal-routes.ts",
  "apps/api/src/app-observability-proxy-routes.ts",
  "apps/api/src/app-observability-routes.ts",
  "apps/api/src/app-otel-routes.ts",
  "apps/api/src/app-query-routes.ts",
  "apps/api/src/app-secret-routes.ts",
  "apps/api/src/app-support.ts",
  "apps/api/src/app.ts",
  "apps/api/src/observability/egress.ts",
  "apps/api/src/observability/policy-service.ts",
  "apps/worker/src/jobs/collector-observability/reconciler.ts",
  "apps/worker/src/jobs/deployment-launch-context.ts",
  "apps/worker/src/jobs/job-registry.ts",
  "apps/worker/src/jobs/process-observability.ts",
  "apps/worker/src/jobs/process.ts",
  "apps/worker/src/runtime/identity-config-reconciler.ts",
  "apps/worker/src/runtime/idle-reaper.ts",
  "apps/worker/src/runtime/orphan-reaper.ts",
  "apps/worker/src/runtime/release-reaper.ts",
  "apps/worker/src/runtime/runtime-log-store.ts",
  "apps/worker/src/scheduler/planner.ts",
];

const IMPORT_FROM_DB = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@evelandhq\/db["']/g;

/** Local names the full Store is bound to, including `Store as Alias`. */
function importedStoreNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(IMPORT_FROM_DB)) {
    const clause = match[2]!;
    for (const rawItem of clause.split(",")) {
      const item = rawItem.trim().replace(/^type\s+/, "");
      if (item === "Store") names.push("Store");
      else {
        const alias = item.match(/^Store\s+as\s+([A-Za-z0-9_$]+)$/)?.[1];
        if (alias) names.push(alias);
      }
    }
  }
  return names;
}

// Importing Store only to narrow it (Pick<Store, ...> / Omit<Store, ...>) is
// the pattern this ratchet exists to encourage -- those files do not count.
// Aliased imports (`Store as PlatformStore`) are tracked under the alias, so
// renaming the binding cannot dodge the ratchet.
function consumesFullStore(source: string): boolean {
  const names = importedStoreNames(source);
  if (names.length === 0) return false;
  const withoutImports = source.replace(/import\s[^;]*?from\s*["'][^"']+["'];?/g, "");
  const namePattern = names.join("|");
  const withoutNarrowing = withoutImports.replace(
    new RegExp(`(?:Pick|Omit)<\\s*(?:${namePattern})\\s*,`, "g"),
    "<narrowed,",
  );
  return new RegExp(`\\b(?:${namePattern})\\b`).test(withoutNarrowing);
}

describe("full-Store consumers", () => {
  test("only allowlisted production modules take the full Store", () => {
    const consumers: string[] = [];
    for (const workspace of listWorkspaces()) {
      if (workspace.name === "@evelandhq/db") continue;
      for (const file of listSourceFiles(`${workspace.directory}/src`)) {
        if (consumesFullStore(readSource(file))) consumers.push(file);
      }
    }
    expect(consumers.sort()).toEqual([...FULL_STORE_ALLOWLIST].sort());
  });
});
