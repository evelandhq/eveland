import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";

/**
 * Startup preflight for the workflow topology: every new build bakes in the
 * shared `@evelandhq/workflow-world`, so a production worker without that
 * database is misconfigured and fails here instead of at the first deploy.
 */
export function assertWorkflowTopologyPreflight(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "production" && !resolveWorkflowWorldPlatformUrl(env)) {
    throw new Error(
      "WORKFLOW_WORLD_URL is required in production: every new build uses the shared workflow world.",
    );
  }
}
