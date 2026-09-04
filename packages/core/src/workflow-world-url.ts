/**
 * The shared workflow database has two audiences with different views of the
 * network, and they need different URLs.
 *
 * A deployment runs inside a container, so its injected `EVELAND_WORKFLOW_WORLD_URL`
 * has to name the database the way a container reaches it — on Docker Desktop
 * that is `host.docker.internal`, which does not resolve on the host at all.
 * The platform's own processes (the worker provisioning partitions, the API
 * verifying the dispatcher's World identity, the dispatcher claiming jobs) run
 * on the host and need `localhost`.
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

/** The suffix that turns the platform database's name into the workflow world's. */
export const WORKFLOW_DATABASE_SUFFIX = "_workflow";

/**
 * The shared workflow database's DSN, derived from the platform database's:
 * same server, same credentials, its own database (`eveland` ->
 * `eveland_workflow`).
 *
 * It has to be its own database rather than another schema inside the
 * platform's. This DSN is injected into every deployment (process-support.ts
 * reserves `EVELAND_WORKFLOW_WORLD_URL`), so a deployment's own — user-authored
 * — code holds these credentials. Pointed at the platform database they open
 * the accounts, sessions and encrypted project-secret tables to every agent the
 * platform runs; pointed at a database holding nothing but the `workflow`
 * schema they open exactly what the deployment already owns.
 */
export function deriveWorkflowWorldUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("The database URL names no database.");
  url.pathname = `/${encodeURIComponent(`${database}${WORKFLOW_DATABASE_SUFFIX}`)}`;
  return url.toString();
}

/**
 * The database a DSN names, or null when it names none. Host spellings are
 * deliberately not part of the answer: `host.docker.internal` and `127.0.0.1`
 * are the same server seen from two networks, so callers comparing a
 * deployment's view against the platform's compare database names.
 */
export function databaseName(databaseUrl: string): string | null {
  try {
    const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
    return name || null;
  } catch {
    return null;
  }
}
