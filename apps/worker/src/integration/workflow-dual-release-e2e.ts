/**
 * The two proofs only two REAL, semantically different Releases can give
 * (issue #278, plan phase 8):
 *
 * Part 1 — dual-Release wake/continuation affinity:
 *   1. Release A deploys and parks a durable Eve turn workflow (sleep past
 *      the idle TTL); the reaper stops A while the continuation waits.
 *   2. Release B — the SAME project, semantically different code (its model
 *      answers with a different marker) — deploys and is PROMOTED. B is now
 *      the tempting wrong answer for every naive "latest deployment" lookup.
 *   3. The real dispatcher app restarts (kill + respawn: ownership handoff +
 *      boot recovery, registration-bound activation).
 *   4. The recovered continuation must wake and complete on A — proven
 *      structurally (immutable run `deployment_id`, A woken) AND semantically
 *      (the reply carries A's marker, not B's).
 *
 * Part 2 — A/B online concurrent-delivery race:
 *   With BOTH Releases retained and B promoted, a fresh run starts on A, the
 *   dispatcher stops before the run's pending delivery comes due, that
 *   delivery is duplicated VERBATIM (same payload, queue, and due time), and
 *   a restarted dispatcher processes both concurrently. Every delivery must
 *   resolve to the one owner: both jobs sit on the run's exact `wfrun:`
 *   queue (per-run serialization — peak dispatch concurrency 1 by
 *   construction), the run completes on A with A's semantics, steps are not
 *   duplicated, and nothing dead-letters.
 *
 * Run against a platform (API + Worker) already started with an isolated
 * database; this script owns the dispatcher app's lifecycle, so the platform
 * must NOT run its own dispatcher. Not a vitest file: it drives running
 * processes and takes minutes.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { materializeEveFixtureDirectory } from "@evelandhq/core/server/eve-fixture";
import { createStoreFromEnv } from "@evelandhq/db/factory";
import { runMigrations, runQueueName } from "@evelandhq/workflow-world";
import { Pool } from "pg";
import { spawnDispatcherApp, waitForDispatcherRegistration } from "./dispatcher-process.js";

const IDLE_TTL_MS = Number(process.env.EVELAND_ACTIVATION_IDLE_TTL_MS ?? 60_000);
const WAKE_DELAY_MS = IDLE_TTL_MS * 2;
const WORLD_URL =
  process.env.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL ?? process.env.EVELAND_WORKFLOW_WORLD_URL;
const VARIANT_B_MARKER = "awake-variant-b";

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
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-workflow-dual-"));
let dispatcher: ReturnType<typeof spawnDispatcherApp> | undefined;

const dispatcherEnv: NodeJS.ProcessEnv = {
  EVELAND_WORKFLOW_DISPATCHER_HEARTBEAT_INTERVAL_MS: "2000",
};

async function startWake(
  hostPort: number,
  seconds: number,
  token: string,
): Promise<{ sessionId: string }> {
  const response = await fetch(`http://127.0.0.1:${String(hostPort)}/start-wake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seconds, token }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  assert.ok(response.ok, `workflow start returned HTTP ${String(response.status)}: ${body}`);
  const parsed = JSON.parse(body) as { sessionId?: unknown };
  assert.equal(typeof parsed.sessionId, "string", "workflow start must return a session id");
  return { sessionId: parsed.sessionId as string };
}

async function latestTurnRun(projectId: string, deploymentId: string) {
  const { rows } = await worldPool.query<{
    id: string;
    deployment_id: string;
    queue_namespace: string | null;
    status: string;
  }>(
    `select id, deployment_id, queue_namespace, status
       from workflow.workflow_runs
      where tenant_id = $1
        and deployment_id = $2
        and name = 'workflow//eve//turnWorkflow'
      order by created_at desc
      limit 1`,
    [projectId, deploymentId],
  );
  return rows[0] ?? null;
}

/**
 * Every proof about "which Release answered" reads the World's own records:
 * the turn run's immutable deployment_id, and the session's reply stream.
 * Stream chunks are binary-framed, so the marker probe is a byte search on
 * the SESSION run's chunks (the reply streams on the session, not the turn).
 */
async function assertRunSemantics(
  projectId: string,
  runId: string,
  deploymentId: string,
  sessionRunId: string,
) {
  const { rows } = await worldPool.query<{ status: string; deployment_id: string }>(
    `select status, deployment_id from workflow.workflow_runs
      where tenant_id = $1 and id = $2`,
    [projectId, runId],
  );
  const run = rows[0];
  assert.ok(run, `run ${runId} must exist`);
  assert.equal(run.status, "completed", `run ${runId} must complete`);
  assert.equal(
    run.deployment_id,
    deploymentId,
    "the run's immutable deployment_id must stay on its owner",
  );
  const { rows: chunks } = await worldPool.query<{ data: Buffer }>(
    `select data from workflow.workflow_stream_chunks where run_id = $1`,
    [sessionRunId],
  );
  const replies: string[] = [];
  for (const chunk of chunks) {
    // Frames embed base64-encoded JSON event payloads.
    for (const match of chunk.data.toString("latin1").matchAll(/"([A-Za-z0-9+/]{40,}={0,2})"/gu)) {
      try {
        const event = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as {
          type?: string;
          data?: { message?: unknown };
        };
        if (event.type === "message.completed" && typeof event.data?.message === "string") {
          replies.push(event.data.message);
        }
      } catch {
        // Not every base64-looking segment is an event frame.
      }
    }
  }
  assert.ok(
    replies.includes("awake"),
    `the reply must carry Release A's marker (saw: ${JSON.stringify(replies)})`,
  );
  assert.ok(
    !replies.includes(VARIANT_B_MARKER),
    "Release B must never have answered this run — its marker in the reply means the dispatch went to the wrong Release",
  );
}

async function assertNoPoison(projectId: string) {
  const { rows: deadLetters } = await worldPool.query<{ reason: string }>(
    "select reason from workflow.dispatch_dead_letters where tenant_id = $1 and resolved_at is null",
    [projectId],
  );
  assert.deepEqual(
    deadLetters.map((row) => row.reason),
    [],
    "no unresolved dead letters",
  );
  const { rows: poisoned } = await worldPool.query<{ id: string; error_code: string }>(
    `select id, error_code from workflow.workflow_runs
      where tenant_id = $1 and error_code is not null`,
    [projectId],
  );
  const fatal = poisoned.filter((row) =>
    /REPLAY_DIVERGENCE|CORRUPTED_EVENT_LOG|HookNotFoundError/iu.test(row.error_code),
  );
  assert.deepEqual(fatal, [], "no replay divergence / corrupted log / hook loss");
}

try {
  // --- Release A: deploy and park a durable run ------------------------------
  const fixtureTemplate = fileURLToPath(
    new URL("../../../../infra/integration/fixtures/workflow-wake", import.meta.url),
  );
  const sourceA = path.join(temporaryRoot, "source-a");
  await materializeEveFixtureDirectory(fixtureTemplate, sourceA);

  const project = await store.createProject({
    name: `Dual Release E2E ${Date.now().toString(36)}`,
    importKind: "zip",
    sourcePath: sourceA,
  });
  log("created project", { id: project.id });
  await store.enqueueJob(project.id, "import_source", {
    sourcePath: sourceA,
    deployAfterImport: true,
  });

  const deploymentA = await waitFor(
    "Release A to reach running",
    async () => {
      const current = await store.getProject(project.id);
      if (current?.deploymentStatus === "failed") {
        const logs = await store.listLogs(project.id, "runtime");
        throw new Error(`deploy A failed: ${JSON.stringify(logs.slice(-6))}`);
      }
      return current?.deploymentStatus === "running"
        ? await store.getCurrentDeployment(project.id)
        : null;
    },
    15 * 60_000,
  );
  log("Release A running", { id: deploymentA.id, port: deploymentA.hostPort });

  await runMigrations(worldPool);
  dispatcher = spawnDispatcherApp(dispatcherEnv, log);
  const firstRegistration = await waitForDispatcherRegistration(store);
  log("dispatcher registered", firstRegistration);

  const tokenA = `dual-a-${Date.now().toString(36)}`;
  const { sessionId } = await startWake(
    deploymentA.hostPort,
    Math.ceil(WAKE_DELAY_MS / 1_000),
    tokenA,
  );
  const parkedRun = await waitFor(
    "Release A's turn workflow to persist",
    () => latestTurnRun(project.id, deploymentA.id),
    60_000,
  );
  assert.ok(parkedRun.queue_namespace, "Eve must persist the run's queue namespace");
  log("Release A parked a durable run", { runId: parkedRun.id, sessionId });

  // --- Release B: semantically different build, deployed AND promoted --------
  const sourceB = path.join(temporaryRoot, "source-b");
  await materializeEveFixtureDirectory(fixtureTemplate, sourceB);
  const modelPath = path.join(sourceB, "agent/wake-model.ts");
  const modelSource = await readFile(modelPath, "utf8");
  assert.ok(modelSource.includes('textResult("awake")'), "fixture model must carry the A marker");
  await writeFile(
    modelPath,
    modelSource.replace('textResult("awake")', `textResult("${VARIANT_B_MARKER}")`),
  );
  await store.enqueueJob(project.id, "import_source", {
    sourcePath: sourceB,
    deployAfterImport: true,
    promoteAfterDeploy: true,
  });
  const deploymentB = await waitFor(
    "Release B to reach running and take the routes",
    async () => {
      const current = await store.getCurrentDeployment(project.id).catch(() => null);
      return current && current.id !== deploymentA.id && current.status === "running"
        ? current
        : null;
    },
    15 * 60_000,
  );
  assert.notEqual(deploymentB.releaseId, deploymentA.releaseId, "B must be a different Release");
  log("Release B running and promoted", { id: deploymentB.id, port: deploymentB.hostPort });

  // --- The reap, then a REAL dispatcher restart ------------------------------
  const stoppedAt = await waitFor(
    "the idle reaper to stop Release A",
    async () => {
      const instances = await store.listDeploymentRuntimeInstances(deploymentA.id).catch(() => []);
      return instances.every((instance) => instance.status !== "ready") ? new Date() : null;
    },
    IDLE_TTL_MS + 5 * 60_000,
  );
  log("Release A reaped while its continuation waits", { stoppedAt: stoppedAt.toISOString() });
  const retainedA = await store.getDeployment(deploymentA.id);
  assert.ok(
    retainedA && retainedA.status !== "archived",
    "the active workflow run must protect Release A from archive",
  );

  await dispatcher.stop();
  log("dispatcher stopped; respawning for ownership handoff + boot recovery");
  dispatcher = spawnDispatcherApp(dispatcherEnv, log);
  const secondRegistration = await waitForDispatcherRegistration(store, {
    notInstanceId: firstRegistration.instanceId,
  });
  log("restarted dispatcher registered", secondRegistration);

  // --- The continuation must come home to A ----------------------------------
  await waitFor(
    "the dispatcher to wake Release A again",
    async () => {
      const instances = await store.listDeploymentRuntimeInstances(deploymentA.id).catch(() => []);
      return instances.some((instance) => instance.status === "ready") ? new Date() : null;
    },
    WAKE_DELAY_MS + 5 * 60_000,
  );
  await waitFor(
    "the recovered run to complete",
    async () => {
      const run = await latestTurnRun(project.id, deploymentA.id);
      if (run?.status === "failed" || run?.status === "cancelled") {
        throw new Error(`recovered run became ${run.status}`);
      }
      return run?.status === "completed" ? run : null;
    },
    WAKE_DELAY_MS + 5 * 60_000,
  );
  await assertRunSemantics(project.id, parkedRun.id, deploymentA.id, sessionId);
  await assertNoPoison(project.id);

  // Session identity is MANDATORY: the platform Session projected from OTLP
  // must exist, carry the Eve session identity, and record the owning
  // Release as its provenance. A stack without the projection path fails
  // here instead of skipping — this harness must run with ingest enabled.
  const platformSession = await waitFor(
    "the platform Session to project from OTLP with a root node",
    async () => {
      const session = await store.getSessionByEveSessionId(project.id, sessionId);
      return session && session.rootNodeId ? session : null;
    },
    3 * 60_000,
  );
  assert.equal(platformSession.projectId, project.id);
  assert.equal(platformSession.eveSessionId, sessionId, "Eve session identity must agree");
  assert.equal(
    platformSession.deploymentId,
    deploymentA.id,
    "platform Session provenance must be the owning Release A, not the promoted decoy",
  );
  assert.notEqual(platformSession.status, "failed", "the projected Session must be healthy");
  log("platform session identity and provenance verified", {
    sessionId,
    id: platformSession.id,
    deploymentId: platformSession.deploymentId,
  });
  log("PART 1 OK: continuation came home to Release A across a dispatcher restart");

  // --- Part 2: A/B online, duplicated concurrent delivery --------------------
  // Session creation itself needs delivery, so the raced run starts while the
  // dispatcher is UP; the dispatcher then stops BEFORE the durable sleep's
  // continuation comes due, and that pending delivery is duplicated verbatim.
  const tokenB = `dual-race-${Date.now().toString(36)}`;
  const { sessionId: racedSessionId } = await startWake(deploymentA.hostPort, 30, tokenB);
  const racedRun = await waitFor(
    "the raced run to persist",
    async () => {
      const run = await latestTurnRun(project.id, deploymentA.id);
      return run && run.id !== parkedRun.id ? run : null;
    },
    60_000,
  );
  await waitFor(
    "the raced run's durable sleep to enqueue its delayed continuation",
    async () => {
      const { rows } = await worldPool.query<{ id: string }>(
        `select jobs.id::text as id
           from graphile_worker._private_jobs as jobs
          where jobs.payload ->> 'tenantId' = $1
            and convert_from(decode(jobs.payload ->> 'data', 'base64'), 'utf8')::jsonb ->> 'runId' = $2
            and jobs.run_at > now()`,
        [project.id, racedRun.id],
      );
      return rows[0] ?? null;
    },
    60_000,
  );
  await dispatcher.stop();
  log("dispatcher stopped before the continuation came due");
  const { rows: firstDeliveries } = await worldPool.query<{
    id: string;
    payload: unknown;
    queue_name: string | null;
    max_attempts: number;
  }>(
    `select jobs.id::text as id, jobs.payload, queues.queue_name, jobs.max_attempts
       from graphile_worker._private_jobs as jobs
       join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id
       left join graphile_worker._private_job_queues as queues on queues.id = jobs.job_queue_id
      where tasks.identifier = 'eveland_wf_flows'
        and jobs.payload ->> 'tenantId' = $1
        and convert_from(decode(jobs.payload ->> 'data', 'base64'), 'utf8')::jsonb ->> 'runId' = $2`,
    [project.id, racedRun.id],
  );
  assert.ok(firstDeliveries.length >= 1, "the raced run must have a pending delivery");
  const expectedQueue = runQueueName(project.id, racedRun.id);
  for (const job of firstDeliveries) {
    assert.equal(job.queue_name, expectedQueue, "every delivery sits on the exact per-run queue");
  }
  // Duplicate the pending delivery VERBATIM — same payload, same queue, same
  // due time. The delayed job IS the durable-sleep timer, so its run_at must
  // stay untouched; both copies then fire concurrently at the real deadline,
  // with B online and promoted the whole time.
  await worldPool.query(
    `select graphile_worker.add_job(
       'eveland_wf_flows', payload, queue_name => $2,
       run_at => jobs.run_at, max_attempts => (max_attempts)::integer
     )
       from graphile_worker._private_jobs as jobs
      where jobs.id = $1::bigint`,
    [firstDeliveries[0]!.id, expectedQueue],
  );
  log("duplicated the pending delivery at its original due time", {
    runId: racedRun.id,
    queue: expectedQueue,
  });

  dispatcher = spawnDispatcherApp(dispatcherEnv, log);
  await waitForDispatcherRegistration(store, { notInstanceId: secondRegistration.instanceId });

  await waitFor(
    "the raced run to complete despite the duplicate delivery",
    async () => {
      const { rows } = await worldPool.query<{ status: string; deployment_id: string }>(
        `select status, deployment_id from workflow.workflow_runs
          where tenant_id = $1 and id = $2`,
        [project.id, racedRun.id],
      );
      const run = rows[0];
      if (run?.status === "failed" || run?.status === "cancelled") {
        throw new Error(`raced run became ${run.status}`);
      }
      return run?.status === "completed" ? run : null;
    },
    10 * 60_000,
  );
  await assertRunSemantics(project.id, racedRun.id, deploymentA.id, racedSessionId);
  await assertNoPoison(project.id);

  // Steps commit exactly once even under duplicate delivery + replay: the
  // raced run's committed step histogram must be IDENTICAL to the clean
  // Part 1 run's (same workflow shape: turnStep before and after the sleep).
  // A step_name appearing twice is normal; an EXTRA commit is the failure.
  const stepHistogram = async (runId: string) => {
    const { rows } = await worldPool.query<{ step_name: string; total: number }>(
      `select step_name, count(*)::int as total
         from workflow.workflow_steps
        where tenant_id = $1 and run_id = $2 and status = 'completed'
        group by step_name order by step_name`,
      [project.id, runId],
    );
    return rows;
  };
  assert.deepEqual(
    await stepHistogram(racedRun.id),
    await stepHistogram(parkedRun.id),
    "the duplicate delivery must not commit any extra step",
  );

  // Post-recovery enqueues stayed scoped: nothing for this tenant is claimable
  // outside its run's exact queue.
  const { rows: unscoped } = await worldPool.query<{ id: string }>(
    `select jobs.id::text as id
       from graphile_worker._private_jobs as jobs
       join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id
       left join graphile_worker._private_job_queues as queues on queues.id = jobs.job_queue_id
      where tasks.identifier = 'eveland_wf_flows'
        and jobs.payload ->> 'tenantId' = $1
        and (queues.queue_name is null or queues.queue_name not like 'wfrun:%')`,
    [project.id],
  );
  assert.deepEqual(unscoped, [], "post-recovery enqueues must stay on per-run queues");

  log("PART 2 OK: duplicated continuation delivery resolved to the one owner");

  console.log("\nWORKFLOW DUAL-RELEASE E2E OK");
  console.log(
    "  PROVEN affinityAcrossRestart=1 semanticOwner=A promotedDecoy=B sessionProvenance=1 continuationRace=1 duplicatedSteps=0 peakConcurrency=1 deadLetters=0",
  );
} finally {
  await dispatcher?.stop().catch(() => {});
  await worldPool.end().catch(() => {});
  await close().catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
}
