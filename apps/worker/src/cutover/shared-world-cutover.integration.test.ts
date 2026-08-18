import { createTestStore } from "@evelandhq/db/vitest";
import {
  createWorld,
  ensureTenantPartitions,
  isRunQuarantined,
  MessageData,
  runMigrations,
  runQueueName,
} from "@evelandhq/workflow-world";
import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sharedWorkflowWorldAttestation } from "../jobs/process.test-support.js";
import {
  assessSharedActiveRuns,
  finalizeSharedWorldCutover,
  prepareSharedWorldCutover,
  verifySharedWorldPostcondition,
} from "./shared-world-cutover.js";

/**
 * The proj_Gj93h6C3Qz mechanism against a real Postgres: early-external
 * Graphile jobs without a per-run queue, owners with and without the
 * `per_run_queue_v1` enqueue capability, and runs whose provenance cannot be
 * proven. The cutover must terminate or quarantine what it cannot prove,
 * migrate in place what it can, and refuse the dispatcher postcondition until
 * nothing claimable remains outside a per-run queue.
 *
 * Set `EVELAND_WORKFLOW_WORLD_TEST_URL` to a scratch shared-world database.
 */
const testUrl = process.env.EVELAND_WORKFLOW_WORLD_TEST_URL;
const suffix = `${String(process.pid)}${Date.now().toString(36)}`;
const TENANT = `p_cut_${suffix}`;

describe.skipIf(!testUrl)("shared-world external-only cutover", () => {
  let pool: pg.Pool;
  let workerUtils: WorkerUtils;
  const worlds: Array<ReturnType<typeof createWorld>> = [];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl, max: 4 });
    await runMigrations(pool);
    await ensureTenantPartitions(pool, TENANT);
    workerUtils = await makeWorkerUtils({ pgPool: pool });
    await workerUtils.migrate();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(worlds.map(async (world) => await world.close?.()));
    await workerUtils?.release();
    await pool
      .query("delete from graphile_worker._private_jobs where payload->>'tenantId' = $1", [TENANT])
      .catch(() => {});
    await pool
      .query("delete from workflow.workflow_runs where tenant_id = $1", [TENANT])
      .catch(() => {});
    await pool
      .query("delete from workflow.run_quarantines where tenant_id = $1", [TENANT])
      .catch(() => {});
    await pool?.end().catch(() => {});
  });

  async function createControlPlaneDeployment(
    store: ReturnType<typeof createTestStore>,
    input: {
      enqueueCapability: "per_run_queue_v1" | "unscoped";
      hostPort: number;
    },
  ) {
    const project = await store.createProject({
      name: `Cutover Agent ${input.hostPort}`,
      importKind: "zip",
    });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/cutover-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    return store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: `fixture:cutover-${input.hostPort}`,
      containerName: `fixture-cutover-${input.hostPort}`,
      internalPort: 3000,
      hostPort: input.hostPort,
      runtimeKind: "docker",
      workflowWorld: {
        ...sharedWorkflowWorldAttestation,
        enqueueCapability: input.enqueueCapability,
      },
    });
  }

  async function createSharedRun(deploymentId: string): Promise<string> {
    const world = createWorld({
      connectionString: testUrl!,
      tenantId: TENANT,
      deploymentId,
      runner: "external",
    });
    worlds.push(world);
    const created = await world.events.create(null, {
      eventType: "run_created",
      eventData: { deploymentId, workflowName: "greet", input: [] },
      specVersion: 5,
    });
    const runId = created.run!.runId;
    // The default workflow topic prefix; this worker package deliberately has
    // no @workflow/world dependency of its own.
    await world.queue("__wkf_workflow_greet" as Parameters<typeof world.queue>[0], { runId });
    // Replace the modern scoped delivery with the early-external shape.
    await pool.query(
      `delete from graphile_worker._private_jobs
        where payload->>'tenantId' = $1
          and convert_from(decode(payload->>'data', 'base64'), 'utf8')::jsonb->>'runId' = $2`,
      [TENANT, runId],
    );
    return runId;
  }

  async function addEarlyExternalJob(runId: string, deploymentId: string): Promise<string> {
    const message: MessageData = {
      id: "greet",
      data: Buffer.from(JSON.stringify({ runId })),
      attempt: 1,
      messageId: `msg_early_${runId}` as MessageData["messageId"],
      tenantId: TENANT,
      deploymentId,
    };
    const job = await workerUtils.addJob("eveland_wf_flows", MessageData.encode(message), {
      maxAttempts: 10,
      flags: [`project:${TENANT}`],
    });
    return String(job.id);
  }

  test("terminates enqueue-incapable owners, migrates capable ones, and gates the dispatcher postcondition", async () => {
    const store = createTestStore();
    // The proj_Gj93h6C3Qz shape: an early-external Release that cannot scope
    // its future enqueues, with old unscoped jobs for an active run.
    const earlyDeployment = await createControlPlaneDeployment(store, {
      enqueueCapability: "unscoped",
      hostPort: 42_601,
    });
    const earlyRun = await createSharedRun(earlyDeployment.id);
    await addEarlyExternalJob(earlyRun, earlyDeployment.id);
    // A mixed-generation shape: the owner already attests per_run_queue_v1 but
    // an older dispatcher generation left an unscoped job behind.
    const capableDeployment = await createControlPlaneDeployment(store, {
      enqueueCapability: "per_run_queue_v1",
      hostPort: 42_602,
    });
    const capableRun = await createSharedRun(capableDeployment.id);
    const capableJob = await addEarlyExternalJob(capableRun, capableDeployment.id);

    // Before the cutover, the dispatcher postcondition must refuse.
    const before = await verifySharedWorldPostcondition(pool, store);
    expect(before.passed).toBe(false);
    expect(before.claimableUnscopedJobs).toBeGreaterThanOrEqual(2);

    const assessments = await assessSharedActiveRuns(pool, store);
    const earlyAssessment = assessments.find((entry) => entry.runId === earlyRun);
    const capableAssessment = assessments.find((entry) => entry.runId === capableRun);
    expect(earlyAssessment?.classification).toBe("managed_termination_required");
    expect(capableAssessment?.classification).toBe("queue_migration_required");

    const result = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: "cut_it_1",
    });

    // The incapable owner is terminated and quarantined, never re-activated.
    expect(result.terminated).toContainEqual({ tenantId: TENANT, runId: earlyRun });
    expect(await isRunQuarantined(pool, TENANT, earlyRun)).toBe(true);
    await expect(
      store.acquireActivationLease({
        deploymentId: earlyDeployment.id,
        kind: "workflow_step",
        ownerId: "wfd_test",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/workflow_unavailable/);

    // The capable owner's old job moved onto the exact per-run queue in place.
    const migrated = await pool.query<{ queue_name: string | null; payload: unknown }>(
      `select queues.queue_name, jobs.payload
         from graphile_worker._private_jobs as jobs
         left join graphile_worker._private_job_queues as queues on queues.id = jobs.job_queue_id
        where jobs.id = $1::bigint`,
      [capableJob],
    );
    expect(migrated.rows[0]?.queue_name).toBe(runQueueName(TENANT, capableRun));
    expect(result.staged).toContain(capableDeployment.id);

    // The postcondition now clears — the recover-paused dispatcher may proceed.
    const after = await verifySharedWorldPostcondition(pool, store);
    expect(after).toMatchObject({ passed: true, claimableUnscopedJobs: 0, blockingRuns: [] });

    // Re-running the whole preparation is a no-op, not a second termination.
    const rerun = await prepareSharedWorldCutover({ pool, store, operationId: "cut_it_1" });
    expect(rerun.migration.scoped).toBe(0);

    // Finalize only after the continuity gate: the staged deployment becomes
    // the external topology and its launches are allowed again.
    const finalizeResult = await finalizeSharedWorldCutover({
      pool,
      store,
      operationId: "cut_it_1",
      deploymentIds: result.staged,
    });
    expect(finalizeResult.refused).toEqual([]);
    // A typo or stale invocation never promotes an unstaged deployment.
    const bogus = await finalizeSharedWorldCutover({
      pool,
      store,
      operationId: "cut_it_1",
      deploymentIds: [earlyDeployment.id],
    });
    expect(bogus.finalized).toEqual([]);
    expect(bogus.refused[0]?.reason).toContain("not converting");
    await expect(store.getDeployment(capableDeployment.id)).resolves.toMatchObject({
      workflowTopology: { conversionState: "external", runnerMode: "external" },
    });
    await expect(store.getWorkflowCutoverOperation("cut_it_1")).resolves.toMatchObject({
      phase: "completed",
    });
  }, 120_000);

  test("a historical unknown Release reaches recoverable_shared through artifact classification", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Historical Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/historical-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    // No attestation: migration 0052 backfilled this Release as unknown.
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "/var/lib/eveland/builds/historical/rel_hist",
      containerName: "fixture-historical",
      internalPort: 3000,
      hostPort: 42_604,
      runtimeKind: "systemd",
    });
    const runId = await createSharedRun(deployment.id);

    // The classifier stands in for reading the immutable systemd artifact,
    // which proves a 0.9.0 shared world was actually injected.
    const assessments = await assessSharedActiveRuns(pool, store, {
      classifier: async (input) => {
        expect(input).toEqual({
          releaseRef: "/var/lib/eveland/builds/historical/rel_hist",
          runtimeKind: "systemd",
        });
        return {
          worldKind: "shared",
          worldPackage: "@evelandhq/workflow-world",
          worldVersion: "0.9.0",
          storageSpec: 6,
          dispatchProtocol: 1,
          enqueueCapability: "per_run_queue_v1",
        };
      },
    });
    expect(assessments.find((entry) => entry.runId === runId)?.classification).toBe(
      "recoverable_shared",
    );
    // The attestation persisted: a later assessment needs no classifier.
    await expect(store.getRelease(deployment.releaseId)).resolves.toMatchObject({
      workflow: { worldKind: "shared", enqueueCapability: "per_run_queue_v1" },
    });
    const again = await assessSharedActiveRuns(pool, store, {
      classifier: async () => {
        throw new Error("attestation is persisted; the classifier must not run again");
      },
    });
    expect(again.find((entry) => entry.runId === runId)?.classification).toBe("recoverable_shared");
    // Attestation is immutable once known.
    await expect(
      store.attestReleaseWorkflow(deployment.releaseId, {
        worldKind: "legacy_project",
        worldPackage: "@workflow/world-postgres",
        worldVersion: "5.0.0-beta.34",
        storageSpec: 6,
        dispatchProtocol: null,
        enqueueCapability: "unscoped",
      }),
    ).resolves.toBeNull();
  }, 120_000);

  test("one bad run never takes down its Deployment's healthy sibling", async () => {
    const store = createTestStore();
    const deployment = await createControlPlaneDeployment(store, {
      enqueueCapability: "per_run_queue_v1",
      hostPort: 42_605,
    });
    const healthyRun = await createSharedRun(deployment.id);
    const corruptRun = await createSharedRun(deployment.id);

    const result = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: "cut_it_3",
      corruptedRuns: [{ tenantId: TENANT, runId: corruptRun }],
    });

    // The corrupt run is fenced and quarantined at RUN scope…
    expect(await isRunQuarantined(pool, TENANT, corruptRun)).toBe(true);
    expect(result.retiredDeployments).not.toContain(deployment.id);
    // …while the shared-capable owner keeps its healthy run: no deployment
    // fence, activation still possible, and the deployment stages.
    expect(await store.getActiveWorkflowFence("deployment", deployment.id)).toBeNull();
    await expect(
      store.acquireActivationLease({
        deploymentId: deployment.id,
        kind: "workflow_step",
        ownerId: "wfd_sibling_test",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toHaveProperty("lease");
    expect(await isRunQuarantined(pool, TENANT, healthyRun)).toBe(false);
    expect(result.staged).toContain(deployment.id);
  }, 120_000);

  test("a run whose namespace was never recorded is quarantined, not guessed", async () => {
    const store = createTestStore();
    const deployment = await createControlPlaneDeployment(store, {
      enqueueCapability: "per_run_queue_v1",
      hostPort: 42_603,
    });
    const runId = await createSharedRun(deployment.id);
    await pool.query(
      "update workflow.workflow_runs set queue_namespace = null where tenant_id = $1 and id = $2",
      [TENANT, runId],
    );

    const assessments = await assessSharedActiveRuns(pool, store);
    expect(assessments.find((entry) => entry.runId === runId)?.classification).toBe(
      "quarantined_unknown",
    );

    await prepareSharedWorldCutover({ pool, store, operationId: "cut_it_2" });
    expect(await isRunQuarantined(pool, TENANT, runId)).toBe(true);
    const post = await verifySharedWorldPostcondition(pool, store);
    expect(post.passed).toBe(true);
  }, 120_000);
});
