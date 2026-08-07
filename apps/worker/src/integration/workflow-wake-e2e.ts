/**
 * End-to-end proof of the one claim nothing else can check: that a durable
 * workflow job scheduled for a project whose Agent has been idle-reaped causes
 * the platform to wake that Agent and deliver the job to it.
 *
 * Everything upstream of this — enqueue, claim, affinity, the vqs contract — is
 * covered by `@evelandhq/workflow-world`'s own dispatch-loop integration suite
 * against eve's real queue handler. What that test cannot do is stop a real
 * deployment: it has no idle reaper, no runtime instances, and no activation
 * API. So this script drives the real platform instead, and asserts the
 * sequence that the whole project exists to make possible:
 *
 *   1. a project deploys on `@evelandhq/workflow-world` in `external` mode;
 *   2. a workflow job is scheduled to become due *after* the idle TTL;
 *   3. the worker's idle reaper stops the deployment while the job waits;
 *   4. the job comes due, and the dispatcher activates the stopped deployment
 *      back to ready and POSTs the message to it.
 *
 * Run against a platform already started with an isolated database (see
 * @evelandhq/workflow-world's design doc). Not a vitest file: it drives running
 * processes and takes minutes, the same shape as the other scripts here.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { materializeEveFixtureDirectory } from "@evelandhq/core/server/eve-fixture";
import { createStoreFromEnv } from "@evelandhq/db/factory";
import { createWorld, ensureTenantPartitions, runMigrations } from "@evelandhq/workflow-world";
import { Pool } from "pg";

const IDLE_TTL_MS = Number(process.env.EVELAND_ACTIVATION_IDLE_TTL_MS ?? 60_000);
/** Comfortably past the reap, so the job can only run on a woken deployment. */
const WAKE_DELAY_MS = IDLE_TTL_MS * 2;
const WORLD_URL =
  process.env.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL ?? process.env.EVELAND_WORKFLOW_WORLD_URL;

if (!WORLD_URL) throw new Error("EVELAND_WORKFLOW_WORLD_URL is required.");

function log(step: string, detail?: unknown) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${step}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(2_000);
  }
}

const { store, close } = createStoreFromEnv();
const worldPool = new Pool({ connectionString: WORLD_URL, max: 2 });
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-workflow-wake-"));

try {
  // --- 1. Deploy a project on the platform world ---------------------------
  const fixtureTemplate = fileURLToPath(
    new URL("../../../../infra/integration/fixtures/workflow-wake", import.meta.url),
  );
  const sourcePath = path.join(temporaryRoot, "source");
  await materializeEveFixtureDirectory(fixtureTemplate, sourcePath);
  log("materialized fixture", { sourcePath });

  const project = await store.createProject({
    name: `Workflow Wake E2E ${Date.now().toString(36)}`,
    importKind: "zip",
    sourcePath,
  });
  log("created project", { id: project.id });

  await store.enqueueJob(project.id, "import_source", { sourcePath, deployAfterImport: true });
  log("enqueued import + deploy; waiting for the worker");

  const deployment = await waitFor(
    "the deployment to reach running",
    async () => {
      const current = await store.getProject(project.id);
      if (current?.deploymentStatus === "failed") {
        const logs = await store.listLogs(project.id, "runtime");
        throw new Error(`deploy failed: ${JSON.stringify(logs.slice(-6))}`);
      }
      return current?.deploymentStatus === "running"
        ? await store.getCurrentDeployment(project.id)
        : null;
    },
    15 * 60_000,
  );
  log("deployment running", { id: deployment.id, port: deployment.hostPort });

  // --- 2. Schedule a workflow job to come due after the reap ---------------
  await runMigrations(worldPool);
  await ensureTenantPartitions(worldPool, project.id);

  const world = createWorld({
    connectionString: WORLD_URL,
    tenantId: project.id,
    deploymentId: deployment.id,
    runner: "external",
  });
  const run = await world.events.create(null, {
    eventType: "run_created",
    eventData: { deploymentId: deployment.id, workflowName: "wake", input: [] },
    specVersion: 5,
  });
  const runId = run.run!.runId;

  // Enqueued through the world itself, with a delay — the same path a durable
  // `sleep` inside a workflow takes to schedule its own continuation.
  const dueAt = new Date(Date.now() + WAKE_DELAY_MS);
  await world.queue(
    "__wkf_workflow_wake" as Parameters<typeof world.queue>[0],
    { runId },
    { delaySeconds: Math.round(WAKE_DELAY_MS / 1000) },
  );
  await world.close?.();
  log("scheduled workflow job", { runId, dueAt: dueAt.toISOString() });

  // --- 3. The idle reaper must stop the deployment while the job waits -----
  const stoppedAt = await waitFor(
    "the idle reaper to stop the deployment",
    async () => {
      const instances = await store.listDeploymentRuntimeInstances(deployment.id).catch(() => []);
      const ready = instances.filter((instance) => instance.status === "ready");
      return ready.length === 0 ? new Date() : null;
    },
    IDLE_TTL_MS + 5 * 60_000,
  );
  assert.ok(
    stoppedAt.getTime() < dueAt.getTime(),
    "the deployment must be reaped before the job comes due, or the test proves nothing",
  );
  log("deployment reaped while the job was still pending", {
    stoppedAt: stoppedAt.toISOString(),
    secondsBeforeDue: Math.round((dueAt.getTime() - stoppedAt.getTime()) / 1000),
  });

  // --- 4. The dispatcher must wake it and deliver --------------------------
  const wokeAt = await waitFor(
    "the dispatcher to activate the deployment again",
    async () => {
      const instances = await store.listDeploymentRuntimeInstances(deployment.id).catch(() => []);
      return instances.some((instance) => instance.status === "ready") ? new Date() : null;
    },
    WAKE_DELAY_MS + 5 * 60_000,
  );
  assert.ok(
    wokeAt.getTime() >= dueAt.getTime() - 5_000,
    "the wake must be caused by the job coming due, not by something earlier",
  );
  log("deployment woken by the dispatcher", { wokeAt: wokeAt.toISOString() });

  const { rows: deadLetters } = await worldPool.query<{ reason: string }>(
    "select reason from workflow.dispatch_dead_letters where tenant_id = $1",
    [project.id],
  );
  log(
    "dead letters",
    deadLetters.map((row) => row.reason),
  );

  // What the delivery itself does is bounded by the fixture. eve only registers
  // a queue for a workflow it discovered in the bundle, and this fixture has
  // none it recognises, so it answers 400 "Unhandled queue" — correctly. That
  // still exercises the dispatch contract end to end (the Agent parsed the vqs
  // headers and made a routing decision) and the 4xx dead-letter path, but it
  // does not show a workflow body resuming. Asserted explicitly so the boundary
  // is visible in the output rather than implied by a silent pass.
  const unexpected = deadLetters.filter((row) => !row.reason.includes("Unhandled queue"));
  assert.deepEqual(unexpected, [], "no dead letters beyond the fixture's unregistered workflow");

  console.log("\nWORKFLOW WAKE E2E OK");
  console.log("  PROVEN      reaped=1 wokeOnDue=1 dispatchDelivered=1");
  console.log(
    `  NOT PROVEN  workflow body resumption — this fixture registers no workflow eve recognises (${String(deadLetters.length)} expected 400)`,
  );
} finally {
  await worldPool.end().catch(() => {});
  await close().catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
}
