import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";
import { resolveWorkflowRunnerMode } from "./workflow-world.js";

/**
 * External-only startup preflight for the workflow topology.
 *
 * Every new build bakes in the shared `@evelandhq/workflow-world`, so a
 * production worker without that database is misconfigured no matter what the
 * legacy `WORKFLOW_POSTGRES_URL` says — the legacy URL only serves Deployments
 * still inside the legacy termination flow and never satisfies this check.
 * Runner-mode validation runs in every environment: an explicit `embedded`
 * request fails here at startup instead of at the first deploy.
 */
export function assertWorkflowTopologyPreflight(env: NodeJS.ProcessEnv): void {
  resolveWorkflowRunnerMode(env);
  if (env.NODE_ENV === "production" && !resolveWorkflowWorldPlatformUrl(env)) {
    throw new Error(
      "EVELAND_WORKFLOW_WORLD_URL is required in production: every new build uses the shared workflow world. WORKFLOW_POSTGRES_URL only serves legacy Deployments being terminated and does not satisfy this requirement.",
    );
  }
}
