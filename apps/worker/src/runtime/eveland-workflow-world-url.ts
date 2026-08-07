/**
 * The shared workflow database has two audiences with different views of the
 * network, and they need different URLs.
 *
 * A deployment runs inside a container, so its injected `EVELAND_WORKFLOW_WORLD_URL`
 * has to name the database the way a container reaches it — on Docker Desktop
 * that is `host.docker.internal`, which does not resolve on the host at all.
 * The platform's own processes (the worker provisioning partitions, the
 * dispatcher claiming jobs) run on the host and need `localhost`.
 *
 * This mirrors the split the legacy world already makes between
 * `WORKFLOW_POSTGRES_URL` and `WORKFLOW_POSTGRES_BOOTSTRAP_URL`. On a
 * single-host systemd install both views coincide and only the one variable is
 * ever set.
 */
export function resolveWorkflowWorldPlatformUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL ?? env.EVELAND_WORKFLOW_WORLD_URL;
}

/** The URL injected into deployments — always the container-reachable one. */
export function resolveWorkflowWorldDeploymentUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.EVELAND_WORKFLOW_WORLD_URL;
}
