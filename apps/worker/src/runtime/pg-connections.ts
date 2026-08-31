import type { PgInstanceConnectionSample } from "@evelandhq/core/instance-health";
import { POSTGRES_DEFAULT_PORT } from "@evelandhq/core/ports";
import postgres from "postgres";
import { resolveBootstrapPostgresUrl } from "./workflow-world-bootstrap.js";

/**
 * pg_stat_activity and max_connections are instance-wide, so what matters is
 * the set of distinct Postgres instances behind DATABASE_URL and
 * WORKFLOW_POSTGRES_URL: one "shared" budget when both point at the same
 * instance (the documented single-box default), a "control"/"workflow" pair
 * when the operator has split them. The workflow URL is resolved through the
 * bootstrap address first because the deployment-facing address (e.g.
 * host.docker.internal) may not be reachable from the worker process.
 */
export type PgConnectionSamplerDeps = {
  queryInstance: (url: string) => Promise<{ usedConnections: number; maxConnections: number }>;
  onInstanceError?: (role: PgInstanceConnectionSample["role"], error: unknown) => void;
};

const defaultDeps: PgConnectionSamplerDeps = {
  queryInstance: queryInstanceConnections,
};

export async function samplePgInstanceConnections(
  env: NodeJS.ProcessEnv,
  deps: PgConnectionSamplerDeps = defaultDeps,
): Promise<PgInstanceConnectionSample[] | null> {
  const controlUrl = env.DATABASE_URL;
  const workflowUrl = env.WORKFLOW_POSTGRES_URL
    ? resolveBootstrapPostgresUrl(env, env.WORKFLOW_POSTGRES_URL)
    : undefined;
  const agentPoolSize = resolveAgentPoolSize(env.WORKFLOW_POSTGRES_MAX_POOL_SIZE);

  const targets: Array<{
    role: PgInstanceConnectionSample["role"];
    url: string;
    agentPoolSize: number | null;
  }> = [];
  if (controlUrl && workflowUrl && isSameInstance(controlUrl, workflowUrl)) {
    targets.push({ role: "shared", url: controlUrl, agentPoolSize });
  } else {
    if (controlUrl) targets.push({ role: "control", url: controlUrl, agentPoolSize: null });
    if (workflowUrl) targets.push({ role: "workflow", url: workflowUrl, agentPoolSize });
  }
  if (targets.length === 0) return null;

  const samples = await Promise.all(
    targets.map(async (target): Promise<PgInstanceConnectionSample | null> => {
      try {
        const usage = await deps.queryInstance(target.url);
        return { role: target.role, agentPoolSize: target.agentPoolSize, ...usage };
      } catch (error) {
        deps.onInstanceError?.(target.role, error);
        return null;
      }
    }),
  );
  const present = samples.filter((sample): sample is PgInstanceConnectionSample => sample !== null);
  return present.length > 0 ? present : null;
}

/**
 * Mirrors the default the worker injects into deployments as
 * WORKFLOW_POSTGRES_MAX_POOL_SIZE — without an explicit bound,
 * @workflow/world-postgres falls back to pg's implicit pool max of 10.
 */
function resolveAgentPoolSize(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function isSameInstance(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const port = (url: URL) => url.port || String(POSTGRES_DEFAULT_PORT);
    return a.hostname.toLowerCase() === b.hostname.toLowerCase() && port(a) === port(b);
  } catch {
    return false;
  }
}

async function queryInstanceConnections(
  url: string,
): Promise<{ usedConnections: number; maxConnections: number }> {
  const sql = postgres(url, { max: 1, connect_timeout: 5 });
  try {
    const [row] = await sql`
      select
        (select count(*)::int from pg_stat_activity where backend_type = 'client backend') as used,
        current_setting('max_connections')::int as max
    `;
    if (!row) throw new Error("Connection statistics query returned no row.");
    return { usedConnections: Number(row.used), maxConnections: Number(row.max) };
  } finally {
    await sql.end();
  }
}
