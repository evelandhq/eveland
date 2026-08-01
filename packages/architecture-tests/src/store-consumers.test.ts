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
  // The four slices of the former app-project-routes monolith plus its
  // composer: one prior entry became five, not new consumption. Their
  // narrow ports land with the Store-narrowing pass.
  "apps/api/src/app-project-deployment-routes.ts",
  "apps/api/src/app-project-lifecycle-routes.ts",
  "apps/api/src/app-project-metadata-routes.ts",
  "apps/api/src/app-project-routes.ts",
  "apps/api/src/app-project-source-routes.ts",
  "apps/api/src/app-query-routes.ts",
  "apps/api/src/app-secret-routes.ts",
  "apps/api/src/app-support.ts",
  "apps/api/src/app.ts",
  "apps/api/src/observability/egress.ts",
  "apps/api/src/observability/policy-service.ts",
  "apps/worker/src/jobs/collector-observability/reconciler.ts",
  "apps/worker/src/jobs/deployment-launch-context.ts",
  "apps/worker/src/jobs/job-registry.ts",
  "apps/worker/src/jobs/process-job.ts",
  "apps/worker/src/jobs/process-observability.ts",
  "apps/worker/src/jobs/process-runtime-job.ts",
  "apps/worker/src/jobs/process.ts",
  "apps/worker/src/jobs/runtime-jobs/archive-deployment.ts",
  "apps/worker/src/jobs/runtime-jobs/delete-project.ts",
  "apps/worker/src/jobs/runtime-jobs/deployment-status.ts",
  "apps/worker/src/jobs/runtime-jobs/ensure-deployment-running.ts",
  "apps/worker/src/jobs/runtime-jobs/restart-deployment.ts",
  "apps/worker/src/jobs/runtime-jobs/trigger-schedule.ts",
  "apps/worker/src/jobs/runtime-jobs/types.ts",
  "apps/worker/src/runtime/activation-manager.ts",
  "apps/worker/src/runtime/identity-config-reconciler.ts",
  "apps/worker/src/runtime/idle-reaper.ts",
  "apps/worker/src/runtime/orphan-reaper.ts",
  "apps/worker/src/runtime/release-reaper.ts",
  "apps/worker/src/runtime/runtime-log-store.ts",
  "apps/worker/src/scheduler/planner.ts",
];

const IMPORT_FROM_DB = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@eveland\/db["']/g;

function importsStoreToken(source: string): boolean {
  for (const match of source.matchAll(IMPORT_FROM_DB)) {
    const clause = match[2]!;
    for (const rawItem of clause.split(",")) {
      const item = rawItem.trim().replace(/^type\s+/, "");
      if (item === "Store" || item.startsWith("Store ")) return true;
    }
  }
  return false;
}

// Importing Store only to narrow it (Pick<Store, ...> / Omit<Store, ...>) is
// the pattern this ratchet exists to encourage -- those files do not count.
function consumesFullStore(source: string): boolean {
  if (!importsStoreToken(source)) return false;
  const withoutImports = source.replace(/import\s[^;]*?from\s*["'][^"']+["'];?/g, "");
  const withoutNarrowing = withoutImports.replace(/(?:Pick|Omit)<\s*Store\s*,/g, "<narrowed,");
  return /\bStore\b/.test(withoutNarrowing);
}

describe("full-Store consumers", () => {
  test("only allowlisted production modules take the full Store", () => {
    const consumers: string[] = [];
    for (const workspace of listWorkspaces()) {
      if (workspace.name === "@eveland/db") continue;
      for (const file of listSourceFiles(`${workspace.directory}/src`)) {
        if (consumesFullStore(readSource(file))) consumers.push(file);
      }
    }
    expect(consumers.sort()).toEqual([...FULL_STORE_ALLOWLIST].sort());
  });
});
