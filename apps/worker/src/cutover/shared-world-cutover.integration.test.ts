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
  dropProjectWorkflowWorld,
  ensureProjectWorkflowWorld,
} from "../runtime/workflow-world-bootstrap.js";
import { terminateLegacyProjectRuns } from "./legacy-world-termination.js";
import {
  assessCutoverProofEligibility,
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
const TEST_MAINTENANCE = { quiescenceVerified: true, backupEvidence: "pg_dump:test-snapshot" };
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
      dispatchProtocol?: number | null;
      storageSpec?: number | null;
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
        ...(input.dispatchProtocol !== undefined
          ? { dispatchProtocol: input.dispatchProtocol }
          : {}),
        ...(input.storageSpec !== undefined ? { storageSpec: input.storageSpec } : {}),
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
    // A shared-capable owner with NO active run: it stages purely through the
    // control-plane inventory, so a rerun (where it is already `converting`)
    // proves the staged checkpoint never shrinks.
    const idleDeployment = await createControlPlaneDeployment(store, {
      enqueueCapability: "per_run_queue_v1",
      hostPort: 42_606,
    });
    // Simulate the historical shape: recorded before the topology columns
    // existed, so migration 0052 left it unclassified.
    await store.updateDeploymentWorkflowTopology(idleDeployment.id, {
      runnerMode: "unknown",
      conversionState: "unclassified",
    });

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
      operationId: `cut_it_1_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
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
    // Managed termination is terminal topology too: archive permits only
    // external|terminated, so the retired owner must not stay unclassified.
    await expect(store.getDeployment(earlyDeployment.id)).resolves.toMatchObject({
      workflowTopology: { conversionState: "terminated" },
    });

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
    expect(result.staged).toContain(idleDeployment.id);

    // The postcondition now clears — the recover-paused dispatcher may proceed.
    const after = await verifySharedWorldPostcondition(pool, store);
    expect(after).toMatchObject({ passed: true, claimableUnscopedJobs: 0, blockingRuns: [] });

    // Re-running the whole preparation is a no-op, not a second termination —
    // and the durable staged set only grows: the idle deployment is now
    // `converting`, invisible to both inventory and run assessment, yet must
    // survive in the checkpoint or finalize would complete without it.
    const rerun = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_1_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
    });
    expect(rerun.migration.scoped).toBe(0);
    expect(rerun.holds).toEqual([]);
    expect(rerun.staged).toContain(idleDeployment.id);
    expect(rerun.staged).toContain(capableDeployment.id);

    // Finalize only after the continuity gate: the staged deployment becomes
    // the external topology and its launches are allowed again.
    // Without the continuity checkpoint the operation must NOT complete.
    const premature = await finalizeSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_1_${suffix}`,
      deploymentIds: result.staged,
    });
    expect(premature.completed).toBe(false);
    await expect(store.getWorkflowCutoverOperation(`cut_it_1_${suffix}`)).resolves.toMatchObject({
      phase: "control_plane_converged",
    });
    const finalizeResult = await finalizeSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_1_${suffix}`,
      deploymentIds: result.staged,
      continuityVerified: true,
    });
    expect(finalizeResult.refused).toEqual([]);
    expect(finalizeResult.completed).toBe(true);
    // A typo or stale invocation never promotes an unstaged deployment.
    const bogus = await finalizeSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_1_${suffix}`,
      deploymentIds: [earlyDeployment.id],
    });
    expect(bogus.finalized).toEqual([]);
    expect(bogus.refused[0]?.reason).toContain("not converting");
    await expect(store.getDeployment(capableDeployment.id)).resolves.toMatchObject({
      workflowTopology: { conversionState: "external", runnerMode: "external" },
    });
    await expect(store.getWorkflowCutoverOperation(`cut_it_1_${suffix}`)).resolves.toMatchObject({
      phase: "completed",
    });
    // Leave no active run behind: later tests share this World database.
    await pool.query(
      "update workflow.workflow_runs set status = 'completed', completed_at = now() where tenant_id = $1 and id = $2",
      [TENANT, capableRun],
    );
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
        if (input.releaseRef !== "/var/lib/eveland/builds/historical/rel_hist") return null;
        expect(input.runtimeKind).toBe("systemd");
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
    await pool.query(
      "update workflow.workflow_runs set status = 'completed', completed_at = now() where tenant_id = $1 and id = $2",
      [TENANT, runId],
    );
  }, 120_000);

  test("one bad run never takes down its Deployment's healthy sibling", async () => {
    const store = createTestStore();
    const deployment = await createControlPlaneDeployment(store, {
      enqueueCapability: "per_run_queue_v1",
      hostPort: 42_605,
    });
    const healthyRun = await createSharedRun(deployment.id);
    const corruptRun = await createSharedRun(deployment.id);

    // Without a proven Eve family for the terminated run, the saga HOLDS at
    // workflow_safe: the quarantine satisfies the World postcondition, so
    // this is the only gate that notices the missing tombstone.
    const held = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_3_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
      corruptedRuns: [{ tenantId: TENANT, runId: corruptRun }],
    });
    expect(held.holds[0]).toMatch(/no proven Eve family/);
    expect(held.unmappedTerminatedRuns).toContainEqual({ tenantId: TENANT, runId: corruptRun });
    expect(held.staged).not.toContain(deployment.id);
    await expect(store.getWorkflowCutoverOperation(`cut_it_3_${suffix}`)).resolves.toMatchObject({
      phase: "workflow_safe",
    });

    // The retry supplies the mapping. The run was already CANCELLED by the
    // first pass, so it no longer appears in the live assessment — the
    // mapping must land against the durable quarantine identity, produce the
    // session-family tombstone, and clear the hold.
    const result = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_3_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
      runSessionFamilies: [
        { tenantId: TENANT, runId: corruptRun, eveSessionId: "eve_corrupt_family" },
      ],
    });
    expect(result.holds).toEqual([]);
    expect(result.unmappedTerminatedRuns).toEqual([]);
    expect(
      await store.getActiveWorkflowFence("session_family", `${TENANT}:eve_corrupt_family`),
    ).toMatchObject({ operationId: `cut_it_3_${suffix}` });
    await expect(store.getWorkflowCutoverOperation(`cut_it_3_${suffix}`)).resolves.toMatchObject({
      phase: "control_plane_converged",
    });

    // The disposition is durable: a third pass with NO flags must not
    // rediscover the run as unmapped.
    const third = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_3_${suffix}`,
    });
    expect(third.holds).toEqual([]);
    expect(third.unmappedTerminatedRuns).toEqual([]);

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
    await pool.query(
      "update workflow.workflow_runs set status = 'completed', completed_at = now() where tenant_id = $1 and id = $2",
      [TENANT, healthyRun],
    );
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

    await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_2_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
      runsWithoutFamilies: [{ tenantId: TENANT, runId }],
    });
    expect(await isRunQuarantined(pool, TENANT, runId)).toBe(true);
    const post = await verifySharedWorldPostcondition(pool, store);
    expect(post.passed).toBe(true);
  }, 120_000);

  test("archived historical deployments still classify and fence for late telemetry", async () => {
    const store = createTestStore();
    const archivedUnscoped = await createControlPlaneDeployment(store, {
      enqueueCapability: "unscoped",
      hostPort: 42_607,
    });
    const archivedShared = await createControlPlaneDeployment(store, {
      enqueueCapability: "per_run_queue_v1",
      hostPort: 42_608,
    });
    await store.updateDeploymentStatus(archivedUnscoped.id, "archived");
    await store.updateDeploymentStatus(archivedShared.id, "archived");

    const result = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_4_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
    });
    expect(result.holds).toEqual([]);
    // The retired archived owner is deployment-fenced: the OTLP projector
    // accepts retained rows regardless of archive status, so a delayed batch
    // must hit the fence, not a gap.
    expect(result.retiredDeployments).toContain(archivedUnscoped.id);
    expect(await store.getActiveWorkflowFence("deployment", archivedUnscoped.id)).toMatchObject({
      operationId: `cut_it_4_${suffix}`,
    });
    // The shared-capable archived row classifies but never stages — an
    // archived Deployment has no runtime future to convert.
    expect(result.staged).not.toContain(archivedShared.id);
    expect(await store.getActiveWorkflowFence("deployment", archivedShared.id)).toBeNull();
  }, 120_000);

  test("legacy Worlds must terminate in their own databases before workflow_safe", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Legacy Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/legacy-agent",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "fixture:legacy",
      containerName: "fixture-legacy",
      internalPort: 3000,
      hostPort: 42_609,
      runtimeKind: "docker",
      workflowWorld: {
        worldKind: "legacy_project",
        worldPackage: "@workflow/world-postgres",
        worldVersion: "5.0.0-beta.34",
        storageSpec: 6,
        dispatchProtocol: null,
        enqueueCapability: "unscoped",
      },
    });

    // No legacy base URL: retiring the owner in the control plane alone must
    // NOT count as workflow safety — the saga holds at `fenced`.
    const held = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_5_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
      legacyWorlds: { baseUrl: undefined },
    });
    expect(held.holds[0]).toMatch(/legacy Worlds/);
    await expect(store.getWorkflowCutoverOperation(`cut_it_5_${suffix}`)).resolves.toMatchObject({
      phase: "fenced",
    });

    // A termination that leaves active runs behind is a hold too.
    const stillActive = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_5_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
      legacyWorlds: {
        baseUrl: "postgres://unused.invalid/postgres",
        terminate: async (_baseUrl, projectId) => ({
          projectId,
          database: `eveland_wf_${projectId}`,
          cancelledRuns: 1,
          remainingActiveRuns: 1,
        }),
      },
    });
    expect(stillActive.holds[0]).toMatch(/still has 1 active run/);

    // A clean termination lets the saga proceed and retires the owner.
    const done = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_5_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
      legacyWorlds: {
        baseUrl: "postgres://unused.invalid/postgres",
        terminate: async (_baseUrl, projectId) => ({
          projectId,
          database: `eveland_wf_${projectId}`,
          cancelledRuns: 3,
          remainingActiveRuns: 0,
        }),
      },
    });
    expect(done.holds).toEqual([]);
    expect(done.legacyWorlds[0]?.cancelledRuns).toBe(3);
    expect(done.retiredDeployments).toContain(deployment.id);
    expect(await store.getActiveWorkflowFence("deployment", deployment.id)).toMatchObject({
      operationId: `cut_it_5_${suffix}`,
    });
    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({
      workflowTopology: { conversionState: "terminated" },
    });
    await expect(store.getWorkflowCutoverOperation(`cut_it_5_${suffix}`)).resolves.toMatchObject({
      phase: "control_plane_converged",
    });
  }, 120_000);

  test("an idle owner outside the dispatch-protocol window retires instead of staging", async () => {
    const store = createTestStore();
    // per_run_queue_v1 but no dispatch protocol: a pre-protocol Release. With
    // no active run it never passes through the run assessment — the
    // inventory itself must apply the full compatibility window.
    const deployment = await createControlPlaneDeployment(store, {
      enqueueCapability: "per_run_queue_v1",
      hostPort: 42_610,
      dispatchProtocol: null,
    });
    await store.updateDeploymentWorkflowTopology(deployment.id, {
      runnerMode: "unknown",
      conversionState: "unclassified",
    });

    const result = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_6_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
    });
    expect(result.holds).toEqual([]);
    expect(result.staged).not.toContain(deployment.id);
    expect(result.retiredDeployments).toContain(deployment.id);
    expect(await store.getActiveWorkflowFence("deployment", deployment.id)).toMatchObject({
      operationId: `cut_it_6_${suffix}`,
    });
    await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({
      workflowTopology: { conversionState: "terminated" },
    });
  }, 120_000);

  test("the default legacy terminator cancels runs in a real world-postgres database", async () => {
    // The real @workflow/world-postgres schema, installed by the real setup
    // binary — the same path ensureProjectWorkflowWorld takes in production —
    // so the terminator's table, enum and column assumptions are proven, not
    // presumed.
    const projectId = `p_leg_${suffix}`;
    const env = { WORKFLOW_POSTGRES_URL: testUrl } as NodeJS.ProcessEnv;
    try {
      const runtimeUrl = await ensureProjectWorkflowWorld(env, projectId, { cache: new Set() });
      expect(runtimeUrl).toBeTruthy();
      const legacy = new pg.Client({ connectionString: runtimeUrl });
      await legacy.connect();
      try {
        // 'paused' no longer exists at the migrated schema head (world-postgres
        // migration 0004 dropped it); the terminator compares as text so it
        // covers pre-0004 databases without an enum-literal error here.
        await legacy.query(
          `insert into workflow.workflow_runs (id, deployment_id, status, name, input)
           values ('wrun_leg_active', 'dep_leg', 'running', 'greet', '[]'::jsonb),
                  ('wrun_leg_waiting', 'dep_leg', 'pending', 'greet', '[]'::jsonb),
                  ('wrun_leg_done', 'dep_leg', 'completed', 'greet', '[]'::jsonb)`,
        );
      } finally {
        await legacy.end().catch(() => {});
      }

      const result = await terminateLegacyProjectRuns(testUrl!, projectId);
      expect(result).toMatchObject({ cancelledRuns: 2, remainingActiveRuns: 0 });
      expect(result.database).toContain("eveland_wf_");

      const verify = new pg.Client({ connectionString: runtimeUrl });
      await verify.connect();
      try {
        const { rows } = await verify.query(
          `select id, status from workflow.workflow_runs order by id`,
        );
        expect(rows).toEqual([
          { id: "wrun_leg_active", status: "cancelled" },
          { id: "wrun_leg_done", status: "completed" },
          { id: "wrun_leg_waiting", status: "cancelled" },
        ]);
      } finally {
        await verify.end().catch(() => {});
      }

      // A database that does not exist reports itself instead of failing.
      await expect(terminateLegacyProjectRuns(testUrl!, "p_never_existed")).resolves.toMatchObject({
        database: null,
        cancelledRuns: 0,
        remainingActiveRuns: 0,
      });
    } finally {
      await dropProjectWorkflowWorld(env, projectId).catch(() => {});
    }
  }, 120_000);

  test("prepare mutates nothing until the maintenance boundary is attested", async () => {
    const store = createTestStore();
    const deployment = await createControlPlaneDeployment(store, {
      enqueueCapability: "unscoped",
      hostPort: 42_611,
    });

    const held = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_7_${suffix}`,
    });
    expect(held.holds[0]).toMatch(/maintenance boundary not attested/);
    // Nothing mutated: no fence, no retirement, phase still pending.
    expect(held.retiredDeployments).toEqual([]);
    expect(await store.getActiveWorkflowFence("deployment", deployment.id)).toBeNull();
    await expect(store.getWorkflowCutoverOperation(`cut_it_7_${suffix}`)).resolves.toMatchObject({
      phase: "pending",
    });
    // A pending operation must never mint a passing World proof, even though
    // the bare database postcondition can hold on a quiet shared World.
    const eligibility = await assessCutoverProofEligibility(store, `cut_it_7_${suffix}`);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons[0]).toMatch(/prepare must reach control-plane convergence/);

    // The attestation is durable: supplied once, later reruns need no flags.
    const attested = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_7_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
    });
    expect(attested.holds).toEqual([]);
    expect(attested.retiredDeployments).toContain(deployment.id);
    const rerun = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_7_${suffix}`,
    });
    expect(rerun.holds).toEqual([]);
    await expect(assessCutoverProofEligibility(store, `cut_it_7_${suffix}`)).resolves.toMatchObject(
      { eligible: true },
    );

    // Writes AFTER the recorded backup invalidate the boundary: the snapshot
    // is only a rollback point while nothing has advanced past it.
    await store.createSession({
      projectId: deployment.projectId,
      deploymentId: deployment.id,
      trigger: "playground",
      eveSessionId: "eve_after_backup",
    });
    const invalidated = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_7_${suffix}`,
    });
    expect(invalidated.holds[0]).toMatch(/maintenance boundary invalidated/);
    // Re-attestation over fresh backups re-measures and re-baselines.
    const reattested = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_7_${suffix}`,
      maintenance: { quiescenceVerified: true, backupEvidence: "pg_dump:fresh-snapshot" },
      quiescenceSettleMs: 50,
    });
    expect(reattested.holds).toEqual([]);
  }, 120_000);

  test("attestation is refused while the system is measurably live", async () => {
    const store = createTestStore();
    const deployment = await createControlPlaneDeployment(store, {
      enqueueCapability: "per_run_queue_v1",
      hostPort: 42_614,
    });
    // A live activation lease is a running consumer: two flags must not beat
    // the measurement.
    await store.acquireActivationLease({
      deploymentId: deployment.id,
      kind: "public_request",
      ownerId: "req_still_alive",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const held = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_9_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
    });
    expect(held.holds[0]).toMatch(/quiescence not measured/);
    expect(held.holds[0]).toMatch(/activation lease/);
    await expect(store.getWorkflowCutoverOperation(`cut_it_9_${suffix}`)).resolves.toMatchObject({
      phase: "pending",
    });
  }, 120_000);

  test("an owner outside the storage window retires, idle or active", async () => {
    const store = createTestStore();
    // Idle: never passes through the run assessment.
    const idleStale = await createControlPlaneDeployment(store, {
      enqueueCapability: "per_run_queue_v1",
      hostPort: 42_612,
      storageSpec: null,
    });
    await store.updateDeploymentWorkflowTopology(idleStale.id, {
      runnerMode: "unknown",
      conversionState: "unclassified",
    });
    // Active: the run assessment must reach the same verdict.
    const activeStale = await createControlPlaneDeployment(store, {
      enqueueCapability: "per_run_queue_v1",
      hostPort: 42_613,
      storageSpec: 4,
    });
    const staleRun = await createSharedRun(activeStale.id);

    const assessments = await assessSharedActiveRuns(pool, store);
    const staleAssessment = assessments.find((entry) => entry.runId === staleRun);
    expect(staleAssessment?.classification).toBe("managed_termination_required");
    expect(staleAssessment?.ownerRetired).toBe(true);
    expect(staleAssessment?.reasons.join(" ")).toMatch(/storage spec/);

    const result = await prepareSharedWorldCutover({
      pool,
      store,
      operationId: `cut_it_8_${suffix}`,
      maintenance: TEST_MAINTENANCE,
      quiescenceSettleMs: 50,
    });
    expect(result.holds).toEqual([]);
    for (const deployment of [idleStale, activeStale]) {
      expect(result.staged).not.toContain(deployment.id);
      expect(result.retiredDeployments).toContain(deployment.id);
      await expect(store.getDeployment(deployment.id)).resolves.toMatchObject({
        workflowTopology: { conversionState: "terminated" },
      });
    }
  }, 120_000);
});
