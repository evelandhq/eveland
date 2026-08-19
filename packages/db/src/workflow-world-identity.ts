import { clusterWorldIdentity, WORLD_IDENTITY_SQL } from "@evelandhq/core/workflow-dispatch";
import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";
import postgres from "postgres";

/**
 * The shared World's canonical identity — the Postgres cluster fingerprint
 * plus database name — read from the database itself. URL comparison fails
 * open across unrelated servers; this cannot. Cached per URL because the
 * fingerprint is immutable for the life of the cluster, and "unknown" (which
 * never satisfies the readiness gate) is deliberately not cached so a
 * transient outage does not poison later deploys or activations.
 */
const identityCache = new Map<string, string>();

export async function resolveWorldClusterIdentity(env: NodeJS.ProcessEnv): Promise<string> {
  const worldUrl = resolveWorkflowWorldPlatformUrl(env);
  if (!worldUrl) return "unknown";
  const cached = identityCache.get(worldUrl);
  if (cached) return cached;
  const sql = postgres(worldUrl, { max: 1 });
  try {
    const rows = await sql.unsafe(WORLD_IDENTITY_SQL);
    const row = rows[0] as { system_identifier?: unknown; database?: unknown } | undefined;
    if (typeof row?.system_identifier !== "string" || typeof row?.database !== "string") {
      return "unknown";
    }
    const identity = clusterWorldIdentity(row.system_identifier, row.database);
    identityCache.set(worldUrl, identity);
    return identity;
  } catch {
    return "unknown";
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
