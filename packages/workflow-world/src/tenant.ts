import { createHash } from "node:crypto";

/**
 * Every platform-owned row carries `tenant_id`, the Eveland project id.
 *
 * The name is deliberately not `project_id`: `workflow_hooks` already has an
 * upstream `project_id` column (it ships in world-postgres' base migration and
 * is currently written as the empty string), reserved for the Workflow
 * runtime's own notion of a project. Reusing that name would collide the
 * moment upstream starts populating it.
 */
export const TENANT_COLUMN = "tenant_id";

/**
 * Partition names are derived, never interpolated from raw ids: project ids use
 * a mixed-case alphabet, Postgres folds unquoted identifiers to lowercase, and
 * identifiers truncate at 63 bytes. The digest keeps case-variant and
 * long-prefix ids collision-free, mirroring `deriveProjectWorkflowDatabaseName`
 * in the worker's legacy bootstrap.
 */
export function derivePartitionName(table: string, tenantId: string): string {
  const safe = tenantId
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 24);
  const digest = createHash("sha256").update(tenantId).digest("hex").slice(0, 8);
  return `${table}_t_${safe}_${digest}`;
}

/**
 * A tenant id reaches SQL only as a bind parameter, but it also names
 * partitions and NOTIFY channels, so reject anything that could not round-trip
 * through those before it is stored.
 */
export function assertValidTenantId(tenantId: string): void {
  if (tenantId.length === 0 || tenantId.length > 128) {
    throw new Error(
      `Invalid tenant id: expected 1-128 characters, received ${String(tenantId.length)}.`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new Error("Invalid tenant id: only letters, digits, underscore and hyphen are allowed.");
  }
}

/**
 * The streamer's LISTEN/NOTIFY channel is per-tenant. world-postgres uses one
 * global `workflow_event_chunk` channel, which was harmless when every project
 * had its own database; on the shared database it would wake every agent in the
 * fleet on every chunk of every run.
 */
export function tenantStreamChannel(tenantId: string): string {
  // Channel names are identifiers too, so reuse the digest scheme rather than
  // embedding the raw id.
  return derivePartitionName("wf_stream", tenantId);
}

/**
 * Deterministic name for this tenant's correlated-event dedup index.
 *
 * Postgres names a partition's child indexes itself, from the partition name
 * plus the indexed columns, then truncates the result to 63 bytes. The truncated
 * form is not predictable from the parent index name and varies with how long
 * the tenant id is — for a short tenant it ends
 * `..._correlation_id_type_idx`, for a longer one `..._correlation__idx`. Since
 * a unique violation reports the *child* name, matching it is the only way to
 * recognise a dedup conflict, so the child is renamed to this at provisioning
 * time and matched exactly.
 */
export function dedupIndexName(tenantId: string): string {
  return derivePartitionName("wf_events_dedup", tenantId);
}
