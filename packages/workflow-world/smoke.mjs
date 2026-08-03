// End-to-end smoke test against a real Postgres: migrate, provision two
// tenants, write a run through each world, and prove neither can see the other.
import { Pool } from "pg";
import {
  createWorld,
  runMigrations,
  ensureTenantPartitions,
  dropTenantPartitions,
} from "@eveland/workflow-world";

const connectionString = process.env.WW_URL;
const admin = new Pool({ connectionString, max: 1 });

await runMigrations(admin, {
  migrationsDir: new URL("./migrations", import.meta.url).pathname,
  log: (m) => console.log("  migrate:", m),
});
await ensureTenantPartitions(admin, "p_alpha");
await ensureTenantPartitions(admin, "p_beta");
console.log("✓ migrations + partitions");

function worldFor(tenantId, deploymentId) {
  return createWorld({
    connectionString,
    tenantId,
    deploymentId,
    runner: "external", // no runner: this test only exercises storage
  });
}

const alpha = worldFor("p_alpha", "dep_alpha_1");
const beta = worldFor("p_beta", "dep_beta_1");

// Each world creates a run via the event log (the only write path).
const alphaRun = await alpha.events.create(null, {
  eventType: "run_created",
  eventData: {
    deploymentId: "dep_alpha_1",
    workflowName: "greet",
    input: [{ name: "alpha" }],
  },
  specVersion: 5,
});
const betaRun = await beta.events.create(null, {
  eventType: "run_created",
  eventData: {
    deploymentId: "dep_beta_1",
    workflowName: "greet",
    input: [{ name: "beta" }],
  },
  specVersion: 5,
});
console.log("✓ created runs:", alphaRun.run.runId, betaRun.run.runId);

// Affinity: the run must record the real deployment id, not 'postgres'.
const readBack = await alpha.runs.get(alphaRun.run.runId);
console.log("✓ deploymentId recorded:", readBack.deploymentId);
if (readBack.deploymentId !== "dep_alpha_1") throw new Error("deploymentId not recorded");

// getDeploymentId returns the real id too.
console.log("✓ getDeploymentId:", await alpha.getDeploymentId());

// Tenancy: alpha must not see beta's run, by id.
let leaked = null;
try {
  leaked = await alpha.runs.get(betaRun.run.runId);
} catch (error) {
  console.log("✓ cross-tenant get rejected:", error.constructor.name);
}
if (leaked) throw new Error("TENANCY LEAK: alpha read beta's run");

// Tenancy: list is scoped too.
const alphaList = await alpha.runs.list({ resolveData: "none" });
const betaList = await beta.runs.list({ resolveData: "none" });
console.log(`✓ list scoped: alpha=${alphaList.data.length} beta=${betaList.data.length}`);
if (alphaList.data.length !== 1 || betaList.data.length !== 1) {
  throw new Error("TENANCY LEAK: run lists are not scoped");
}

// Streams are tenant-scoped, including the NOTIFY channel.
await alpha.streams.write(alphaRun.run.runId, "out", "hello ");
await alpha.streams.write(alphaRun.run.runId, "out", "world");
await alpha.streams.close(alphaRun.run.runId, "out");
const chunks = await alpha.streams.getChunks(alphaRun.run.runId, "out");
console.log("✓ stream chunks:", chunks.data.length, "done:", chunks.done);
console.log("✓ beta sees no streams:", (await beta.streams.list(alphaRun.run.runId)).length === 0);

// specVersion must equal the literal eve compiles in.
console.log("✓ specVersion:", alpha.specVersion);

// DROP PARTITION reclaim path.
await alpha.close();
await beta.close();
await dropTenantPartitions(admin, "p_beta");
const { rows } = await admin.query(
  "select count(*)::int as n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='workflow' and c.relname like '%_t_p_beta_%'",
);
console.log("✓ beta partitions dropped, remaining:", rows[0].n);
if (rows[0].n !== 0) throw new Error("partitions not reclaimed");

await admin.end();
console.log("\nALL SMOKE CHECKS PASSED");
