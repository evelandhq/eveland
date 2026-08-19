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
const controlPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
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

/** Cold-activate a deployment through the Control API's public-request path. */
async function wakeDeployment(deploymentId: string): Promise<void> {
  const apiUrl = (process.env.EVELAND_API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(
    /\/+$/u,
    "",
  );
  const token = process.env.EVELAND_GATEWAY_SERVICE_TOKEN ?? "eveland-dev-gateway-token";
  const response = await fetch(`${apiUrl}/internal/runtime/activations`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      deploymentId,
      kind: "public_request",
      ownerId: `dual-e2e-wake-${Date.now().toString(36)}`,
    }),
    signal: AbortSignal.timeout(2 * 60_000),
  });
  const body = await response.text();
  assert.ok(
    response.ok,
    `wake activation for ${deploymentId} returned HTTP ${String(response.status)}: ${body}`,
  );
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
  const thirdRegistration = await waitForDispatcherRegistration(store, {
    notInstanceId: secondRegistration.instanceId,
  });

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

  // --- Part 3: the first-delivery race, BEFORE any dispatch ownership --------
  // In Eve's external flow the SENDER persists run_created before the first
  // delivery exists, so a row-absent window is not reachable from outside
  // (the dispatcher's hint path serves runtimes where the executor writes
  // the row; its no-row branch is unit-covered upstream). The strongest
  // constructible live race is therefore the first-DISPATCH window: the run
  // row is `pending`, no delivery has ever been claimed, and two genuinely
  // concurrent copies of the first message — one on the exact per-run queue,
  // one deliberately off-queue so nothing serializes them — compete for
  // first dispatch ownership with both Releases proven online and B still
  // the promoted decoy.
  await wakeDeployment(deploymentA.id);
  await wakeDeployment(deploymentB.id);
  const warmToken = `dual-warm-${Date.now().toString(36)}`;
  await startWake(deploymentB.hostPort, 1, warmToken); // B live and serving its own session
  await dispatcher.stop();
  const bothReady = async () => {
    for (const deployment of [deploymentA, deploymentB]) {
      const instances = await store.listDeploymentRuntimeInstances(deployment.id);
      assert.ok(
        instances.some((instance) => instance.status === "ready"),
        `deployment ${deployment.id} must be online for the first-write race`,
      );
    }
  };
  await bothReady();
  log("both Releases online; dispatcher stopped for the first-write window");

  const raceToken = `dual-row-race-${Date.now().toString(36)}`;
  // Fire and DO NOT await: the deployment enqueues the first delivery
  // immediately, but the response waits on a delivery no dispatcher will make
  // yet. The enqueue is durable either way.
  const raceRequest = fetch(`http://127.0.0.1:${String(deploymentA.hostPort)}/start-wake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seconds: 5, token: raceToken }),
    signal: AbortSignal.timeout(5 * 60_000),
  }).catch(() => null);

  const pendingFirst = await waitFor(
    "a never-dispatched first delivery for a still-pending run",
    async () => {
      const { rows } = await worldPool.query<{
        id: string;
        run_id: string;
        message_id: string;
        hint: string;
        queue_name: string | null;
      }>(
        `select jobs.id::text as id,
                coalesce(convert_from(decode(jobs.payload ->> 'data', 'base64'), 'utf8')::jsonb ->> 'runId',
                         convert_from(decode(jobs.payload ->> 'data', 'base64'), 'utf8')::jsonb ->> 'workflowRunId') as run_id,
                jobs.payload ->> 'messageId' as message_id,
                jobs.payload ->> 'deploymentId' as hint,
                queues.queue_name
           from graphile_worker._private_jobs as jobs
           join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id
           left join graphile_worker._private_job_queues as queues on queues.id = jobs.job_queue_id
          where tasks.identifier = 'eveland_wf_flows'
            and jobs.locked_by is null
            and jobs.attempts = 0
            and jobs.payload ->> 'tenantId' = $1
            and exists (
              select 1 from workflow.workflow_runs as runs
               where runs.tenant_id = $1
                 and runs.status = 'pending'
                 and runs.name = 'workflow//eve//workflowEntry'
                 and runs.id = coalesce(convert_from(decode(jobs.payload ->> 'data', 'base64'), 'utf8')::jsonb ->> 'runId',
                                        convert_from(decode(jobs.payload ->> 'data', 'base64'), 'utf8')::jsonb ->> 'workflowRunId')
            )`,
        [project.id],
      );
      return rows.find((row) => row.run_id) ?? null;
    },
    60_000,
  );
  assert.equal(
    pendingFirst.hint,
    deploymentA.id,
    "the enqueue hint must name the enqueuing Release",
  );
  assert.equal(
    pendingFirst.queue_name,
    runQueueName(project.id, pendingFirst.run_id),
    "even the first delivery sits on its run's exact queue",
  );
  // Nothing has ever dispatched this run: the row is pending and its only
  // delivery is unclaimed with zero attempts — first ownership is still open.
  const { rows: pendingRow } = await worldPool.query<{ status: string }>(
    `select status from workflow.workflow_runs where tenant_id = $1 and id = $2`,
    [project.id, pendingFirst.run_id],
  );
  assert.equal(pendingRow[0]?.status, "pending", "the race must start before any dispatch");
  // The duplicate goes UNQUEUED on purpose — the per-run queue would
  // serialize it — and carries a DISTINCT messageId: the dispatcher's
  // in-process dedup (keyed by message identity) swallows a verbatim copy
  // before it ever activates, as a previous run of this harness proved live.
  // A redelivery beyond dedup's reach is the shape the historical incidents
  // actually had. Both copies park FAR in the future first: the restarting
  // dispatcher's preflight (correctly!) refuses to boot over a claimable
  // unscoped job — also proven live by this harness.
  const parkUntil = new Date(Date.now() + 10 * 60_000).toISOString();
  const duplicateMessageId = `msg_race_dup_${Date.now().toString(36)}`;
  await worldPool.query(
    `select graphile_worker.add_job(
       'eveland_wf_flows',
       (jobs.payload::jsonb || jsonb_build_object('messageId', $3::text))::json,
       run_at => $2::timestamptz, max_attempts => (max_attempts)::integer)
       from graphile_worker._private_jobs as jobs
      where jobs.id = $1::bigint`,
    [pendingFirst.id, parkUntil, duplicateMessageId],
  );
  await worldPool.query(
    `update graphile_worker._private_jobs set run_at = $2::timestamptz where id = $1::bigint`,
    [pendingFirst.id, parkUntil],
  );
  log("duplicated the never-dispatched first delivery off-queue; both copies parked", {
    runId: pendingFirst.run_id,
    messageId: pendingFirst.message_id,
    duplicateMessageId,
  });

  // Hold the dispatcher where boot recovery CANNOT settle the run: start it
  // recover-paused (recovery re-enqueues, the pool claims nothing), prove
  // the run is still pending, remove recovery's own re-delivery of this run
  // while paused, resume, prove the run is STILL pending — and only then
  // release both copies together. The race IS the first dispatch.
  dispatcher = spawnDispatcherApp(
    { ...dispatcherEnv, EVELAND_WORKFLOW_DISPATCHER_START_MODE: "recover-paused" },
    log,
  );
  // The previous instance's final heartbeat can still read fresh+ready; wait
  // for the NEW instance to register in the paused state specifically.
  await waitFor(
    "the recover-paused dispatcher to register as ready_paused",
    async () => {
      const registration = await store.getWorkflowDispatcherRegistration();
      return registration?.state === "ready_paused" &&
        registration.instanceId !== thirdRegistration.instanceId
        ? registration
        : null;
    },
    2 * 60_000,
  );
  const assertStillPending = async (when: string) => {
    const { rows } = await worldPool.query<{ status: string }>(
      `select status from workflow.workflow_runs where tenant_id = $1 and id = $2`,
      [project.id, pendingFirst.run_id],
    );
    assert.equal(rows[0]?.status, "pending", `the raced run must still be undispatched ${when}`);
  };
  await assertStillPending("while the dispatcher is ready_paused");
  await worldPool.query(
    `delete from graphile_worker._private_jobs
      where payload ->> 'tenantId' = $1 and payload ->> 'messageId' = $2 and locked_by is null`,
    [project.id, `msg_recover_${pendingFirst.run_id}`],
  );
  const apiUrl = (process.env.EVELAND_API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(
    /\/+$/u,
    "",
  );
  const resume = await fetch(`${apiUrl}/internal/workflow/dispatcher/resume`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.WORKFLOW_DISPATCHER_ACTIVATION_TOKEN ?? "eveland-dev-gateway-token"}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(resume.ok, `dispatcher resume returned HTTP ${String(resume.status)}`);
  await waitFor(
    "the dispatcher to pick the resume up and start its pool",
    async () => {
      const registration = await store.getWorkflowDispatcherRegistration();
      return registration?.state === "ready" &&
        registration.instanceId !== thirdRegistration.instanceId
        ? registration
        : null;
    },
    60_000,
  );
  await bothReady();
  await assertStillPending("after resume, before the copies are released");
  // Release both copies together: due NOW, claimable in the same poll tick.
  await worldPool.query(
    `update graphile_worker._private_jobs set run_at = now()
      where id = $1::bigint
         or payload ->> 'messageId' = $2`,
    [pendingFirst.id, duplicateMessageId],
  );
  log("released both first-delivery copies together", {
    runId: pendingFirst.run_id,
  });

  const firstWrite = await waitFor(
    "the run's first dispatch to settle its execution",
    async () => {
      const { rows } = await worldPool.query<{ deployment_id: string; status: string }>(
        `select deployment_id, status from workflow.workflow_runs
          where tenant_id = $1 and id = $2 and status <> 'pending'`,
        [project.id, pendingFirst.run_id],
      );
      return rows[0] ?? null;
    },
    3 * 60_000,
  );
  assert.equal(
    firstWrite.deployment_id,
    deploymentA.id,
    "the first dispatch must land on the hint owner — never the promoted decoy",
  );
  const racedTurn = await waitFor(
    "the raced session's turn to complete",
    async () => {
      const run = await latestTurnRun(project.id, deploymentA.id);
      if (run?.status === "failed" || run?.status === "cancelled") {
        throw new Error(`raced-session turn became ${run.status}`);
      }
      return run && run.id !== parkedRun.id && run.id !== racedRun.id && run.status === "completed"
        ? run
        : null;
    },
    10 * 60_000,
  );
  await raceRequest;
  await assertRunSemantics(project.id, racedTurn.id, deploymentA.id, pendingFirst.run_id);
  await assertNoPoison(project.id);

  // Wait until both released copies are actually consumed before reading
  // the lease trail.
  await waitFor(
    "both raced delivery copies to be consumed",
    async () => {
      const { rows } = await worldPool.query<{ remaining: number }>(
        `select count(*)::int as remaining
           from graphile_worker._private_jobs as jobs
          where jobs.id = $1::bigint
             or jobs.payload ->> 'messageId' = $2`,
        [pendingFirst.id, duplicateMessageId],
      );
      return (rows[0]?.remaining ?? 0) === 0 ? true : null;
    },
    3 * 60_000,
  );
  // Every dispatch of the raced message — either copy — activated A and only
  // A. With recovery's re-delivery removed and both identities distinct,
  // neither copy can be dedup-swallowed: BOTH must have activated A.
  const raceOwners = [
    `workflow-dispatcher:${pendingFirst.message_id}`,
    `workflow-dispatcher:${duplicateMessageId}`,
  ];
  const { rows: foreignLeases } = await controlPool.query<{ deployment_id: string }>(
    `select deployment_id from activation_leases
      where owner_id = any($1) and deployment_id <> $2`,
    [raceOwners, deploymentA.id],
  );
  assert.deepEqual(foreignLeases, [], "no delivery of the raced message may leave Release A");
  const { rows: homeLeases } = await controlPool.query<{ deployment_id: string }>(
    `select deployment_id from activation_leases
      where owner_id = any($1) and deployment_id = $2`,
    [raceOwners, deploymentA.id],
  );
  assert.ok(
    homeLeases.length >= 2,
    `both raced deliveries must have activated Release A (saw ${String(homeLeases.length)})`,
  );

  // Observed peak execution concurrency 1: no two steps of the raced turn
  // overlap in time.
  const { rows: overlapping } = await worldPool.query<{ total: number }>(
    `select count(*)::int as total
       from workflow.workflow_steps as s1
       join workflow.workflow_steps as s2
         on s2.tenant_id = s1.tenant_id and s2.run_id = s1.run_id
        and s2.step_id <> s1.step_id
        and s1.started_at < s2.completed_at
        and s2.started_at < s1.completed_at
      where s1.tenant_id = $1 and s1.run_id = $2
        and s1.completed_at is not null and s2.completed_at is not null`,
    [project.id, racedTurn.id],
  );
  assert.equal(overlapping[0]?.total ?? 0, 0, "peak step execution concurrency must be 1");
  log("PART 3 OK: the first-dispatch race chose one owner, once");

  console.log("\nWORKFLOW DUAL-RELEASE E2E OK");
  console.log(
    "  PROVEN affinityAcrossRestart=1 semanticOwner=A promotedDecoy=B sessionProvenance=1 continuationRace=1 firstDispatchRace=1 duplicatedSteps=0 peakConcurrency=1 deadLetters=0",
  );
} finally {
  await dispatcher?.stop().catch(() => {});
  // Never strand an off-queue duplicate: a claimable unscoped job would
  // (correctly) block every later dispatcher boot against this World.
  await worldPool
    .query(
      `delete from graphile_worker._private_jobs as jobs
        using graphile_worker._private_tasks as tasks
        where tasks.id = jobs.task_id
          and tasks.identifier = 'eveland_wf_flows'
          and jobs.job_queue_id is null
          and jobs.locked_by is null`,
    )
    .catch(() => {});
  await worldPool.end().catch(() => {});
  await controlPool.end().catch(() => {});
  await close().catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
}
