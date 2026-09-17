/**
 * End-to-end proof of the one claim nothing else can check: that a durable
 * namespaced workflow survives both an idle-reaped Agent and external
 * dispatcher boot recovery, then resumes its body without a dead letter.
 *
 * The package's own suite proves this recovery path against a real Eve handler,
 * but it cannot stop a real Deployment. This script drives the full platform
 * and asserts the sequence that crosses both repositories:
 *
 *   1. a project deploys on `@evelandhq/workflow-world` in `external` mode;
 *   2. the fixture starts Eve's real turn workflow, whose durable sleep tool
 *      parks it past the idle TTL;
 *   3. the worker's idle reaper stops the deployment while the job waits;
 *   4. the original delayed Graphile job is removed, simulating a dispatcher
 *      dying after the run was persisted;
 *   5. a newly started dispatcher service reconstructs the job from durable
 *      run state, wakes the Deployment, and the workflow completes a real step.
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
import { runMigrations } from "@evelandhq/workflow-world";
import { Pool } from "pg";
import { spawnDispatcherApp, waitForDispatcherRegistration } from "./dispatcher-process.js";

/**
 * The Eve-owned run that executes a turn's steps, per line: `turnWorkflow` is
 * the child run every 0.55/0.56 turn dispatches, `workflowEntry` is the
 * session's own run, which from 0.57 executes the turns itself.
 */
const EVE_TURN_EXECUTOR_RUN_NAMES = ["workflow//eve//turnWorkflow", "workflow//eve//workflowEntry"];

/**
 * Where the durable sleep's timer job may live: on the turn executor's own
 * queue (0.55 parks the turn run itself), or -- from 0.57, where the sleep tool
 * is a workflow tool run of its own -- on the child `workflowToolRunWorkflow`
 * run's queue. The session run is then idle, waiting on the child's hook.
 */
const EVE_SLEEP_TIMER_RUN_NAMES = [
  ...EVE_TURN_EXECUTOR_RUN_NAMES,
  "workflow//eve//workflowToolRunWorkflow",
];

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
// Exact activation is bound to the registered dispatcher instance, so the
// harness runs the REAL dispatcher app and owns its lifecycle; the platform
// under test must not run its own.
let dispatcher: ReturnType<typeof spawnDispatcherApp> | undefined;
const dispatcherEnv: NodeJS.ProcessEnv = {
  EVELAND_WORKFLOW_DISPATCHER_HEARTBEAT_INTERVAL_MS: "2000",
};

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

  // --- 2. Start the real workflow; it sleeps past the idle reap -------------
  await runMigrations(worldPool);
  dispatcher = spawnDispatcherApp(dispatcherEnv, log);
  const firstRegistration = await waitForDispatcherRegistration(store);
  log("dispatcher registered", firstRegistration);
  const workflowToken = `wake-${Date.now().toString(36)}`;
  const startResponse = await fetch(`http://127.0.0.1:${String(deployment.hostPort)}/start-wake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      seconds: Math.ceil(WAKE_DELAY_MS / 1_000),
      token: workflowToken,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const startBody = await startResponse.text();
  assert.ok(
    startResponse.ok,
    `workflow start returned HTTP ${String(startResponse.status)}: ${startBody}`,
  );
  const startResult = JSON.parse(startBody) as { sessionId?: unknown };
  assert.equal(typeof startResult.sessionId, "string", "workflow start must return a session id");

  // The run that executes the turn's durable sleep depends on the Eve line:
  // through 0.56 every turn is a child `turnWorkflow` run started after the
  // session's own `workflowEntry` run, so "newest first" picks the turn run;
  // from 0.57 the turn runs as steps inside the session run itself and no
  // per-turn run exists. Either way the newest of the two is the executor.
  const run = await waitFor(
    "the fixture's real Eve turn-executing workflow run to be persisted",
    async () => {
      const { rows } = await worldPool.query<{
        id: string;
        name: string;
        queue_namespace: string | null;
        status: string;
      }>(
        `select id, name, queue_namespace, status
           from workflow.workflow_runs
          where tenant_id = $1
            and deployment_id = $2
            and name = any($3)
          order by created_at desc
          limit 1`,
        [project.id, deployment.id, EVE_TURN_EXECUTOR_RUN_NAMES],
      );
      return rows[0] ?? null;
    },
    60_000,
  );
  assert.ok(run.queue_namespace, "Eve must persist a non-empty queue namespace on the run");

  // Only a job that is genuinely parked counts as the sleep timer. The
  // executor's queue also carries immediate continuations -- from 0.57 the
  // session run enqueues one the moment it is created, before its first step
  // has run -- and "newest by run_at" would return that one first and prove
  // nothing. The sleep is the only job due more than half the idle TTL out.
  const delayedJob = await waitFor(
    "the durable sleep to enqueue the turn's delayed continuation",
    async () => {
      const { rows } = await worldPool.query<{ id: string; run_at: Date; workflow: string }>(
        `select id::text, run_at, payload ->> 'id' as workflow
           from graphile_worker._private_jobs
          where payload ->> 'tenantId' = $1
            and payload ->> 'deploymentId' = $2
            and payload ->> 'id' = any($3)
            and run_at > now() + ($4::int * interval '1 millisecond')
          order by run_at desc
          limit 1`,
        [project.id, deployment.id, EVE_SLEEP_TIMER_RUN_NAMES, IDLE_TTL_MS / 2],
      );
      return rows[0] ?? null;
    },
    60_000,
  );
  const dueAt = new Date(delayedJob.run_at);
  assert.ok(
    dueAt.getTime() > Date.now() + IDLE_TTL_MS / 2,
    "the workflow continuation must remain delayed long enough for the idle reap",
  );
  log("started namespaced Eve turn sleep", {
    runId: run.id,
    timerWorkflow: delayedJob.workflow,
    sessionId: startResult.sessionId,
    queueNamespace: run.queue_namespace,
    dueAt: dueAt.toISOString(),
  });

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

  // --- 4. Remove the original job and boot a recovery dispatcher -----------
  const deleted = await worldPool.query(
    `delete from graphile_worker._private_jobs
      where payload ->> 'tenantId' = $1
        and id = $2::bigint`,
    [project.id, delayedJob.id],
  );
  assert.ok(
    (deleted.rowCount ?? 0) > 0,
    "the test must remove the original delayed job or boot recovery proves nothing",
  );
  log("removed original delayed job", { jobs: deleted.rowCount });

  await dispatcher.stop();
  log("dispatcher stopped; respawning for ownership handoff + boot recovery");
  dispatcher = spawnDispatcherApp(dispatcherEnv, log);
  const recoveryRegistration = await waitForDispatcherRegistration(store, {
    notInstanceId: firstRegistration.instanceId,
  });
  assert.ok(
    recoveryRegistration.reenqueuedRuns >= 1,
    "the second dispatcher must reconstruct at least this active run during boot recovery",
  );
  log("recovery dispatcher registered", recoveryRegistration);

  // --- 5. The recovered namespaced message must wake and complete ----------
  const wokeAt = await waitFor(
    "the recovery dispatcher to activate the deployment again",
    async () => {
      const instances = await store.listDeploymentRuntimeInstances(deployment.id).catch(() => []);
      return instances.some((instance) => instance.status === "ready") ? new Date() : null;
    },
    5 * 60_000,
  );
  log("deployment woken by the dispatcher", { wokeAt: wokeAt.toISOString() });

  // A per-turn run (through 0.56) completes with the turn; the session run
  // that executes turns from 0.57 stays `running` between turns, so the proof
  // that the body resumed is the second completed `//turnStep` on the run --
  // the same step name on both lines -- not the run's own status.
  const completedTurnSteps = async () => {
    const { rows } = await worldPool.query<{ step_name: string }>(
      `select step_name
         from workflow.workflow_steps
        where tenant_id = $1 and run_id = $2 and status = 'completed'`,
      [project.id, run.id],
    );
    return rows.filter((step) => step.step_name.endsWith("//turnStep")).length;
  };
  const settledRun = await waitFor(
    "the recovered workflow body to finish",
    async () => {
      const { rows } = await worldPool.query<{ status: string }>(
        `select status
           from workflow.workflow_runs
          where tenant_id = $1 and id = $2`,
        [project.id, run.id],
      );
      const current = rows[0];
      if (current?.status === "failed" || current?.status === "cancelled") {
        throw new Error(`recovered workflow became terminal with status ${current.status}`);
      }
      if (current?.status === "completed") return current;
      return current?.status === "running" && (await completedTurnSteps()) >= 2 ? current : null;
    },
    WAKE_DELAY_MS + 5 * 60_000,
  );
  assert.ok(
    settledRun.status === "completed" || settledRun.status === "running",
    `the recovered run must be settled or idle, not ${settledRun.status}`,
  );
  assert.ok(
    (await completedTurnSteps()) >= 2,
    "the Eve turn body must complete a second turnStep after its durable sleep",
  );

  const { rows: deadLetters } = await worldPool.query<{ reason: string }>(
    "select reason from workflow.dispatch_dead_letters where tenant_id = $1",
    [project.id],
  );
  log(
    "dead letters",
    deadLetters.map((row) => row.reason),
  );

  assert.deepEqual(deadLetters, [], "namespaced boot recovery must create no dead letters");

  console.log("\nWORKFLOW WAKE E2E OK");
  console.log("  PROVEN reaped=1 bootRecovery=1 namespacePersisted=1 bodyResumed=1 deadLetters=0");
} finally {
  await dispatcher?.stop().catch(() => {});
  await worldPool.end().catch(() => {});
  await close().catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
}
