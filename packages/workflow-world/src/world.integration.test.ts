import { EntityConflictError } from "@workflow/errors";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createWorld } from "./index.js";
import {
  dropTenantPartitions,
  ensureTenantPartitions,
  resolveMigrationsDir,
  runMigrations,
  tenantPartitionsExist,
} from "./migrate.js";
import { PARTITIONED_TABLES } from "./drizzle/schema.js";
import { dedupIndexName, derivePartitionName } from "./tenant.js";

/**
 * Tenancy is enforced by WHERE-clause discipline across ~50 query sites, which
 * no type can check. This suite is what actually holds that invariant: two
 * worlds on one database, asserting that neither can observe the other.
 *
 * Set `EVELAND_WORKFLOW_WORLD_TEST_URL` to a scratch database to run it.
 */
const testUrl = process.env.EVELAND_WORKFLOW_WORLD_TEST_URL;
// Unique per run so the suite is repeatable against a database it has already
// used — otherwise the second run sees the first run's rows and the scoping
// assertions fail for the wrong reason.
const suffix = `${String(process.pid)}${Date.now().toString(36)}`;
const ALPHA = `p_alpha_${suffix}`;
const BETA = `p_beta_${suffix}`;

describe.skipIf(!testUrl)("multi-tenant world", () => {
  let admin: Pool;
  let alpha: ReturnType<typeof createWorld>;
  let beta: ReturnType<typeof createWorld>;
  let alphaRunId: string;
  let betaRunId: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: testUrl, max: 2 });
    await runMigrations(admin, { migrationsDir: resolveMigrationsDir() });
    await ensureTenantPartitions(admin, ALPHA);
    await ensureTenantPartitions(admin, BETA);

    alpha = createWorld({
      connectionString: testUrl!,
      tenantId: ALPHA,
      deploymentId: "dep_alpha_1",
      runner: "external",
    });
    beta = createWorld({
      connectionString: testUrl!,
      tenantId: BETA,
      deploymentId: "dep_beta_1",
      runner: "external",
    });

    alphaRunId = (
      await alpha.events.create(null, {
        eventType: "run_created",
        eventData: { deploymentId: "dep_alpha_1", workflowName: "greet", input: [{ n: 1 }] },
        specVersion: 5,
      })
    ).run!.runId;
    betaRunId = (
      await beta.events.create(null, {
        eventType: "run_created",
        eventData: { deploymentId: "dep_beta_1", workflowName: "greet", input: [{ n: 2 }] },
        specVersion: 5,
      })
    ).run!.runId;
  }, 60_000);

  afterAll(async () => {
    await alpha?.close?.();
    await beta?.close?.();
    await dropTenantPartitions(admin, ALPHA).catch(() => {});
    await dropTenantPartitions(admin, BETA).catch(() => {});
    await admin?.end().catch(() => {});
  });

  test("records the real deployment id, not a placeholder", async () => {
    // world-postgres hardcodes `getDeploymentId() -> 'postgres'`, which is why
    // a run could not be pinned to an executor that can replay it.
    expect(await alpha.getDeploymentId()).toBe("dep_alpha_1");
    const run = await alpha.runs.get(alphaRunId);
    expect(run.deploymentId).toBe("dep_alpha_1");
  });

  test("resolveLatestDeploymentId follows the promoted deployment", async () => {
    expect(await alpha.resolveLatestDeploymentId?.()).toBe("dep_alpha_1");
  });

  test("a tenant cannot read another tenant's run by id", async () => {
    await expect(alpha.runs.get(betaRunId)).rejects.toThrow();
    await expect(beta.runs.get(alphaRunId)).rejects.toThrow();
  });

  test("listing is scoped to the tenant", async () => {
    const alphaRuns = await alpha.runs.list({ resolveData: "none" });
    const betaRuns = await beta.runs.list({ resolveData: "none" });
    expect(alphaRuns.data.map((run) => run.runId)).toEqual([alphaRunId]);
    expect(betaRuns.data.map((run) => run.runId)).toEqual([betaRunId]);
  });

  test("events are scoped to the tenant", async () => {
    const alphaEvents = await alpha.events.list({ runId: alphaRunId });
    expect(alphaEvents.data.length).toBeGreaterThan(0);
    // Asking for the other tenant's run must yield nothing rather than its log.
    const leaked = await alpha.events.list({ runId: betaRunId });
    expect(leaked.data).toEqual([]);
  });

  test("streams are scoped, and readable back in order", async () => {
    await alpha.streams.write(alphaRunId, "out", "hello ");
    await alpha.streams.write(alphaRunId, "out", "world");
    await alpha.streams.close(alphaRunId, "out");

    const chunks = await alpha.streams.getChunks(alphaRunId, "out");
    expect(Buffer.concat(chunks.data.map((c) => Buffer.from(c.data))).toString()).toBe(
      "hello world",
    );
    expect(chunks.done).toBe(true);

    expect(await beta.streams.list(alphaRunId)).toEqual([]);
  });

  test("specVersion matches what the eve runtime enforces", () => {
    expect(alpha.specVersion).toBe(5);
  });

  test("the replay-budget exit flag stays off", () => {
    // `true` would make eve call process.exit(1) on a stuck run, killing the
    // agent process that also serves this project's chat and scheduler traffic.
    expect(alpha.processExitTriggersQueueRedelivery).toBe(false);
  });

  test("writing for an unprovisioned tenant fails loudly", async () => {
    // There is deliberately no DEFAULT partition: an unprovisioned tenant must
    // error rather than have its rows land somewhere unreclaimable.
    const orphan = createWorld({
      connectionString: testUrl!,
      tenantId: `p_unprovisioned_${suffix}`,
      deploymentId: "dep_x",
      runner: "external",
    });
    try {
      await expect(
        orphan.events.create(null, {
          eventType: "run_created",
          eventData: { deploymentId: "dep_x", workflowName: "greet", input: [] },
          specVersion: 5,
        }),
      ).rejects.toThrow();
    } finally {
      await orphan.close?.();
    }
  });

  test("dropping a tenant's partitions reclaims them", async () => {
    const scratch = `p_scratch_${suffix}`;
    await ensureTenantPartitions(admin, scratch);
    expect(await tenantPartitionsExist(admin, scratch)).toBe(true);

    await dropTenantPartitions(admin, scratch);
    expect(await tenantPartitionsExist(admin, scratch)).toBe(false);

    for (const table of PARTITIONED_TABLES) {
      const { rowCount } = await admin.query(
        "select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'workflow' and c.relname = $1",
        [derivePartitionName(table, scratch)],
      );
      expect(rowCount).toBe(0);
    }
  });

  test("provisioning is idempotent", async () => {
    await expect(ensureTenantPartitions(admin, ALPHA)).resolves.toBeUndefined();
  });

  test("a duplicate correlated event surfaces as EntityConflictError", async () => {
    // The dedup contract the runtime depends on. Postgres reports the *child*
    // partition's index name here, not the parent's, so this is what proves the
    // translation still recognises it — a raw driver error instead would make
    // two concurrent replays with the same correlationId both take effect.
    const correlationId = `step_${suffix}`;
    const create = () =>
      alpha.events.create(alphaRunId, {
        eventType: "step_created",
        correlationId,
        eventData: { stepName: "greet", input: [] },
        specVersion: 5,
      } as Parameters<typeof alpha.events.create>[1]);

    await create();
    await expect(create()).rejects.toThrow(EntityConflictError);
  });

  test("the dedup index is renamed to the predictable name", async () => {
    const { rows } = await admin.query<{ relname: string }>(
      `select ci.relname
         from pg_index i
         join pg_class ci on ci.oid = i.indexrelid
         join pg_class ct on ct.oid = i.indrelid
         join pg_namespace n on n.oid = ct.relnamespace
        where n.nspname = 'workflow' and ct.relname = $1
          and i.indisunique and i.indpred is not null`,
      [derivePartitionName("workflow_events", ALPHA)],
    );
    expect(rows[0]?.relname).toBe(dedupIndexName(ALPHA));
  });
});
